import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ERROR_CODES,
  billSplitSchema,
  orderSchema,
  problemDetails,
  suggestedTips,
  uuidv7,
  type BillSplit,
  type Order,
  type OrderChannel,
  type OrderItem,
  type OrderItemModifier,
  type OrderStatus,
  type Payment,
} from '@comanda/domain';
import { priceLine } from '@comanda/pricing-engine';
import { loadActiveRules } from '../promotions/rules';
import type { PoolClient } from 'pg';
import type { Database } from '../../database/database.service';
// Import de VALOR a proposito: `emitDecoratorMetadata` escribe la clase real del
// segundo argumento del constructor en `design:paramtypes`, y con `import type` la
// clase se borra en tiempo de compilacion y Nest recibe `Function`. Ver el mismo
// comentario en `sync.service.ts`.
import { AuditService } from '../audit/audit.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { computeOrderTotals, freeTable, refreshOrderTotal, resolveOpenShift } from './order-state';
import {
  DEFAULT_TIP_BASIS_POINTS,
  OPEN_STATUSES,
  type AddItemInput,
  type ListOrdersQuery,
  type OpenOrderInput,
  type OrderDetail,
  type OrderShift,
  type OrderSummary,
  type SetCourseInput,
  type SetSeatInput,
  type TipSuggestionsQuery,
  type TransferOrderInput,
  type VoidItemInput,
} from './orders.types';

/**
 * Comandas.
 *
 * Igual que en `catalog` y `tables`, ningun SELECT filtra por `org_id`: la RLS filtra
 * cada tabla y un filtro manual olvidado en uno seria una segunda copia del mismo
 * filtro. Lo que la RLS **no** cubre es el local (las policies son por organizacion), asi
 * que toda consulta que tiene el local de la sesion lo trae en el `WHERE` a proposito.
 *
 * Este modulo es el camino **online** de la comanda: autopedido por QR y mostrador con
 * red. El camino offline es el sync. Las dos rutas comparten las reglas de negocio desde
 * `order-state.ts` (`refreshOrderTotal`, `resolveOpenShift`, `freeTable`) justamente para
 * que no haya dos politicas de total ni de cierre.
 *
 * Lo que **no** se reimplementa aca es el arbitraje de mesa. Entre dos dispositivos que
 * abren la misma mesa offline gana el primer `occurred_at` del servidor, porque los dos
 * pueden tener esa mesa en su replica y ninguno puede saber que la abrio el otro. Online
 * hay un solo arbitro (esta API): alcanza con la constraint `orders_one_open_per_table` y
 * un 409 que diga que mesa esta ocupada. Copiar el desempate por reloj aca seria una
 * segunda politica de conflictos que diverge de la del sync.
 */

/** Quien hizo el cambio. La atribucion viaja al registro de auditoria. */
export interface OrderActor {
  /**
   * NULL cuando la acción la hace el cliente final (QR/takeaway/loyalty): no hay
   * usuario de la comanda, y la auditoría guarda `actor_name` como "Cliente QR (mesa N)".
   */
  userId: string | null;
  name: string;
  deviceId?: string | null;
}

// -----------------------------------------------------------------------------
// Filas crudas
// -----------------------------------------------------------------------------

interface OrderRow {
  id: string;
  venue_id: string;
  table_id: string | null;
  table_label: string | null;
  channel: OrderChannel;
  status: OrderStatus;
  number_label: string;
  opened_by: string | null;
  opened_at: Date | string;
  guests: number;
  shift_id: string | null;
  total_cents: number;
  tip_cents: number;
  note: string | null;
}

interface ItemRow {
  id: string;
  order_id: string;
  product_id: string | null;
  name_snapshot: string;
  quantity: number;
  unit_price_cents: number;
  applied_rules: unknown;
  status: 'ACTIVE' | 'VOIDED';
  course: number;
  seat: number | null;
  note: string | null;
  void_reason: string | null;
  voided_at: Date | string | null;
}

interface ModifierRow {
  order_item_id: string;
  modifier_id: string | null;
  name_snapshot: string;
  price_delta_cents: number;
}

interface PaymentRow {
  id: string;
  order_id: string;
  method: Payment['method'];
  amount_cents: number;
  tip_cents: number;
  provider: string | null;
  provider_ref: string | null;
  status: Payment['status'];
  shift_id: string | null;
  created_at: Date | string;
}

interface SplitRow {
  id: string;
  mode: BillSplit['mode'];
  allocations: unknown;
  total_cents: number;
}

/**
 * Proyeccion de la comanda.
 *
 * El `LEFT JOIN` a `tables` trae la etiqueta de la mesa en la misma fila: el listado
 * pinta "Mesa 4 - A-104" y con el numero de mesa en otra consulta un salon de veinte
 * mesas serian veinte viajes extra por refresco.
 */
const ORDER_SELECT = `
  SELECT o.id, o.venue_id, o.table_id, t.label AS table_label, o.channel, o.status,
         o.number_label, o.opened_by, o.opened_at, o.guests, o.shift_id, o.total_cents,
         o.tip_cents, o.note
    FROM orders o
    LEFT JOIN tables t ON t.id = o.table_id
`;

@Injectable()
export class OrdersService {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly audit: AuditService,
    private readonly loyalty?: LoyaltyService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lectura
  // ---------------------------------------------------------------------------

  /**
   * Comandas del local, con items, modificadores y pagos ya agregados.
   *
   * Tres consultas y un agrupado en memoria, no un `json_agg` por comanda: el POS ya
   * sabe reconstruir la pantalla con las tres listas, y un `jsonb` por fila habria que
   * re-parsear en cada cliente. El agrupado usa `Map` para que no sea cuadratico con
   * muchas comandas.
   *
   * Los tres vienen juntos a proposito: pintar un ticket con N+1 es un ticket que se ve
   * parpadeando mientras el mozo le explica el total al cliente.
   */
  async listOrders(
    orgId: string,
    venueId: string,
    filter: ListOrdersQuery,
  ): Promise<OrderSummary[]> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const conditions = ['o.venue_id = $1::uuid'];
      const params: unknown[] = [venueId];

      if (filter.status && filter.status.length > 0) {
        params.push(filter.status);
        conditions.push(`o.status = ANY($${params.length}::varchar[])`);
      }
      if (filter.tableId !== undefined) {
        params.push(filter.tableId);
        conditions.push(`o.table_id = $${params.length}::uuid`);
      }
      if (filter.shiftId !== undefined) {
        params.push(filter.shiftId);
        conditions.push(`o.shift_id = $${params.length}::uuid`);
      }

      params.push(filter.limit, filter.offset);

      const orders = await tx.query<OrderRow>(
        `${ORDER_SELECT}
          WHERE ${conditions.join(' AND ')}
          ORDER BY o.opened_at DESC, o.id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      if (orders.rows.length === 0) return [];

      const orderIds = orders.rows.map((row) => row.id);
      // Los modificadores no se piden por separado: `itemsOf` ya los trae agrupados por
      // item, y pedirlos dos veces seria la misma consulta dos veces.
      const [items, payments] = await Promise.all([
        itemsOf(tx, orderIds),
        paymentsOf(tx, orderIds),
      ]);

      return orders.rows.map((row) =>
        toSummary(row, items.get(row.id) ?? [], payments.get(row.id) ?? []),
      );
    });
  }

  /**
   * Una comanda con todo: items, modificadores, pagos, reparto y turno.
   *
   * Se arma con las mismas piezas del listado y no con una consulta distinta: dos
   * proyecciones del mismo dato divergen, y la divergencia aparece como "el listado dice
   * $12000 y la cuenta $11800" en la misma pantalla.
   */
  async orderDetail(orgId: string, venueId: string, orderId: string): Promise<OrderDetail> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const [row, items, payments, splits, shift, totals] = await Promise.all([
        orderRow(tx, orderId, venueId),
        itemsOf(tx, [orderId]),
        paymentsOf(tx, [orderId]),
        splitsOf(tx, orderId),
        shiftOf(tx, venueId),
        computeOrderTotals(tx, orderId),
      ]);

      const order = toOrder(row, items.get(orderId) ?? []);
      const paidCents = (payments.get(orderId) ?? []).reduce((acc, p) => acc + p.amountCents, 0);

      return {
        order,
        note: row.note,
        totals: { ...totals, paidCents, remainingCents: totals.totalCents - paidCents },
        payments: payments.get(orderId) ?? [],
        splits,
        shift,
      };
    });
  }

  /**
   * El turno abierto del local, o `null`.
   *
   * `cash.service.ts` tambien lo expone porque es su dueno natural. Se reimplementa aca
   * para que la pantalla de cobro no tenga que conocer el modulo de caja: necesita el
   * turno (todo pago exige caja abierta) y no necesita nada mas de la caja. Es la
   * lectura de una fila de estado: duplicarla es mas barato que acoplar dos modulos por
   * un id.
   */
  async currentShift(orgId: string, venueId: string): Promise<OrderShift | null> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => shiftOf(tx, venueId));
  }

  /**
   * Propinas sugeridas para la cuenta.
   *
   * Los porcentajes los elige el local y llegan en basis points, nunca en float: un 10%
   * de $33.33 son $3.33. El redondeo a centavos lo hace `suggestedTips()` del dominio,
   * el mismo que corre el POS offline: si el servidor redondeara distinto, la pantalla y
   * el cobro darian un centavo de diferencia.
   */
  async tipSuggestions(
    orgId: string,
    venueId: string,
    orderId: string,
    query: TipSuggestionsQuery,
  ): Promise<{ basisPoints: number[]; amountsCents: number[] }> {
    const basisPoints = parseBasisPoints(query.bps);

    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const totals = await computeOrderTotals(tx, orderId);
      return {
        basisPoints,
        amountsCents: suggestedTips(totals.totalCents, basisPoints).map((tip) => tip.cents),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Apertura y carga
  // ---------------------------------------------------------------------------

  /**
   * Abre una comanda online.
   *
   * La mesa se valida antes del `INSERT` por dos motivos concretos. Uno es la constraint
   * `orders_one_open_per_table`, que es la garantia real: si la mesa ya tiene comanda
   * abierta, el `INSERT` revienta y el error viene de Postgres. El otro es el mensaje: un
   * 409 que dice "la mesa 4 ya tiene una comanda abierta" es accion para el mozo, y
   * "duplicate key value violates unique constraint" no lo es.
   *
   * `numberLabel` se genera en el servidor cuando no viene, y **no es un correlativo**: es
   * un fragmento del id. Es la misma regla que el modo offline (`device_prefix-seq`),
   * donde dos tablets pueden mostrar el mismo numero a proposito; el identificador real
   * es el UUID y el POS resuelve los choques con el.
   *
   * Con `Idempotency-Key` el reenvio devuelve la comanda que ya se abrio en vez de abrir
   * otra. Va en `orders.source_event_id`, que tiene indice unico parcial justamente para
   * esto: sin el, un cliente que reintenta por timeout abre dos mesas para la misma
   * persona, y las comandas fantasma se descubren en el arqueo del turno.
   */
  async openOrder(
    orgId: string,
    venueId: string,
    input: OpenOrderInput,
    actor: OrderActor,
    idempotencyKey?: string,
  ): Promise<{ order: Order; replay: boolean }> {
    const orderId = uuidv7();

    const opened = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      // El reenvio se resuelve **antes** de mirar la mesa. Al reves, el segundo request
      // del mismo `Idempotency-Key` encontraria la mesa ocupada por la comanda que el
      // primero acaba de abrir y responderia 409: el reintento despues de un timeout
      // devolveria un error en vez de la comanda, que es justo cuando no se puede ver la
      // pantalla para descubrir que si se guardo.
      if (idempotencyKey) {
        const previous = await tx.query<{ id: string }>(
          `SELECT id FROM orders WHERE source_event_id = $1::uuid AND venue_id = $2::uuid`,
          [idempotencyKey, venueId],
        );
        const found = previous.rows[0];
        if (found)
          return { order: toOrder(await orderRow(tx, found.id, venueId), []), replay: true };
      }

      if (input.tableId) await assertTableIsFree(tx, venueId, input.tableId);

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO orders
           (id, org_id, venue_id, table_id, channel, status, number_label, opened_by,
            guests, source_event_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'OPEN', $6, $7::uuid, $8, $9::uuid)
         ON CONFLICT (source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          orderId,
          orgId,
          venueId,
          input.tableId ?? null,
          input.channel,
          input.numberLabel ?? generatedNumberLabel(orderId),
          actor.userId,
          input.guests,
          idempotencyKey ?? null,
        ],
      );

      // La preconsulta de arriba no alcanza sola: dos requests con la misma clave pueden
      // pasar las dos antes de que ninguno inserte. El indice unico parcial es el que
      // decide, y el que pierde devuelve la comanda del otro.
      if (inserted.rows.length === 0) {
        const winner = await tx.query<{ id: string }>(
          `SELECT id FROM orders WHERE source_event_id = $1::uuid AND venue_id = $2::uuid`,
          [idempotencyKey, venueId],
        );
        const found = winner.rows[0];
        if (!found) {
          throw new ConflictException(
            problemDetails({
              status: 409,
              code: ERROR_CODES.CONFLICT,
              detail: 'Esa clave de idempotencia ya se usó en otro local.',
            }),
          );
        }
        return { order: toOrder(await orderRow(tx, found.id, venueId), []), replay: true };
      }

      if (input.tableId) await occupyTable(tx, input.tableId, orderId);

      return { order: toOrder(await orderRow(tx, orderId, venueId), []), replay: false };
    });

    if (opened.replay) return opened;

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'order.opened',
      entity: 'order',
      entityId: opened.order.id,
      after: {
        tableId: opened.order.tableId,
        channel: opened.order.channel,
        guests: opened.order.guests,
        numberLabel: opened.order.numberLabel,
      },
    });

    return opened;
  }

  /**
   * Agrega un item con modificadores.
   *
   * **El precio lo calcula el servidor.** El cuerpo no acepta `unitPriceCents`: si lo
   * aceptara, el endpoint seria un `INSERT` con el importe que el cliente quiera y
   * bastaria un `curl` para cargar una comanda de $1. El precio sale del catalogo
   * (`products.price_cents`), pasa por el motor de promociones y se guarda como snapshot
   * en `unit_price_cents`, con la lista en `list_price_cents` y las reglas aplicadas en
   * `applied_rules`.
   *
   * Los modificadores tampoco aceptan el precio: el cliente manda el `modifierId` y el
   * servidor busca el nombre y el delta en el catalogo. Es la misma defensa sobre el
   * mismo campo.
   */
  async addItem(
    orgId: string,
    venueId: string,
    orderId: string,
    input: AddItemInput,
    actor: OrderActor,
  ): Promise<OrderDetail> {
    const added = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      await lockOpenOrder(tx, venueId, orderId);

      const product = await tx.query<{
        id: string;
        name: string;
        price_cents: number;
        available: boolean;
        category_id: string;
      }>(
        `SELECT p.id, p.name, p.price_cents, p.available, p.category_id
           FROM products p
           JOIN categories c ON c.id = p.category_id
          WHERE p.id = $1::uuid AND (c.venue_id IS NULL OR c.venue_id = $2::uuid)`,
        [input.productId, venueId],
      );

      const row = product.rows[0];
      if (!row) throw notFound('Ese producto no existe en este local.');
      if (!row.available) {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: `“${row.name}” no está disponible: no se puede agregar a la comanda.`,
          }),
        );
      }

      const modifiers = await resolveModifiers(
        tx,
        input.modifiers.map((m) => m.modifierId),
      );
      const venue = await venuePricingContext(tx, venueId);

      const priced = priceLine(
        {
          lineId: uuidv7(),
          productId: row.id,
          categoryId: row.category_id,
          quantity: input.quantity,
          unitPriceCents: row.price_cents,
          currency: venue.currency,
        },
        { now: Date.now(), timezone: venue.timezone, currency: venue.currency },
        await loadActiveRules(tx, venueId),
      );

      const itemId = uuidv7();
      await tx.query(
        `INSERT INTO order_items
           (id, org_id, order_id, product_id, name_snapshot, quantity, unit_price_cents,
            list_price_cents, applied_rules, course, seat, note, added_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::uuid)`,
        [
          itemId,
          orgId,
          orderId,
          row.id,
          row.name,
          input.quantity,
          priced.unitPriceCents,
          row.price_cents,
          JSON.stringify(priced.applied),
          input.course,
          input.seat ?? null,
          input.note ?? null,
          actor.userId,
        ],
      );

      for (const [index, modifier] of modifiers.entries()) {
        await tx.query(
          `INSERT INTO order_item_modifiers
             (org_id, order_item_id, modifier_id, name_snapshot, price_delta_cents, sort)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
          [orgId, itemId, modifier.modifierId, modifier.name, modifier.priceDeltaCents, index],
        );
      }

      await refreshOrderTotal(tx, orderId);

      return { itemId, productName: row.name, unitPriceCents: priced.unitPriceCents };
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'order.item_added',
      entity: 'order_item',
      entityId: added.itemId,
      after: {
        orderId,
        product: added.productName,
        quantity: input.quantity,
        // El precio que se guardo, no el que pidio el cliente: es el unico que existe.
        unitPriceCents: added.unitPriceCents,
      },
    });

    return this.orderDetail(orgId, venueId, orderId);
  }

  /**
   * Anula un item.
   *
   * No existe el borrado: anular deja el item, el motivo, quien y cuando. Es lo que
   * permite responder "cuanto se desconto por anulaciones" con un filtro, y es lo que
   * exige la constraint `order_items_void_consistent`.
   *
   * Es una accion sensible (PLAN §4.7): va al registro de auditoria con el importe que
   * dejo de cobrarse. Ese importe incluye los modificadores y no solo el precio de
   * lista, porque anular un "capuchino doble con leche de almendras" devuelve el doble. Si
   * se auditara solo la base, la suma de anulaciones no cerraria con el total de
   * descuentos que el turno muestra, y el descuadre se discoveria en el arqueo, que es
   * el peor momento.
   */
  async voidItem(
    orgId: string,
    venueId: string,
    itemId: string,
    input: VoidItemInput,
    actor: OrderActor,
  ): Promise<OrderDetail> {
    const voided = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const found = await tx.query<{ order_id: string; status: string }>(
        `SELECT order_id, status FROM order_items WHERE id = $1::uuid FOR UPDATE`,
        [itemId],
      );

      const item = found.rows[0];
      if (!item) throw notFound('Ese ítem no existe.');
      if (item.status === 'VOIDED') {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'Ese ítem ya estaba anulado.',
          }),
        );
      }

      const orderId = item.order_id;
      // La comanda se valida por local y por estado con la misma funcion que el resto de
      // las escrituras: anular sobre una comanda de otro local tiene que ser un 404, y
      // anular sobre una comanda cerrada un 409.
      await lockOpenOrder(tx, venueId, orderId);

      const result = await tx.query<{
        name_snapshot: string;
        quantity: number;
        unit_price_cents: number;
        delta: string | null;
      }>(
        `UPDATE order_items
            SET status = 'VOIDED', void_reason = $2, voided_by = $3::uuid,
                voided_at = now(), updated_at = now()
          WHERE id = $1::uuid AND status = 'ACTIVE'
        RETURNING name_snapshot, quantity, unit_price_cents,
                  (SELECT SUM(price_delta_cents)::text
                     FROM order_item_modifiers
                    WHERE order_item_id = order_items.id) AS delta`,
        [itemId, input.reason, actor.userId],
      );

      await refreshOrderTotal(tx, orderId);

      const row = result.rows[0]!;
      return {
        orderId,
        name: row.name_snapshot,
        quantity: row.quantity,
        removedCents: (row.unit_price_cents + Number(row.delta ?? 0)) * row.quantity,
      };
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'order.item_voided',
      entity: 'order_item',
      entityId: itemId,
      after: {
        orderId: voided.orderId,
        name: voided.name,
        quantity: voided.quantity,
        removedCents: voided.removedCents,
      },
      reason: input.reason,
    });

    return this.orderDetail(orgId, venueId, voided.orderId);
  }

  // ---------------------------------------------------------------------------
  // Datos de la comanda
  // ---------------------------------------------------------------------------

  /** Nota de la comanda. Se sobreescribe: no es un historial. */
  async addNote(
    orgId: string,
    venueId: string,
    orderId: string,
    note: string | null,
    actor: OrderActor,
  ): Promise<OrderDetail> {
    await this.db.withTenant({ orgId, venueId }, async (tx) => {
      await lockOpenOrder(tx, venueId, orderId);
      await tx.query(
        `UPDATE orders SET note = $3, updated_at = now()
          WHERE id = $1::uuid AND venue_id = $2::uuid`,
        [orderId, venueId, note],
      );
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'order.item_updated',
      entity: 'order',
      entityId: orderId,
      after: { note },
    });

    return this.orderDetail(orgId, venueId, orderId);
  }

  /**
   * Asigna items a un curso.
   *
   * "Mantener y disparar" en un bar se implementa asi: el mozo marca los items de entrada
   * como curso 1 y los de principal como curso 2, y la cocina ve primero los de entrada.
   */
  async setCourse(
    orgId: string,
    venueId: string,
    orderId: string,
    input: SetCourseInput,
    actor: OrderActor,
  ): Promise<{ updated: number }> {
    const updated = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      await lockOpenOrder(tx, venueId, orderId);
      const result = await tx.query(
        `UPDATE order_items SET course = $3, updated_at = now()
          WHERE id = ANY($2::uuid[]) AND order_id = $1::uuid`,
        [orderId, input.itemIds, input.course],
      );

      if (result.rowCount === 0) throw notFound('Ninguno de esos ítems es de esta comanda.');
      return result.rowCount ?? 0;
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'order.item_updated',
      entity: 'order',
      entityId: orderId,
      after: { course: input.course, items: input.itemIds.length },
    });

    return { updated };
  }

  /**
   * Asigna items a un comensal (asiento).
   *
   * Es lo que hace posible dividir la cuenta por persona: sin `seat`, el reparto por
   * asiento no tiene con que trabajar.
   */
  async setSeat(
    orgId: string,
    venueId: string,
    orderId: string,
    input: SetSeatInput,
    actor: OrderActor,
  ): Promise<{ updated: number }> {
    const updated = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      await lockOpenOrder(tx, venueId, orderId);
      const result = await tx.query(
        `UPDATE order_items SET seat = $3, updated_at = now()
          WHERE id = ANY($2::uuid[]) AND order_id = $1::uuid`,
        [orderId, input.itemIds, input.seat ?? null],
      );

      if (result.rowCount === 0) throw notFound('Ninguno de esos ítems es de esta comanda.');
      return result.rowCount ?? 0;
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'order.item_updated',
      entity: 'order',
      entityId: orderId,
      after: { seat: input.seat ?? null, items: input.itemIds.length },
    });

    return { updated };
  }

  // ---------------------------------------------------------------------------
  // Cierre, transferencia y union
  // ---------------------------------------------------------------------------

  /**
   * Cierra la comanda y libera la mesa.
   *
   * El turno se resuelve en el servidor y no se exige en el body: `orders_closed_consistent`
   * pide `shift_id NOT NULL` al cerrar, y sin resolverlo el `UPDATE` reventa la constraint
   * y **la mesa queda ocupada para siempre** con el cobro ya hecho. El mensaje es el del
   * sync, literal, porque es el mismo problema y el mismo texto le sirve al mismo
   * operador.
   *
   * Cerrar **no** exige que la cuenta este pagada. Cerrar sin cobrar es una decision del
   * mozo (una mesa que se va, una cortesia) y el arqueo del turno muestra la diferencia;
   * lo que no se permite es cerrar sin caja abierta, porque ese cobro no pertenece a
   * ningun turno y no aparece en ningun conteo.
   *
   * Por que no se emite un evento de servidor para que otras tablets lo vean: el catalogo
   * de `sync_events` no tiene un tipo "el servidor cambio esto" para una comanda, y
   * `sync_events.device_id` es `NOT NULL`. Una accion online puede venir sin dispositivo
   * (login por contrasena) y no hay a quien atribuírsela. Inventar un tipo nuevo o dejar
   * la columna nullable para acomodar este endpoint es peor que la conciliacion que hace
   * el POS cuando vuelve a sincronizar.
   */
  async closeOrder(
    orgId: string,
    venueId: string,
    orderId: string,
    actor: OrderActor,
  ): Promise<OrderDetail> {
    await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const shiftId = await resolveOpenShift(tx, venueId);
      if (!shiftId) throw noOpenShift('cerrar la comanda');

      await closeOrderRow(tx, venueId, orderId, shiftId, actor.deviceId ?? null);
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'order.closed',
      entity: 'order',
      entityId: orderId,
      after: { status: 'CLOSED' },
    });

    // Acreditación de puntos: la venta quedó, así que el asiento tiene que existir
    // aunque acá falle. No bloquea el cierre: se registra y se sigue.
    await this.loyalty?.accrueForOrder(orderId).catch(() => undefined);

    return this.orderDetail(orgId, venueId, orderId);
  }

  /**
   * Mueve la comanda a otra mesa.
   *
   * La mesa destino se valida antes de tocar nada: si esta ocupada, reservada o bloqueada,
   * el error tiene que llegar **antes** de liberar la mesa de origen. Al reves, el fallo
   * dejaria la comanda sin mesa y la de origen libre: la mesa desaparece del mapa con la
   * comanda todavia cobrandose.
   */
  async transferOrder(
    orgId: string,
    venueId: string,
    orderId: string,
    input: TransferOrderInput,
    actor: OrderActor,
  ): Promise<OrderDetail> {
    const moved = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const order = await lockOpenOrder(tx, venueId, orderId);

      if (order.table_id === input.toTableId) {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'La comanda ya está en esa mesa.',
          }),
        );
      }

      await assertTableIsFree(tx, venueId, input.toTableId);

      await tx.query(
        `UPDATE orders SET table_id = $3::uuid, updated_at = now()
          WHERE id = $1::uuid AND venue_id = $2::uuid`,
        [orderId, venueId, input.toTableId],
      );

      if (order.table_id) await freeTable(tx, order.table_id);
      await occupyTable(tx, input.toTableId, orderId);

      return { fromTableId: order.table_id, toTableId: input.toTableId };
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'order.transferred',
      entity: 'order',
      entityId: orderId,
      before: { tableId: moved.fromTableId },
      after: { tableId: moved.toTableId },
    });

    return this.orderDetail(orgId, venueId, orderId);
  }

  /**
   * Une dos comandas en una.
   *
   * Sobrevive la comanda destino: es la que tiene la mesa y la que el mozo tiene en
   * pantalla. La de origen queda `CLOSED` con su turno, porque `orders_closed_consistent`
   * no permite cerrar sin turno; por eso la union necesita caja abierta y por eso el
   * mensaje es el mismo que el del cierre.
   *
   * Items, pagos y mesa viajan al destino. El reparto **no** viaja: sus partes suman el
   * total de la comanda que se disuelve, y un reparto guardado que ya no suma el total
   * nuevo es peor que no tener reparto, porque la pantalla muestra un descuadre que nadie
   * sabe de donde salio.
   */
  async mergeOrders(
    orgId: string,
    venueId: string,
    orderId: string,
    intoOrderId: string,
    actor: OrderActor,
  ): Promise<OrderDetail> {
    if (orderId === intoOrderId) {
      throw new BadRequestException(
        problemDetails({
          status: 400,
          code: ERROR_CODES.VALIDATION_FAILED,
          detail: 'Una comanda no se puede unir con sí misma.',
        }),
      );
    }

    const merged = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const shiftId = await resolveOpenShift(tx, venueId);
      if (!shiftId) throw noOpenShift('unir comandas');

      const from = await lockOpenOrder(tx, venueId, orderId);
      const into = await lockOpenOrder(tx, venueId, intoOrderId);

      const items = await tx.query(
        `UPDATE order_items SET order_id = $2::uuid, updated_at = now()
          WHERE order_id = $1::uuid RETURNING id`,
        [orderId, intoOrderId],
      );
      const payments = await tx.query(
        `UPDATE payments SET order_id = $2::uuid, updated_at = now()
          WHERE order_id = $1::uuid RETURNING id`,
        [orderId, intoOrderId],
      );

      await tx.query(`DELETE FROM bill_splits WHERE order_id = $1::uuid`, [orderId]);

      // La comanda de origen se cierra con turno y libera su mesa: si no, el salon queda
      // con dos comandas sobre la misma mesa y `orders_one_open_per_table` bloquea la
      // proxima apertura de esa mesa para siempre.
      await closeOrderRow(tx, venueId, orderId, shiftId, actor.deviceId ?? null);

      await refreshOrderTotal(tx, intoOrderId);

      return {
        items: items.rowCount,
        payments: payments.rowCount,
        tableId: into.table_id,
        fromTotalCents: from.total_cents,
      };
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'order.merged',
      entity: 'order',
      entityId: intoOrderId,
      before: { fromOrderId: orderId, fromTotalCents: merged.fromTotalCents },
      after: { items: merged.items, payments: merged.payments, tableId: merged.tableId },
    });

    return this.orderDetail(orgId, venueId, intoOrderId);
  }
}

// -----------------------------------------------------------------------------
// Consultas agregadas y utilidades de estado
// -----------------------------------------------------------------------------

/**
 * Items de varias comandas en una sola consulta.
 *
 * El `id = ANY($1::uuid[])` es lo que evita el N+1 del listado. El `Map` evita el
 * cuadratico: en un salon con veinte mesas abiertas, veinte `find` por item son cuatro
 *cientas comparaciones por respuesta, que es la diferencia entre pintar el mapa y que se
 * note.
 */
async function itemsOf(
  tx: PoolClient,
  orderIds: readonly string[],
): Promise<Map<string, OrderItem[]>> {
  const byOrder = new Map<string, OrderItem[]>();
  if (orderIds.length === 0) return byOrder;

  const modifiers = await modifiersOf(tx, orderIds);

  // `created_at` y no `course`: el ticket imprime en el orden en que se pidio. El curso
  // agrupa en la pantalla de cocina, que es otra consulta.
  const result = await tx.query<ItemRow>(
    `SELECT id, order_id, product_id, name_snapshot, quantity, unit_price_cents,
            applied_rules, status, course, seat, note, void_reason, voided_at
       FROM order_items
      WHERE order_id = ANY($1::uuid[])
      ORDER BY created_at, id`,
    [orderIds],
  );

  for (const row of result.rows) {
    const item: OrderItem = {
      id: row.id,
      orderId: row.order_id,
      productId: row.product_id,
      nameSnapshot: row.name_snapshot,
      quantity: row.quantity,
      unitPriceCents: row.unit_price_cents,
      appliedRules: (row.applied_rules ?? []) as unknown[],
      status: row.status,
      course: row.course,
      seat: row.seat,
      note: row.note,
      modifiers: modifiers.get(row.id) ?? [],
      voidReason: row.void_reason,
      voidedAt: row.voided_at ? new Date(row.voided_at).toISOString() : null,
    };

    const bucket = byOrder.get(row.order_id);
    if (bucket) bucket.push(item);
    else byOrder.set(row.order_id, [item]);
  }

  return byOrder;
}

/** Modificadores de los items de varias comandas, agrupados por item. */
async function modifiersOf(
  tx: PoolClient,
  orderIds: readonly string[],
): Promise<Map<string, OrderItemModifier[]>> {
  const byItem = new Map<string, OrderItemModifier[]>();
  if (orderIds.length === 0) return byItem;

  const result = await tx.query<ModifierRow>(
    `SELECT m.order_item_id, m.modifier_id, m.name_snapshot, m.price_delta_cents
       FROM order_item_modifiers m
       JOIN order_items oi ON oi.id = m.order_item_id
      WHERE oi.order_id = ANY($1::uuid[])
      ORDER BY m.order_item_id, m.sort, m.id`,
    [orderIds],
  );

  for (const row of result.rows) {
    const modifier: OrderItemModifier = {
      modifierId: row.modifier_id,
      name: row.name_snapshot,
      priceDeltaCents: row.price_delta_cents,
    };

    const bucket = byItem.get(row.order_item_id);
    if (bucket) bucket.push(modifier);
    else byItem.set(row.order_item_id, [modifier]);
  }

  return byItem;
}

/** Pagos aprobados de varias comandas: un `FAILED` o `REFUNDED` no es un cobro. */
async function paymentsOf(
  tx: PoolClient,
  orderIds: readonly string[],
): Promise<Map<string, Payment[]>> {
  const byOrder = new Map<string, Payment[]>();
  if (orderIds.length === 0) return byOrder;

  const result = await tx.query<PaymentRow>(
    `SELECT id, order_id, method, amount_cents, tip_cents, provider, provider_ref,
            status, shift_id, created_at
       FROM payments
      WHERE order_id = ANY($1::uuid[]) AND status = 'APPROVED'
      ORDER BY created_at, id`,
    [orderIds],
  );

  for (const row of result.rows) {
    const bucket = byOrder.get(row.order_id);
    if (bucket) bucket.push(toPayment(row));
    else byOrder.set(row.order_id, [toPayment(row)]);
  }

  return byOrder;
}

/** Repartos guardados de una comanda, del mas reciente al mas viejo. */
async function splitsOf(tx: PoolClient, orderId: string): Promise<BillSplit[]> {
  const result = await tx.query<SplitRow>(
    `SELECT id, mode, allocations, total_cents
       FROM bill_splits
      WHERE order_id = $1::uuid
      ORDER BY created_at DESC`,
    [orderId],
  );

  // Se parsea con el esquema del dominio: el reparto se muestra en la pantalla de cuenta
  // y una fila con una forma inesperada ahi es un error de formato que tiene que aparecer
  // aca y no en el mostrador.
  return result.rows.map((row) =>
    billSplitSchema.parse({
      id: row.id,
      orderId,
      mode: row.mode,
      allocations: row.allocations,
      totalCents: row.total_cents,
    }),
  );
}

/** Turno abierto del local, proyectado sin esperado ni diferencia (arqueo ciego). */
async function shiftOf(tx: PoolClient, venueId: string): Promise<OrderShift | null> {
  const result = await tx.query<{
    id: string;
    venue_id: string;
    opened_at: Date | string;
    opening_float_cents: number;
    status: 'OPEN' | 'CLOSED';
  }>(
    `SELECT id, venue_id, opened_at, opening_float_cents, status
       FROM shifts
      WHERE venue_id = $1::uuid AND status = 'OPEN'
      LIMIT 1`,
    [venueId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    venueId: row.venue_id,
    openedAt: new Date(row.opened_at).toISOString(),
    openingFloatCents: row.opening_float_cents,
    status: row.status,
  };
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.order_id,
    method: row.method,
    amountCents: row.amount_cents,
    tipCents: row.tip_cents,
    provider: row.provider,
    providerRef: row.provider_ref,
    status: row.status,
    shiftId: row.shift_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toOrder(row: OrderRow, items: OrderItem[]): Order {
  // Se valida con el esquema del dominio en vez de castear a mano: el POS consume
  // exactamente esta forma, y una fila que no entre en el esquema tiene que fallar aca y
  // no en el mostrador del bar.
  return orderSchema.parse({
    id: row.id,
    venueId: row.venue_id,
    tableId: row.table_id,
    tableLabel: row.table_label,
    channel: row.channel,
    status: row.status,
    numberLabel: row.number_label,
    openedBy: row.opened_by,
    openedAt: new Date(row.opened_at).toISOString(),
    guests: row.guests,
    shiftId: row.shift_id,
    totalCents: row.total_cents,
    tipCents: row.tip_cents,
    items,
  });
}

function toSummary(row: OrderRow, items: OrderItem[], payments: Payment[]): OrderSummary {
  const order = toOrder(row, items);
  const paidCents = payments.reduce((acc, payment) => acc + payment.amountCents, 0);
  return {
    ...order,
    note: row.note,
    paidCents,
    remainingCents: order.totalCents - paidCents,
    payments,
  };
}

/** Fila de la comanda del local. `null` si no existe o si es de otro local. */
async function orderRow(tx: PoolClient, orderId: string, venueId: string): Promise<OrderRow> {
  const found = await tx.query<OrderRow>(
    `${ORDER_SELECT} WHERE o.id = $1::uuid AND o.venue_id = $2::uuid`,
    [orderId, venueId],
  );

  const row = found.rows[0];
  if (!row) throw notFound('Esa comanda no existe en este local.');
  return row;
}

/**
 * Comanda abierta del local, con la fila bloqueada.
 *
 * El bloqueo va en el servicio y no solo en la transaccion porque la comanda se escribe
 * desde varios caminos a la vez (un item online y un cobro del POS): sin el, dos
 * escrituras sobre `total_cents` dejan el promedio de dos estados que nunca existieron.
 */
async function lockOpenOrder(tx: PoolClient, venueId: string, orderId: string): Promise<OrderRow> {
  const found = await tx.query<OrderRow>(
    `${ORDER_SELECT} WHERE o.id = $1::uuid AND o.venue_id = $2::uuid FOR UPDATE OF o`,
    [orderId, venueId],
  );

  const row = found.rows[0];
  if (!row) throw notFound('Esa comanda no existe en este local.');

  if (!OPEN_STATUSES.includes(row.status as (typeof OPEN_STATUSES)[number])) {
    throw new ConflictException(
      problemDetails({
        status: 409,
        code: ERROR_CODES.CONFLICT,
        detail: `La comanda ${row.number_label} está ${describeStatus(row.status)}: ya no admite cambios.`,
      }),
    );
  }

  return row;
}

/** Cierra la comanda y libera su mesa. Reusa la constraint en vez de duplicarla. */
async function closeOrderRow(
  tx: PoolClient,
  venueId: string,
  orderId: string,
  shiftId: string,
  deviceId: string | null,
): Promise<string | null> {
  const closed = await tx.query<{ table_id: string | null }>(
    `UPDATE orders
        SET status = 'CLOSED', closed_at = now(), shift_id = $3::uuid,
            source_device_id = $4::uuid, updated_at = now()
      WHERE id = $1::uuid AND venue_id = $2::uuid AND status NOT IN ('CLOSED','CANCELLED')
    RETURNING table_id`,
    [orderId, venueId, shiftId, deviceId],
  );

  if (closed.rows.length === 0) {
    throw new ConflictException(
      problemDetails({
        status: 409,
        code: ERROR_CODES.CONFLICT,
        detail: 'La comanda ya estaba cerrada.',
      }),
    );
  }

  const tableId = closed.rows[0]!.table_id;
  if (tableId) await freeTable(tx, tableId);
  return tableId;
}

/**
 * La mesa tiene que estar libre y servible.
 *
 * `RESERVADA` y `BLOQUEADA` tambien se rechazan: abrir una comanda sobre una mesa
 * reservada le avisa al cliente que la mesa es suya y tira el nombre del cliente con el
 * error.
 */
async function assertTableIsFree(tx: PoolClient, venueId: string, tableId: string): Promise<void> {
  const found = await tx.query<{ label: string; status: string }>(
    `SELECT label, status FROM tables WHERE id = $1::uuid AND venue_id = $2::uuid`,
    [tableId, venueId],
  );

  const row = found.rows[0];
  if (!row) throw notFound('Esa mesa no existe en este local.');

  if (row.status !== 'LIBRE') {
    throw new ConflictException(
      problemDetails({
        status: 409,
        code: ERROR_CODES.CONFLICT,
        detail:
          row.status === 'RESERVADA' || row.status === 'BLOQUEADA'
            ? `La mesa ${row.label} está ${describeTableStatus(row.status)}.`
            : `La mesa ${row.label} ya tiene una comanda abierta.`,
      }),
    );
  }
}

/**
 * Ocupa la mesa.
 *
 * Los tres campos se escriben juntos porque `tables_occupied_consistent` exige que una mesa
 * ocupada tenga orden y momento de ocupacion: escribirlos por partes deja un estado
 * intermedio que la constraint rechaza y que el POS ve como "mesa ocupada sin comanda",
 * que es el peor estado posible del mapa.
 */
async function occupyTable(tx: PoolClient, tableId: string, orderId: string): Promise<void> {
  await tx.query(
    `UPDATE tables
        SET status = 'OCUPADA', order_id = $2::uuid, occupied_since = now(), updated_at = now()
      WHERE id = $1::uuid`,
    [tableId, orderId],
  );
}

// -----------------------------------------------------------------------------
// Precios
// -----------------------------------------------------------------------------

/** Moneda y zona horaria del local: el contexto que el motor de promociones exige. */
async function venuePricingContext(
  tx: PoolClient,
  venueId: string,
): Promise<{ currency: string; timezone: string }> {
  const result = await tx.query<{ currency: string; timezone: string }>(
    `SELECT currency, timezone FROM venues WHERE id = $1::uuid`,
    [venueId],
  );
  const row = result.rows[0];
  // Sin local no hay comanda (la FK ya lo garantizo). El fallback existe para que el motor
  // no reciba `undefined` en una llamada que deberia ser imposible, no para disimular una
  // consulta fallida.
  return row ?? { currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires' };
}

/**
 * Modificadores elegidos: nombre y precio los pone el servidor.
 *
 * Faltante y no vacio a proposito. Un `modifierId` que el cliente mando y el catalogo no
 * tiene es un dato viejo (el dueno modifico la carta) o un error del cliente, y en los
 * dos casos seguir sin ese modificador cobra un importe que el mozo no eligio.
 */
async function resolveModifiers(
  tx: PoolClient,
  modifierIds: readonly string[],
): Promise<Array<{ modifierId: string; name: string; priceDeltaCents: number }>> {
  if (modifierIds.length === 0) return [];

  const result = await tx.query<{ id: string; name: string; price_delta_cents: number }>(
    `SELECT id, name, price_delta_cents FROM modifiers WHERE id = ANY($1::uuid[]) AND active`,
    [modifierIds],
  );

  const byId = new Map(result.rows.map((row) => [row.id, row]));

  if (byId.size !== new Set(modifierIds).size) {
    throw new UnprocessableEntityException(
      problemDetails({
        status: 422,
        code: ERROR_CODES.VALIDATION_FAILED,
        detail: 'Alguno de los modificadores ya no está en el catálogo.',
        errors: [{ path: 'modifiers', message: 'Modificador inexistente o dado de baja.' }],
      }),
    );
  }

  return modifierIds.map((id) => {
    const row = byId.get(id)!;
    return { modifierId: row.id, name: row.name, priceDeltaCents: row.price_delta_cents };
  });
}

// -----------------------------------------------------------------------------
// Errores y textos
// -----------------------------------------------------------------------------

/**
 * Numero visible de una comanda sin correlativo.
 *
 * Se deriva del id y no de un `count(*)`: un correlativo necesita un lock o una secuencia,
 * y dos comandas que se abren en el mismo milisegundo se pelearian por el numero. Como el
 * identificador real es el UUID, mostrar un fragmento alcanza y no crea una secuencia que
 * despues alguien quiera "arreglar".
 */
function generatedNumberLabel(orderId: string): string {
  return orderId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

/**
 * Basis points del query de propinas sugeridas.
 *
 * El esquema ya valida la forma (`5 digitos, separados por coma`), asi que aca solo se
 * convierte. El tope de 10000 (100%) lo pone `suggestedTips`: una propina del 200% es un
 * error de tipeo, y mostrar $2000 de propina sobre una cuenta de $10000 tiene que ser
 * deliberado.
 */
function parseBasisPoints(raw: string | undefined): number[] {
  if (raw === undefined) return [...DEFAULT_TIP_BASIS_POINTS];

  return raw.split(',').map((part) => {
    const bps = Number(part);
    return bps > 10_000 ? 10_000 : bps;
  });
}

function describeStatus(status: OrderStatus): string {
  return status === 'CLOSED'
    ? 'cerrada'
    : status === 'CANCELLED'
      ? 'anulada'
      : status.toLowerCase();
}

function describeTableStatus(status: string): string {
  switch (status) {
    case 'RESERVADA':
      return 'reservada';
    case 'BLOQUEADA':
      return 'bloqueada';
    case 'OCUPADA':
      return 'ocupada';
    case 'PIDIO_CUENTA':
      return 'pidiendo la cuenta';
    default:
      return status.toLowerCase();
  }
}

/**
 * Sin caja abierta no se cobra ni se cierra.
 *
 * El motivo va parametrizado porque el verbo cambia el mensaje ("abrí el turno antes de
 * cerrar la comanda" / "... antes de cobrar") y el operador resuelve en un segundo lo que
 * tiene que resolver.
 */
export function noOpenShift(
  action: 'cerrar la comanda' | 'unir comandas' | 'cobrar',
): ConflictException {
  return new ConflictException(
    problemDetails({
      status: 409,
      code: ERROR_CODES.CONFLICT,
      detail: `No hay caja abierta. Abrí el turno antes de ${action}.`,
    }),
  );
}

export function notFound(detail: string): NotFoundException {
  return new NotFoundException(
    problemDetails({ status: 404, code: ERROR_CODES.NOT_FOUND, detail }),
  );
}
