import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, problemDetails, uuidv7 } from '@comanda/domain';
import type { PaymentProvider } from '@comanda/payment-providers';
import { MockPaymentProvider } from '@comanda/payment-providers';
import type { Database } from '../../database/database.service';
import { OrdersService } from '../orders/orders.service';
import { KdsService } from '../kds/kds.service';
import { verifyTableToken } from './qr-token';
import { computeOrderTotals, refreshOrderTotal } from '../orders/order-state';

/**
 * Superficie pública de la Fase 3: menú, QR de mesa, takeaway, fidelización y
 * cobro con pasarela. Todo lo que acá responde va sin sesión de usuario: la
 * "credencial" es el token HMAC del QR (ver `qr-token.ts`), y el tenant se
 * resuelve con funciones SECURITY DEFINER antes de abrir contexto RLS.
 */
@Injectable()
export class StorefrontService {
  private readonly logger = new Logger('StorefrontService');

  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly orders: OrdersService,
    private readonly kds: KdsService,
    @Inject('APP_ENV')
    private readonly env: { QR_TOKEN_SECRET: string; PAYMENT_WEBHOOK_SECRET: string },
  ) {}

  // ---------------------------------------------------------------------------
  // Resolución del QR
  // ---------------------------------------------------------------------------

  /**
   * Valida el token de mesa y devuelve el contexto mínimo que necesita la app del
   * cliente. Token inválido, mesa inexistente o local inactivo responden lo mismo
   * (404 genérico): no es un oráculo de mesas válidas.
   */
  async resolveTable(venueId: string, tableId: string, token: string) {
    const org = await this.orgIdOf(venueId);
    return this.db.withTenant({ orgId: org, venueId }, async (tx) => {
      const venue = await tx.query<{
        name: string;
        currency: string;
        settings: { qrApprovalMode?: string };
        active: boolean;
      }>(`SELECT name, currency, settings, active FROM venues WHERE id = $1::uuid LIMIT 1`, [
        venueId,
      ]);
      const table = await tx.query<{ id: string; label: string; qr_token_version: number }>(
        `SELECT id, label, qr_token_version FROM tables WHERE id = $1::uuid AND venue_id = $2::uuid LIMIT 1`,
        [tableId, venueId],
      );
      const row = venue.rows[0];
      const tbl = table.rows[0];
      if (
        !row ||
        !row.active ||
        !tbl ||
        !verifyTableToken(this.env.QR_TOKEN_SECRET, venueId, tableId, tbl.qr_token_version, token)
      ) {
        throw new NotFoundException(
          problemDetails({
            status: 404,
            code: ERROR_CODES.NOT_FOUND,
            detail: 'QR inválido, vencido o de otro local.',
          }),
        );
      }
      const approvalMode =
        row.settings?.qrApprovalMode === 'WAITER' ? ('WAITER' as const) : ('AUTO' as const);
      return {
        venue: { id: venueId, name: row.name, currency: row.currency },
        table: { id: tbl.id, label: tbl.label },
        approvalMode,
      };
    });
  }

  /** Lista la carta del local: categorías + productos con foto, alérgenos y multi-idioma. */
  async menu(venueId: string, lang: string) {
    const org = await this.orgIdOf(venueId);
    return this.db.withTenant({ orgId: org, venueId }, async (tx) => {
      const categories = await tx.query<{
        id: string;
        name: string;
        name_i18n: Record<string, string>;
        sort: number;
      }>(
        `SELECT id, name, name_i18n, sort FROM categories WHERE venue_id IS NULL OR venue_id = $1::uuid ORDER BY sort, name`,
        [venueId],
      );
      const products = await tx.query<{
        id: string;
        name: string;
        description: string | null;
        name_i18n: Record<string, { name?: string }>;
        description_i18n: Record<string, { description?: string }>;
        price_cents: number;
        image_url: string | null;
        allergens: string[];
        tags: string[];
        available: boolean;
        category_id: string;
      }>(
        `SELECT p.id, p.name, p.description, p.name_i18n, p.description_i18n, p.price_cents, p.image_url,
                p.allergens, p.tags, p.available, p.category_id
           FROM products p
           JOIN categories c ON c.id = p.category_id
          WHERE c.venue_id IS NULL OR c.venue_id = $1::uuid
          ORDER BY p.sort, p.name`,
        [venueId],
      );
      return {
        lang,
        categories: categories.rows.map((c) => ({
          id: c.id,
          name: c.name_i18n?.[lang] ?? c.name,
          sort: c.sort,
        })),
        products: products.rows.map((p) => ({
          id: p.id,
          name: p.name_i18n?.[lang]?.name ?? p.name,
          description: p.description_i18n?.[lang]?.description ?? p.description,
          priceCents: p.price_cents,
          imageUrl: p.image_url,
          allergens: p.allergens,
          tags: p.tags,
          available: p.available,
          categoryId: p.category_id,
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Pedido desde la mesa
  // ---------------------------------------------------------------------------

  /** Abre (o agrega a) una comanda QR de la mesa. Idempotente con `Idempotency-Key`. */
  async openTableOrder(
    venueId: string,
    tableId: string,
    token: string,
    input: {
      guests: number;
      items: {
        productId: string;
        quantity: number;
        modifiers?: { modifierId: string }[];
        note?: string | null;
      }[];
    },
    idempotencyKey: string,
  ) {
    const resolved = await this.resolveTable(venueId, tableId, token);
    const orgId = await this.orgIdOf(venueId);
    const approvalMode = resolved.approvalMode;

    const opened = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM orders
          WHERE table_id = $1::uuid AND status IN ('OPEN','PENDIENTE_APROBACION')
          ORDER BY opened_at DESC LIMIT 1`,
        [tableId],
      );
      return existing.rows[0]?.id ?? null;
    });

    const actor = {
      userId: null,
      name: `Cliente QR (mesa ${resolved.table.label})`,
      deviceId: null,
    };

    let orderId: string;
    let replay = false;
    if (opened) {
      orderId = opened;
    } else {
      const created = await this.orders.openOrder(
        orgId,
        venueId,
        { tableId, guests: input.guests, channel: 'QR' },
        actor,
        idempotencyKey,
      );
      orderId = created.order.id;
      replay = created.replay;

      if (approvalMode === 'WAITER') {
        await this.db.withTenant({ orgId, venueId }, async (tx) => {
          await tx.query(
            `UPDATE orders SET status = 'PENDIENTE_APROBACION', updated_at = now() WHERE id = $1::uuid`,
            [orderId],
          );
        });
      }
    }

    for (const item of input.items) {
      await this.orders.addItem(
        orgId,
        venueId,
        orderId,
        {
          productId: item.productId,
          quantity: item.quantity,
          modifiers: item.modifiers ?? [],
          course: 1,
          note: item.note ?? null,
        },
        actor,
      );
    }

    if (approvalMode === 'AUTO') {
      // Sin aprobación del mozo: el pedido sale directo a cocina.
      await this.kds.ensureTicketsForOrder(orgId, venueId, orderId);
    }

    return { orderId, status: approvalMode === 'WAITER' ? 'PENDIENTE_APROBACION' : 'OPEN', replay };
  }

  /** El mozo aprueba una comanda QR pendiente: pasa a OPEN y recién ahí sale a cocina. */
  async approveOrder(orgId: string, venueId: string, orderId: string) {
    const updated = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const order = await tx.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1::uuid AND venue_id = $2::uuid FOR UPDATE`,
        [orderId, venueId],
      );
      if (order.rows.length === 0) throw new NotFoundException('Esa comanda no existe.');
      if (order.rows[0]!.status !== 'PENDIENTE_APROBACION') return false;
      await tx.query(`UPDATE orders SET status = 'OPEN', updated_at = now() WHERE id = $1::uuid`, [
        orderId,
      ]);
      return true;
    });
    if (updated) await this.kds.ensureTicketsForOrder(orgId, venueId, orderId);
    return { approved: updated };
  }

  /** La cuenta tal como la ve el cliente: ítems, totales, lo pagado. */
  async tableBill(venueId: string, tableId: string, token: string) {
    await this.resolveTable(venueId, tableId, token);
    const orgId = await this.orgIdOf(venueId);
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const open = await tx.query<{ id: string }>(
        `SELECT id FROM orders WHERE table_id = $1::uuid AND status IN ('OPEN','PENDIENTE_APROBACION','PEDIDO_CUENTA') ORDER BY opened_at DESC LIMIT 1`,
        [tableId],
      );
      const orderId = open.rows[0]?.id;
      if (!orderId) return { order: null, totals: null };
      const totals = await computeOrderTotals(tx, orderId);
      const items = await tx.query(
        `SELECT id, name_snapshot AS name, quantity, unit_price_cents AS "unitPriceCents", status
           FROM order_items WHERE order_id = $1::uuid AND status = 'ACTIVE'
          ORDER BY created_at`,
        [orderId],
      );
      return { orderId, items: items.rows, totals };
    });
  }

  // ---------------------------------------------------------------------------
  // Cobro desde la mesa
  // ---------------------------------------------------------------------------

  /** Crea el intento de cobro con el proveedor elegido. Idempotente por `source_event_id`. */
  async createCheckout(
    venueId: string,
    tableId: string,
    token: string,
    input: { provider: 'mock' | 'mercadopago' | 'stripe'; tipCents: number },
    sourceEventId: string,
  ) {
    await this.resolveTable(venueId, tableId, token);
    const orgId = await this.orgIdOf(venueId);

    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const replay = await tx.query<{ id: string; client_token: string; external_ref: string }>(
        `SELECT id, client_token, external_ref FROM payment_intents WHERE source_event_id = $1::uuid LIMIT 1`,
        [sourceEventId],
      );
      if (replay.rows[0]) {
        return {
          intentId: replay.rows[0].id,
          clientToken: replay.rows[0].client_token,
          externalRef: replay.rows[0].external_ref,
          replay: true,
        };
      }

      const open = await tx.query<{ id: string }>(
        `SELECT id FROM orders WHERE table_id = $1::uuid AND status IN ('OPEN','PENDIENTE_APROBACION','PEDIDO_CUENTA') ORDER BY opened_at DESC LIMIT 1`,
        [tableId],
      );
      const orderId = open.rows[0]?.id;
      if (!orderId) throw new NotFoundException('No hay una comanda abierta en esa mesa.');

      if (input.tipCents > 0) {
        await tx.query(
          `UPDATE orders SET tip_cents = tip_cents + $2, updated_at = now() WHERE id = $1::uuid`,
          [orderId, input.tipCents],
        );
      }
      const recalc = await computeOrderTotals(tx, orderId);
      if (recalc.remainingCents <= 0) {
        throw new NotFoundException('La comanda ya está cubierta: no queda nada por cobrar.');
      }

      const provider = this.providerFor(input.provider);
      const intentResult = await provider.createIntent({
        internalId: orderId,
        amountCents: recalc.remainingCents,
        currency: 'ARS',
        description: `Comanda mesa ${tableId.slice(0, 8)}`,
      });

      const intentId = uuidv7();
      await tx.query(
        `INSERT INTO payment_intents (id, org_id, venue_id, order_id, provider, amount_cents, currency, status, external_ref, client_token, source_event_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'ARS', 'PENDING', $7, $8, $9::uuid)`,
        [
          intentId,
          orgId,
          venueId,
          orderId,
          input.provider,
          recalc.remainingCents,
          intentResult.externalRef,
          intentResult.clientToken,
          sourceEventId,
        ],
      );
      return {
        intentId,
        clientToken: intentResult.clientToken,
        externalRef: intentResult.externalRef,
        redirectUrl: intentResult.redirectUrl,
        replay: false,
      };
    });
  }

  /** Webhook del proveedor: firma → idempotencia → pago APPROVED → total actualizado. */
  async processPaymentWebhook(
    providerKey: string,
    headers: Record<string, string | undefined>,
    rawBody: string,
  ) {
    const provider = this.providerFor(providerKey as 'mock' | 'mercadopago' | 'stripe');
    const event = provider.verifyWebhook(headers, rawBody); // lanza si la firma no cierra

    const registration = await this.db.query<{ id: string; already: boolean }>(
      `SELECT id, already FROM platform_register_webhook_event($1, $2, $3::jsonb)`,
      [providerKey, event.externalId, JSON.stringify(event.raw)],
    );
    if (registration.rows[0]?.already) return { duplicate: true };

    const found = await this.db.query<{
      org_id: string;
      venue_id: string;
      order_id: string;
      amount_cents: number;
    }>(`SELECT org_id, venue_id, order_id, amount_cents FROM platform_intent_lookup($1)`, [
      event.externalRef,
    ]);
    const row = found.rows[0];
    if (!row) {
      this.logger.warn(`webhook de ${providerKey} para intento desconocido ${event.externalRef}`);
      await this.db.query(`SELECT platform_mark_webhook_event($1::uuid, 'IGNORED')`, [
        registration.rows[0]!.id,
      ]);
      return { ignored: true };
    }

    await this.db.withTenant({ orgId: row.org_id, venueId: row.venue_id }, async (tx) => {
      if (event.status === 'APPROVED') {
        await tx.query(
          `INSERT INTO payments (id, org_id, order_id, method, amount_cents, provider, provider_ref, status, source_event_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'QR', $4, $5, $6, 'APPROVED', $7::uuid)
           ON CONFLICT (source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING`,
          [
            uuidv7(),
            row.org_id,
            row.order_id,
            row.amount_cents,
            providerKey,
            event.externalRef,
            uuidv7(),
          ],
        );
        await tx.query(
          `UPDATE payment_intents SET status = 'APPROVED', updated_at = now() WHERE order_id = $1::uuid AND external_ref = $2`,
          [row.order_id, event.externalRef],
        );
      } else {
        await tx.query(
          `UPDATE payment_intents SET status = 'FAILED', updated_at = now() WHERE order_id = $1::uuid AND external_ref = $2`,
          [row.order_id, event.externalRef],
        );
      }
      await refreshOrderTotal(tx, row.order_id);
      await tx.query(`SELECT platform_mark_webhook_event($1::uuid, 'PROCESSED')`, [
        registration.rows[0]!.id,
      ]);
    });
    return { duplicate: false };
  }

  // ---------------------------------------------------------------------------
  // Takeaway
  // ---------------------------------------------------------------------------

  /** Slots de retiro: capacidad configurable del local, ocupada por pedidos ya reservados. */
  async takeawaySlots(venueId: string, date: string) {
    const orgId = await this.orgIdOf(venueId);
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const settings = await tx.query<{
        settings: {
          takeaway?: {
            slotMinutes?: number;
            maxPerSlot?: number;
            leadMinutes?: number;
            openHour?: number;
            closeHour?: number;
          };
        };
      }>(`SELECT settings FROM venues WHERE id = $1::uuid`, [venueId]);
      const t = settings.rows[0]?.settings?.takeaway ?? {};
      const slotMinutes = t.slotMinutes ?? 15;
      const maxPerSlot = t.maxPerSlot ?? 4;
      const leadMinutes = t.leadMinutes ?? 20;
      const openHour = t.openHour ?? 9;
      const closeHour = t.closeHour ?? 23;

      const taken = await tx.query<{ pickup_at: string; count: string }>(
        `SELECT pickup_at, count(*)::text AS count FROM orders
          WHERE venue_id = $1::uuid AND channel = 'TAKEAWAY' AND status NOT IN ('CANCELLED') AND pickup_at::date = $2::date
          GROUP BY pickup_at`,
        [venueId, date],
      );
      const takenMap = new Map(
        taken.rows.map((r) => [new Date(r.pickup_at).getTime(), Number(r.count)]),
      );

      const slots: { slotAt: string; available: number }[] = [];
      const dayStart = new Date(`${date}T00:00:00`);
      const now = Date.now();
      for (let minutes = openHour * 60; minutes < closeHour * 60; minutes += slotMinutes) {
        const slotAt = new Date(dayStart.getTime() + minutes * 60_000);
        if (slotAt.getTime() < now + leadMinutes * 60_000) continue;
        const takenCount = takenMap.get(slotAt.getTime()) ?? 0;
        slots.push({
          slotAt: slotAt.toISOString(),
          available: Math.max(0, maxPerSlot - takenCount),
        });
      }
      return { slots };
    });
  }

  async createTakeawayOrder(
    venueId: string,
    input: {
      slotAt: string;
      customerName: string;
      customerPhone: string;
      items: { productId: string; quantity: number }[];
    },
    idempotencyKey: string,
  ) {
    const orgId = await this.orgIdOf(venueId);
    const slotAtDate = new Date(input.slotAt);
    if (Number.isNaN(slotAtDate.getTime())) throw new NotFoundException('Slot inválido.');

    const actor = { userId: null, name: `Cliente takeaway ${input.customerName}`, deviceId: null };
    const created = await this.orders.openOrder(
      orgId,
      venueId,
      { channel: 'TAKEAWAY', tableId: null, guests: 1 },
      actor,
      idempotencyKey,
    );
    for (const item of input.items) {
      await this.orders.addItem(
        orgId,
        venueId,
        created.order.id,
        { productId: item.productId, quantity: item.quantity, modifiers: [], course: 1 },
        actor,
      );
    }
    await this.db.withTenant({ orgId, venueId }, async (tx) => {
      await tx.query(
        `UPDATE orders SET pickup_at = $2, customer_name = $3, customer_phone = $4 WHERE id = $1::uuid`,
        [created.order.id, slotAtDate.toISOString(), input.customerName, input.customerPhone],
      );
    });
    await this.kds.ensureTicketsForOrder(orgId, venueId, created.order.id);
    return { orderId: created.order.id, status: 'OPEN', pickupAt: slotAtDate.toISOString() };
  }

  /** El cliente consulta el estado: la comanda refleja READY cuando toda la cocina terminó. */
  async takeawayStatus(orderId: string) {
    const found = await this.db.query<{ org_id: string; venue_id: string }>(
      `SELECT org_id, venue_id FROM platform_order_tenant($1::uuid)`,
      [orderId],
    );
    const tenant = found.rows[0];
    if (!tenant) throw new NotFoundException('Pedido no encontrado.');
    return this.db.withTenant({ orgId: tenant.org_id, venueId: tenant.venue_id }, async (tx) => {
      const row = await tx.query<{
        pickup_at: string;
        customer_name: string;
        status: string;
        channel: string;
      }>(`SELECT pickup_at, customer_name, status, channel FROM orders WHERE id = $1::uuid`, [
        orderId,
      ]);
      if (!row.rows[0] || row.rows[0].channel !== 'TAKEAWAY')
        throw new NotFoundException('Pedido no encontrado.');
      const tickets = await tx.query<{ status: string }>(
        `SELECT status FROM kitchen_tickets WHERE order_id = $1::uuid`,
        [orderId],
      );
      const allReady =
        tickets.rows.length > 0 &&
        tickets.rows.every((t) => t.status === 'READY' || t.status === 'SERVED');
      return {
        orderId,
        status: row.rows[0].status,
        pickupAt: row.rows[0].pickup_at,
        customerName: row.rows[0].customer_name,
        readyForPickup: allReady,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private providerFor(key: 'mock' | 'mercadopago' | 'stripe'): PaymentProvider {
    // Hasta que existan credenciales por local, el provider real de cada tenant se
    // elige igual que en fiscal-adapters: config del local → factory. Hoy: mock.
    void key;
    return new MockPaymentProvider(this.env.PAYMENT_WEBHOOK_SECRET);
  }

  private async orgIdOf(venueId: string): Promise<string> {
    const result = await this.db.query<{ org_id: string }>(
      `SELECT org_id FROM platform_venue_tenant($1::uuid)`,
      [venueId],
    );
    if (!result.rows[0]) throw new NotFoundException('Local no encontrado o inactivo.');
    return result.rows[0].org_id;
  }
}
