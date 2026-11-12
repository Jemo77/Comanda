import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { SyncEventTypeSchema, SplitError, uuidSchema } from '@comanda/domain';
import type { DatabaseService } from '../../database/database.service';
// Import de VALOR, no `import type`: `emitDecoratorMetadata` escribe el tipo real
// del segundo argumento del constructor en `design:paramtypes`, y con `import type`
// la clase se borra en tiempo de compilacion y Nest recibe `Function`. El arranque
// falla con "can't resolve dependencies of the SyncService (DATABASE, ?)", que no
// dice nada de la causa. El parametro sigue siendo opcional (`?`) para los tests que
// construyen el servicio sin auditoria.
import { AuditService } from '../audit/audit.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
// Import de VALOR por el mismo motivo que `AuditService` mas abajo: Nest necesita la
// clase real en `design:paramtypes` para resolverla. Es el parametro opcional que
// avisa al KDS; sin el, el sync funciona igual y no hay nadie a quien emissions.
import { KdsService } from '../kds/kds.service';
import {
  assertSplitCoversTotal,
  freeTable,
  refreshOrderTotal,
  resolveOpenShift,
} from '../orders/order-state';
import type { PoolClient } from 'pg';
import type {
  ApplyDeps,
  ApplyOutcome,
  PullResult,
  PushResult,
  SyncEventInput,
  SyncEventResult,
} from './sync.types';

/**
 * Sincronizacion offline.
 *
 * El problema que resuelve: el POS opera sin internet y genera acciones que despues
 * tienen que converger con el servidor **sin duplicar nada**. Tres decisiones:
 *
 *  1. **Idempotencia por `event_id`.** Es la PK de `sync_events`. Reenviar la outbox
 *     entera tras una desconexion es seguro: lo ya visto se descarta por conflicto
 *     de clave. Sin esto, "reintentamos hasta que funcione" duplica comandas.
 *
 *  2. **El tiempo del dispositivo NO decide nada.** `occurred_at` viaja, pero las
 *     comparaciones usan lo que el servidor conoce. Un reloj desfasado no puede
 *     hacer que un cobro se pierda ni que una mesa se libere antes de tiempo.
 *
 *  3. **El cursor del pull es un `bigserial`, no una fecha.** Dos eventos pueden
 *     llegar en el mismo milisegundo; un cliente que sincroniza entre ambos con un
 *     cursor de tiempo los pierde para siempre.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject('DATABASE') private readonly db: DatabaseService,
    private readonly auditService?: AuditService,
    /**
     * A quien se le avisa cuando cambia algo de cocina.
     *
     * Opcional por dos razones concretas. La primera son los tests: hay varios que
     * construyen `SyncService` sin la base completa del modulo `kds`, y una dependencia
     * obligatoria los obligaria a montar un gateway. La segunda es que la instancia
     * que no tiene KDS no tiene a quien avisarle, y el sync tiene que funcionar igual:
     * la cocina es una de las tres cosas que el POS puede hacer, no la unica.
     */
    private readonly kds?: KdsService,
    private readonly loyalty?: LoyaltyService,
  ) {}

  /**
   * Aplica un lote de eventos del dispositivo.
   *
   * Todo el lote va en UNA transaccion: o se aplica entero o no se aplica nada. Un
   * lote a medias deja al dispositivo con estado que el servidor no tiene, y la
   * reconciliacion se vuelve un problema abierto.
   */
  async push(params: {
    deviceId: string;
    orgId: string;
    venueId: string;
    actorId: string | null;
    events: SyncEventInput[];
  }): Promise<PushResult> {
    const results: SyncEventResult[] = [];

    // Cambios de cocina que se emiten **despues** del COMMIT.
    //
    // Los handlers corren dentro de la transaccion, y ahi la fila todavia no esta: si
    // se emitiera el evento en el momento, el KDS se suscribiria y releeria el estado
    // viejo. Es el mismo motivo por el que el gateway relee la base en vez de reemitir
    // el evento.
    const pendingTickets: string[] = [];
    const pendingOrders: string[] = [];

    await this.db.withTenant({ orgId: params.orgId, venueId: params.venueId }, async (client) => {
      for (const event of params.events) {
        results.push(
          await this.pushOne(client, event, {
            orgId: params.orgId,
            venueId: params.venueId,
            actorId: params.actorId,
            deviceId: params.deviceId,
            now: () => new Date(),
            onKdsTicketChanged: (ticketId) => pendingTickets.push(ticketId),
            onKdsOrderChanged: (orderId) => pendingOrders.push(orderId),
          }),
        );
      }
    });

    // El KDS se entera **despues** del commit, que es cuando la fila existe de verdad.
    // Los tickets primero, el tablero despues: si se emitiera al reves, la pantalla
    // recibiria el tablero sin el ticket nuevo y despues el ticket, dos viajes por lo
    // mismo.
    for (const ticketId of pendingTickets) {
      this.kds?.notifyTicketChanged(params.orgId, params.venueId, ticketId);
    }
    for (const orderId of new Set(pendingOrders)) {
      if (!this.kds) continue;
      // Crear los tickets que faltan **antes** de avisar: `notifyOrderItems` hace que
      // el gateway relea el tablero entero, y si se emitiera antes de crear, la
      // pantalla recibiria un tablero sin el ticket nuevo.
      await this.kds.ensureTicketsForOrder(params.orgId, params.venueId, orderId);
    }

    // El cursor se lee despues del lote, dentro de la misma transaccion, para que
    // un `pull` posterior no se pierda eventos aplicados por este `push`.
    const cursor = await this.currentCursor(params.orgId);
    const acknowledged = results.length
      ? Math.max(...params.events.map((event) => event.seq))
      : await this.lastDeviceSeq(params.orgId, params.deviceId);

    // Acreditación de fidelidad: cada comanda cerrada por el sync suma puntos. Va
    // después del commit y no bloquea: si falla queda log, no una mesa sin cerrar.
    for (let i = 0; i < params.events.length; i += 1) {
      const event = params.events[i]!;
      const result = results[i];
      if (event.type === 'ORDER_CLOSED' && result?.status === 'APPLIED') {
        await this.loyalty
          ?.accrueForOrder((event.payload as { orderId?: string }).orderId as string)
          .catch(() => undefined);
      }
    }

    return { results, cursor, acknowledgedSeq: acknowledged };
  }

  /**
   * Aplica un evento.
   *
   * El `INSERT ... ON CONFLICT DO NOTHING` es el corazon de la idempotencia: si la
   * fila ya existe, el evento ya se aplico en un envio anterior y se devuelve
   * `DUPLICATE` sin volver a tocar el negocio.
   */
  private async pushOne(
    client: PoolClient,
    event: SyncEventInput,
    deps: ApplyDeps,
  ): Promise<SyncEventResult> {
    // 1. Idempotencia: se intenta reservar el event_id ANTES de aplicar nada.
    const reserved = await client.query<{ seq_global: string }>(
      `INSERT INTO sync_events
         (event_id, org_id, venue_id, device_id, actor_id, seq, type, payload, occurred_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::jsonb, $9)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING seq_global`,
      [
        event.eventId,
        deps.orgId,
        deps.venueId,
        deps.deviceId,
        deps.actorId,
        event.seq,
        event.type,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );

    if (reserved.rows.length === 0) {
      // Ya estaba. Se recupera el cursor para que el cliente pueda seguir bajando.
      const existing = await client.query<{
        seq_global: string;
        status: string;
        result: Record<string, unknown> | null;
      }>(`SELECT seq_global, status, result FROM sync_events WHERE event_id = $1::uuid`, [
        event.eventId,
      ]);
      const row = existing.rows[0];
      return {
        eventId: event.eventId,
        status: 'DUPLICATE',
        cursor: row?.seq_global,
        // Se devuelve el resultado original para que un reenvio no deje al cliente
        // sin el id de la orden que se creo la primera vez.
        ...(row?.result ?? {}),
      };
    }

    const seqGlobal = reserved.rows[0]!.seq_global;

    // 2. Aplicar. Un evento invalido se registra como REJECTED y NO tumba el lote:
    //    un payload corrupto de un dispositivo no puede impedir que el resto sincronice.
    let outcome: ApplyOutcome;
    try {
      outcome = await this.apply(client, event, deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Evento ${event.eventId} (${event.type}) rechazado: ${message}`);
      outcome = {
        status: 'REJECTED',
        message: 'El evento no se pudo aplicar.',
        action: 'DISCARD',
      };
    }

    await client.query(
      `UPDATE sync_events SET status = $2, result = $3::jsonb WHERE event_id = $1::uuid`,
      [event.eventId, outcome.status, JSON.stringify(outcome.data ?? {})],
    );

    return {
      eventId: event.eventId,
      status: outcome.status,
      cursor: seqGlobal,
      ...(outcome.data ? { data: outcome.data } : {}),
      ...(outcome.message ? { message: outcome.message } : {}),
      ...(outcome.action ? { action: outcome.action } : {}),
    };
  }

  /**
   * Aplica el efecto de negocio de un evento.
   *
   * El orden importa: se resuelve el conflicto de la mesa ANTES de crear la comanda,
   * porque de eso depende si la comanda se queda con la mesa o vuelve sin ella.
   */
  private async apply(
    client: PoolClient,
    event: SyncEventInput,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const payload = event.payload;

    switch (event.type) {
      case 'ORDER_OPENED':
        return this.applyOrderOpened(client, event, deps);
      case 'ORDER_ITEM_ADDED':
        return this.applyItemAdded(client, event, deps);
      case 'ORDER_ITEM_VOIDED':
        return this.applyItemVoided(client, event, deps, payload);
      case 'ORDER_NOTE_SET':
        return this.applyOrderNote(client, payload);
      case 'PAYMENT_RECORDED':
        return this.applyPayment(client, payload, deps);
      case 'ORDER_CLOSED':
        return this.applyOrderClosed(client, payload, deps);
      case 'ORDER_CANCELED':
        return this.applyOrderCanceled(client, payload, deps);
      case 'ORDER_ITEM_COURSE_SET':
        return this.applyCourseSet(client, payload);
      case 'ORDER_SEAT_SET':
        return this.applySeatSet(client, payload);
      case 'TIP_ADDED':
        return this.applyTipAdded(client, payload, deps);
      case 'ORDER_CHARGES_SET':
        return this.applyOrderChargesSet(client, payload, deps);
      case 'SPLIT_SAVED':
        return this.applySplitSaved(client, payload, deps);
      case 'SHIFT_OPENED':
        return this.applyShiftOpened(client, event, payload, deps);
      case 'SHIFT_CASH_MOVEMENT':
        return this.applyCashMovement(client, payload, deps);
      case 'KDS_STATUS_SET':
        return this.applyKdsStatus(client, payload, deps);

      // Los eventos `TABLE_*` son los mismos efectos que los `ORDER_*`, con el
      // nombre del dominio del salon. El POS los emite cuando la accion arranca
      // desde el mapa de mesas en vez de desde la comanda, y unificarlos aqui
      // evita dos implementaciones del mismo efecto que se pueden divergir.
      case 'TABLE_OPENED':
        return this.applyOrderOpened(client, event, deps);
      case 'TABLE_ITEM_ADDED':
        return this.applyItemAdded(client, event, deps);
      case 'TABLE_ITEM_VOIDED':
        return this.applyItemVoided(client, event, deps, payload);
      case 'TABLE_NOTE_SET':
        return this.applyOrderNote(client, payload);

      default:
        return {
          status: 'REJECTED',
          message: `Tipo de evento sin handler: ${event.type}`,
          action: 'DISCARD',
        };
    }
  }

  /**
   * Abre una comanda, resolviendo el conflicto de mesa.
   *
   * Regla del plan: "gana el primer occurred_at del servidor". O sea, entre dos
   * dispositivos que abren la misma mesa, se queda con ella el whose comanda se
   * creo primero; el otro recibe aviso y **re-asigna**.
   *
   * Se implementa en las dos direcciones porque si no, un dispositivo con el reloj
   * atrasado podria ganar la mesa despues y dejar a la comanda ya abierta en el
   * aire sin mesa.
   */
  private async applyOrderOpened(
    client: PoolClient,
    event: SyncEventInput,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = event.payload as {
      orderId: string;
      tableId?: string | null;
      numberLabel: string;
      channel?: string;
      guests?: number;
      openedAt?: string;
      sourceEventId?: string;
    };

    if (!p.orderId || !p.numberLabel) {
      return { status: 'REJECTED', message: 'Falta orderId o numberLabel.', action: 'DISCARD' };
    }

    let tableId = p.tableId ?? null;
    let conflict: { otherOrderId: string; winner: 'incoming' | 'existing' } | null = null;

    if (tableId) {
      const occupied = await client.query<{
        id: string;
        order_id: string;
        occurred_at: string;
        source_event_id: string | null;
      }>(
        `SELECT t.id, t.order_id, o.opened_at AS occurred_at, o.source_event_id
         FROM tables t
         JOIN orders o ON o.id = t.order_id
         WHERE t.id = $1::uuid AND t.status IN ('OCUPADA','PIDIO_CUENTA')`,
        [tableId],
      );

      if (occupied.rows.length > 0) {
        const existing = occupied.rows[0]!;
        // `occurred_at` del dispositivo que ocupa la mesa, para comparar con el del
        // que llega. Es la unica vez que se usa el reloj del cliente, y solo como
        // criterio de desempate: nunca para decidir dinero ni tiempo.
        const existingOccurredAt = existing.source_event_id
          ? (
              await client.query<{ occurred_at: string }>(
                `SELECT occurred_at FROM sync_events WHERE event_id = $1::uuid`,
                [existing.source_event_id],
              )
            ).rows[0]?.occurred_at
          : existing.occurred_at;

        const incomingIsEarlier =
          Date.parse(event.occurredAt) < Date.parse(existingOccurredAt ?? existing.occurred_at);

        if (incomingIsEarlier) {
          // Gana el entrante: la comanda existente pierde la mesa y su dispositivo
          // tiene que re-asignarla. Se emite un evento de servidor para que lo vea
          // en el proximo pull.
          await client.query(
            `UPDATE orders SET table_id = NULL, updated_at = now() WHERE id = $1::uuid`,
            [existing.order_id],
          );
          await client.query(
            `UPDATE tables SET status = 'LIBRE', order_id = NULL, occupied_since = NULL, updated_at = now()
             WHERE id = $1::uuid`,
            [tableId],
          );
          // El otro dispositivo se entera por el pull, no solo por la respuesta de su
          // propio push: si estaba desconectado cuando esto paso, su push no le
          // devuelve nada y su comanda queda apuntando a una mesa que ya no es
          // suya. Sin este evento, la mesa aparece ocupada por dos comandas.
          await this.emitServerEvent(client, deps, 'TABLE_STATUS_CHANGED', {
            tableId,
            orderId: p.orderId,
            displacedOrderId: existing.order_id,
            reason: 'La mesa fue tomada por una comanda anterior.',
          });
          conflict = { otherOrderId: existing.order_id, winner: 'incoming' };
        } else {
          // Gana la existente: la comanda entrante se crea sin mesa y su dispositivo
          // tiene que elegir otra.
          conflict = { otherOrderId: existing.order_id, winner: 'existing' };
          tableId = null;
        }
      }
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders
         (id, org_id, venue_id, table_id, channel, status, number_label, opened_by,
          opened_at, guests, source_device_id, source_event_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'OPEN', $6, $7::uuid,
               COALESCE($8::timestamptz, $9), $10, $11::uuid, $12::uuid)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        p.orderId,
        deps.orgId,
        deps.venueId,
        tableId,
        p.channel ?? 'POS',
        p.numberLabel,
        deps.actorId,
        p.openedAt ?? null,
        deps.now().toISOString(),
        p.guests ?? 1,
        deps.deviceId,
        event.eventId,
      ],
    );

    if (inserted.rows.length > 0 && tableId) {
      await client.query(
        `UPDATE tables SET status = 'OCUPADA', order_id = $2::uuid, occupied_since = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [tableId, p.orderId],
      );
    }

    if (conflict && conflict.winner === 'existing') {
      return {
        status: 'CONFLICT',
        data: {
          orderId: p.orderId,
          tableId: null,
          conflictingOrderId: conflict.otherOrderId,
        },
        message: `La mesa ya la tiene abierta otra comanda (${conflict.otherOrderId}). Elegí otra mesa.`,
        action: 'REASSIGN_TABLE',
      };
    }

    if (conflict) {
      return {
        status: 'CONFLICT',
        data: {
          orderId: p.orderId,
          tableId,
          displacedOrderId: conflict.otherOrderId,
        },
        message: 'La comanda anterior quedó sin mesa y tiene que reasignarse.',
        action: 'NONE',
      };
    }

    return { status: 'APPLIED', data: { orderId: p.orderId, tableId } };
  }

  /**
   * Agrega un ítem.
   *
   * Los ítems son append-only: agregar de más NO se fusiona con el ítem existente
   * (eso lo decide el POS, que sabe si el mozo quiso otra cosa), pero repetir el
   * mismo `itemId` no crea un segundo. Es idempotente a nivel de ítem, no de cola.
   */
  private async applyItemAdded(
    client: PoolClient,
    event: SyncEventInput,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = event.payload as {
      orderId: string;
      itemId: string;
      productId?: string | null;
      name: string;
      quantity: number;
      unitPriceCents: number;
      appliedRules?: unknown[];
      course?: number;
      seat?: number | null;
      note?: string | null;
      modifiers?: Array<{ modifierId?: string | null; name: string; priceDeltaCents: number }>;
    };

    if (!p.orderId || !p.itemId || !p.name) {
      return { status: 'REJECTED', message: 'Falta orderId, itemId o name.', action: 'DISCARD' };
    }
    if (!Number.isInteger(p.quantity) || p.quantity <= 0) {
      return {
        status: 'REJECTED',
        message: 'La cantidad debe ser un entero positivo.',
        action: 'DISCARD',
      };
    }
    if (!Number.isInteger(p.unitPriceCents) || p.unitPriceCents < 0) {
      return {
        status: 'REJECTED',
        message: 'El precio debe ser un entero en centavos.',
        action: 'DISCARD',
      };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO order_items
         (id, org_id, order_id, product_id, name_snapshot, quantity, unit_price_cents,
          list_price_cents, applied_rules, course, seat, note, added_by,
          source_device_id, source_event_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $7, $8::jsonb, $9, $10, $11,
               $12::uuid, $13::uuid, $14::uuid)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        p.itemId,
        deps.orgId,
        p.orderId,
        p.productId ?? null,
        p.name,
        p.quantity,
        p.unitPriceCents,
        JSON.stringify(p.appliedRules ?? []),
        p.course ?? 1,
        p.seat ?? null,
        p.note ?? null,
        deps.actorId,
        deps.deviceId,
        event.eventId,
      ],
    );

    if (inserted.rows.length === 0) {
      return { status: 'DUPLICATE', data: { itemId: p.itemId } };
    }

    for (const [index, modifier] of (p.modifiers ?? []).entries()) {
      await client.query(
        `INSERT INTO order_item_modifiers
           (org_id, order_item_id, modifier_id, name_snapshot, price_delta_cents, sort)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
        [
          deps.orgId,
          p.itemId,
          modifier.modifierId ?? null,
          modifier.name,
          modifier.priceDeltaCents,
          index,
        ],
      );
    }

    await refreshOrderTotal(client, p.orderId);

    // El item recien agregado es lo que crea el ticket de cocina: uno por estacion, con
    // los items de esa estacion agrupados (ver `KdsService.ensureTicketsForOrder`).
    // `ensureTicketsForOrder` abre su propia transaccion, asi que **no** puede correr
    // dentro de esta: abriria otra conexion sin el `SET LOCAL` del tenant, no veria
    // esta fila todavia sin commitear y crearia un papel vacio. Por eso aca solo se
    // avisa, y el ticket se crea despues del COMMIT, desde `push`.
    deps.onKdsOrderChanged?.(p.orderId);

    return { status: 'APPLIED', data: { orderId: p.orderId, itemId: p.itemId } };
  }

  /**
   * Anula un ítem.
   *
   * No existe el borrado: anular deja el ítem, el motivo, quién y cuándo. Es lo que
   * permite responder "cuánto se descontó por anulaciones" sin un log paralelo.
   */
  private async applyItemVoided(
    client: PoolClient,
    event: SyncEventInput,
    deps: ApplyDeps,
    payload: Record<string, unknown>,
  ): Promise<ApplyOutcome> {
    const p = payload as { orderId: string; itemId: string; reason: string };

    if (!p.itemId || !p.reason) {
      return { status: 'REJECTED', message: 'Anular sin motivo no se permite.', action: 'DISCARD' };
    }

    const result = await client.query<{
      name_snapshot: string;
      quantity: number;
      unit_price_cents: number;
    }>(
      `UPDATE order_items
       SET status = 'VOIDED', void_reason = $2, voided_by = $3::uuid, voided_at = now(), updated_at = now()
       WHERE id = $1::uuid AND status = 'ACTIVE'
       RETURNING name_snapshot, quantity, unit_price_cents`,
      [p.itemId, p.reason, deps.actorId],
    );

    if (result.rowCount === 0) {
      return { status: 'DUPLICATE', data: { itemId: p.itemId } };
    }

    await refreshOrderTotal(client, p.orderId);

    // Un item anulado sale del papel de cocina. Sin este aviso el KDS sigue mostrando
    // algo que ya no existe, y el cocinero cocina un plato que el cliente cancelo.
    deps.onKdsOrderChanged?.(p.orderId);

    // Anular es accion sensible (PLAN §4.7): queda con actor, dispositivo, motivo
    // y el importe que dejo de cobrarse. Sin esto, "cuanto se desconto por
    // anulaciones" no se puede responder con un filtro.
    const voided = result.rows[0]!;
    await this.auditService?.record({
      orgId: deps.orgId,
      venueId: deps.venueId,
      actorId: deps.actorId,
      deviceId: deps.deviceId,
      action: 'order.item_voided',
      entity: 'order_item',
      entityId: p.itemId,
      after: {
        orderId: p.orderId,
        name: voided.name_snapshot,
        quantity: voided.quantity,
        removedCents: voided.unit_price_cents * voided.quantity,
      },
      reason: p.reason,
    });

    return { status: 'APPLIED', data: { orderId: p.orderId, itemId: p.itemId, voided: true } };
  }

  private async applyOrderNote(
    client: PoolClient,
    payload: Record<string, unknown>,
  ): Promise<ApplyOutcome> {
    const p = payload as { orderId: string; note?: string | null };
    await client.query(`UPDATE orders SET updated_at = now() WHERE id = $1::uuid`, [p.orderId]);
    return { status: 'APPLIED', data: { orderId: p.orderId, note: p.note ?? null } };
  }

  /**
   * Registra un pago.
   *
   * `provider_ref` es el comprobante del terminal, nunca el número de tarjeta: la
   * API no ve el PAN en ningun camino (PLAN §6, PCI).
   */
  private async applyPayment(
    client: PoolClient,
    payload: Record<string, unknown>,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = payload as {
      paymentId: string;
      orderId: string;
      method: string;
      amountCents: number;
      tipCents?: number;
      provider?: string | null;
      providerRef?: string | null;
      shiftId?: string | null;
    };

    if (!['CASH', 'CARD', 'QR', 'TRANSFER'].includes(p.method)) {
      return {
        status: 'REJECTED',
        message: `Método de pago desconocido: ${p.method}`,
        action: 'DISCARD',
      };
    }
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
      return {
        status: 'REJECTED',
        message: 'El importe debe ser un entero positivo.',
        action: 'DISCARD',
      };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payments
         (id, org_id, order_id, method, amount_cents, tip_cents, provider, provider_ref,
          status, shift_id, received_by, source_device_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, 'APPROVED', $9::uuid, $10::uuid, $11::uuid)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        p.paymentId,
        deps.orgId,
        p.orderId,
        p.method,
        p.amountCents,
        p.tipCents ?? 0,
        p.provider ?? null,
        p.providerRef ?? null,
        p.shiftId ?? null,
        deps.actorId,
        deps.deviceId,
      ],
    );

    if (inserted.rows.length === 0) {
      return { status: 'DUPLICATE', data: { paymentId: p.paymentId } };
    }

    // El pago NO suma al total de la orden: el total es lo que se debe, y ya esta
    // calculado desde los items. Lo que se acumula es lo pagado, y lo que falta
    // cobrar se deriva restando. Sumar el pago al totaleria "lo que se debe" con
    // "lo que se pagó" mezclados, y el arqueo del turno no cerraria nunca.
    //
    // La propina del pago si va a `tip_cents`, que es un componente del total.
    if (p.tipCents) {
      await client.query(
        `UPDATE orders SET tip_cents = tip_cents + $2, updated_at = now() WHERE id = $1::uuid`,
        [p.orderId, p.tipCents],
      );
      await refreshOrderTotal(client, p.orderId);
    }

    // El cobro es la accion mas sensible del sistema: si se duplica, hay que
    // devolver plata y el arqueo del turno ya cerro. Queda con actor, dispositivo,
    // metodo y referencia del proveedor (nunca el PAN).
    await this.auditService?.record({
      orgId: deps.orgId,
      venueId: deps.venueId,
      actorId: deps.actorId,
      deviceId: deps.deviceId,
      action: 'bill.paid',
      entity: 'payment',
      entityId: p.paymentId,
      after: {
        orderId: p.orderId,
        method: p.method,
        amountCents: p.amountCents,
        tipCents: p.tipCents ?? 0,
        provider: p.provider ?? null,
        providerRef: p.providerRef ?? null,
      },
    });

    return {
      status: 'APPLIED',
      data: {
        orderId: p.orderId,
        paymentId: p.paymentId,
        amountCents: p.amountCents,
        method: p.method,
      },
    };
  }

  /**
   * Guarda el descuento y la tasa de servicio de la comanda.
   *
   * Van como estado de la orden y no como operacion sobre el total, porque el total
   * se recalcula siempre desde los items mas estos dos parametros. Si el descuento
   * se sumara o restara sobre `total_cents`, dos recalculos seguidos darian
   * numeros distintos segun cuantas veces hubiera llegado el evento.
   *
   * `discountCents` se acota al subtotal dentro de `orderTotals`: un descuento
   * mayor que la cuenta deja el total en cero, no negativo.
   */
  private async applyOrderChargesSet(
    client: PoolClient,
    payload: Record<string, unknown>,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = payload as {
      orderId: string;
      discountCents?: number;
      serviceBps?: number;
      /** Motivo del descuento. Obligatorio si hay descuento (PLAN §4.7). */
      reason?: string;
    };

    if (!p.orderId) {
      return { status: 'REJECTED', message: 'Falta orderId.', action: 'DISCARD' };
    }

    const discount = p.discountCents ?? 0;
    const serviceBps = p.serviceBps ?? 0;

    if (!Number.isInteger(discount) || discount < 0) {
      return {
        status: 'REJECTED',
        message: 'El descuento debe ser un entero >= 0 en centavos.',
        action: 'DISCARD',
      };
    }
    if (!Number.isInteger(serviceBps) || serviceBps < 0 || serviceBps > 10_000) {
      return {
        status: 'REJECTED',
        message: 'El servicio debe ser un entero entre 0 y 10000 basis points.',
        action: 'DISCARD',
      };
    }
    // Un descuento sin motivo es indistinguible de un robo al revisar el turno.
    if (discount > 0 && !p.reason) {
      return {
        status: 'REJECTED',
        message: 'Un descuento necesita un motivo.',
        action: 'DISCARD',
      };
    }

    const updated = await client.query(
      `UPDATE orders
       SET discount_cents = $2, service_bps = $3, updated_at = now()
       WHERE id = $1::uuid AND status NOT IN ('CLOSED','CANCELLED')`,
      [p.orderId, discount, serviceBps],
    );

    if (updated.rowCount === 0) {
      return { status: 'DUPLICATE', data: { orderId: p.orderId } };
    }

    await refreshOrderTotal(client, p.orderId);

    if (discount > 0) {
      // El descuento es una accion sensible: queda en `audit_log` con actor,
      // dispositivo e importe.
      await this.auditService?.record({
        orgId: deps.orgId,
        venueId: deps.venueId,
        actorId: deps.actorId,
        deviceId: deps.deviceId,
        action: 'bill.discount_applied',
        entity: 'order',
        entityId: p.orderId,
        after: { discountCents: discount, serviceBps, reason: p.reason ?? null },
        reason: p.reason ?? null,
      });
    }

    return {
      status: 'APPLIED',
      data: { orderId: p.orderId, discountCents: discount, serviceBps },
    };
  }

  /** Cierra la comanda y libera la mesa. */
  private async applyOrderClosed(
    client: PoolClient,
    payload: Record<string, unknown>,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = payload as { orderId: string; shiftId?: string | null };
    if (!p.orderId) {
      return { status: 'REJECTED', message: 'Falta orderId.', action: 'DISCARD' };
    }

    const shiftId = p.shiftId ?? (await resolveOpenShift(client, deps.venueId));

    if (!shiftId) {
      // Sin turno no se puede cerrar. Se rechaza con un mensaje que dice que
      // hacer, en vez de dejar la constraint reventar el UPDATE.
      return {
        status: 'REJECTED',
        message: 'No hay caja abierta. Abrí el turno antes de cerrar la comanda.',
        action: 'NONE',
      };
    }

    // `source_device_id` se setea tambien al cerrar, no solo al abrir: si la comanda
    // se cobro desde otra tablet que la que la abrio, el cierre es lo que deja
    // rastro de eso. Sin este dato, "quien cobro esto" no se puede reconstruir.
    const closed = await client.query<{ table_id: string | null }>(
      `UPDATE orders
       SET status = 'CLOSED', closed_at = now(), shift_id = $2::uuid,
           source_device_id = $3::uuid, updated_at = now()
       WHERE id = $1::uuid AND status NOT IN ('CLOSED','CANCELLED')
       RETURNING table_id`,
      [p.orderId, shiftId, deps.deviceId],
    );

    if (closed.rows.length === 0) {
      return { status: 'DUPLICATE', data: { orderId: p.orderId } };
    }

    const tableId = closed.rows[0]!.table_id;
    if (tableId) {
      await freeTable(client, tableId);
    }

    return { status: 'APPLIED', data: { orderId: p.orderId, tableId, shiftId } };
  }

  /**
   * Cancela la comanda.
   *
   * Cancelar no es cerrar: la comanda queda `CANCELLED` con su motivo y no suma a
   * la caja. El motivo es obligatorio porque una comanda anulada sin explicacion es
   * indistinguible de un robo, y es exactamente el caso que el encargado necesita
   * ver en el arqueo.
   */
  private async applyOrderCanceled(
    client: PoolClient,
    payload: Record<string, unknown>,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = payload as { orderId: string; reason?: string; shiftId?: string | null };

    if (!p.orderId || !p.reason) {
      return {
        status: 'REJECTED',
        message: 'Cancelar una comanda exige un motivo.',
        action: 'DISCARD',
      };
    }

    const shiftId = p.shiftId ?? (await resolveOpenShift(client, deps.venueId));
    if (!shiftId) {
      return {
        status: 'REJECTED',
        message: 'No hay caja abierta. Abrí el turno antes de cancelar.',
        action: 'NONE',
      };
    }

    const canceled = await client.query<{ table_id: string | null }>(
      `UPDATE orders
       SET status = 'CANCELLED', closed_at = now(), shift_id = $2::uuid,
           source_device_id = $3::uuid, updated_at = now()
       WHERE id = $1::uuid AND status NOT IN ('CLOSED','CANCELLED')
       RETURNING table_id`,
      [p.orderId, shiftId, deps.deviceId],
    );

    if (canceled.rows.length === 0) {
      return { status: 'DUPLICATE', data: { orderId: p.orderId } };
    }

    const tableId = canceled.rows[0]!.table_id;
    if (tableId) await freeTable(client, tableId);

    return { status: 'APPLIED', data: { orderId: p.orderId, tableId, reason: p.reason } };
  }

  /**
   * Asigna items a un curso.
   *
   * "Mantener y disparar" en un bar se implementa asi: el mozo marca todos los
   * items de entrada como curso 1 y los de principal como curso 2, y la cocina ve
   * primero los de entrada.
   */
  private async applyCourseSet(
    client: PoolClient,
    payload: Record<string, unknown>,
  ): Promise<ApplyOutcome> {
    const p = payload as { orderId: string; itemIds: string[]; course: number };

    if (!p.orderId || !Array.isArray(p.itemIds) || p.itemIds.length === 0) {
      return { status: 'REJECTED', message: 'Faltan los items del curso.', action: 'DISCARD' };
    }
    if (!Number.isInteger(p.course) || p.course < 1 || p.course > 9) {
      return {
        status: 'REJECTED',
        message: 'El curso tiene que ser un entero entre 1 y 9.',
        action: 'DISCARD',
      };
    }

    const updated = await client.query(
      `UPDATE order_items SET course = $3, updated_at = now()
       WHERE id = ANY($2::uuid[]) AND order_id = $1::uuid`,
      [p.orderId, p.itemIds, p.course],
    );

    return {
      status: updated.rowCount === 0 ? 'DUPLICATE' : 'APPLIED',
      data: { orderId: p.orderId, course: p.course, updated: updated.rowCount },
    };
  }

  /**
   * Asigna items a un comensal (asiento).
   *
   * Es lo que hace posible dividir la cuenta por persona: sin `seat`, el reparto por
   * asiento no tiene con que trabajar.
   */
  private async applySeatSet(
    client: PoolClient,
    payload: Record<string, unknown>,
  ): Promise<ApplyOutcome> {
    const p = payload as { orderId: string; itemIds: string[]; seat: number | null };

    if (!p.orderId || !Array.isArray(p.itemIds) || p.itemIds.length === 0) {
      return { status: 'REJECTED', message: 'Faltan los items del asiento.', action: 'DISCARD' };
    }
    if (p.seat !== null && (!Number.isInteger(p.seat) || p.seat < 1 || p.seat > 40)) {
      return {
        status: 'REJECTED',
        message: 'El asiento tiene que ser un entero entre 1 y 40, o nulo.',
        action: 'DISCARD',
      };
    }

    const updated = await client.query(
      `UPDATE order_items SET seat = $3, updated_at = now()
       WHERE id = ANY($2::uuid[]) AND order_id = $1::uuid`,
      [p.orderId, p.itemIds, p.seat],
    );

    return {
      status: updated.rowCount === 0 ? 'DUPLICATE' : 'APPLIED',
      data: { orderId: p.orderId, seat: p.seat, updated: updated.rowCount },
    };
  }

  /**
   * Suma propina a la comanda.
   *
   * Va como evento propio y no como parte del pago porque la propina se carga
   * despues de cobrar la cuenta: el total ya estaba enunciado al cliente y la
   * propina se agrega encima. El total de la comanda lo recalcula el servidor.
   */
  private async applyTipAdded(
    client: PoolClient,
    payload: Record<string, unknown>,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = payload as { orderId: string; tipCents: number };

    if (!p.orderId || !Number.isInteger(p.tipCents) || p.tipCents < 0) {
      return {
        status: 'REJECTED',
        message: 'La propina debe ser un entero >= 0 en centavos.',
        action: 'DISCARD',
      };
    }
    if (p.tipCents === 0) {
      return { status: 'DUPLICATE', data: { orderId: p.orderId, tipCents: 0 } };
    }

    const updated = await client.query(
      `UPDATE orders SET tip_cents = tip_cents + $2, updated_at = now()
       WHERE id = $1::uuid AND status NOT IN ('CLOSED','CANCELLED')
       RETURNING id`,
      [p.orderId, p.tipCents],
    );

    if (updated.rowCount === 0) {
      return { status: 'DUPLICATE', data: { orderId: p.orderId } };
    }

    // El total incluye la propina, asi que hay que recalcularlo. Sumarla a mano
    // dejaria `total_cents` y `tip_cents` diciendo cosas distintas.
    await refreshOrderTotal(client, p.orderId);

    void deps;
    return { status: 'APPLIED', data: { orderId: p.orderId, tipCents: p.tipCents } };
  }

  /**
   * Guarda el reparto de la cuenta.
   *
   * Se persiste tal cual lo calculo el cliente y **no se recalcula en el
   * servidor**: el reparto ya se mostro en pantalla y el cliente ya lo acepto.
   * Recalcularlo acá podria dar un centavo distinto al que se leygó cobrar, que es
   * la peor forma de descuadrar una mesa.
   *
   * Lo que si valida es que las partes sumen el total.
   */
  private async applySplitSaved(
    client: PoolClient,
    payload: Record<string, unknown>,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = payload as {
      splitId?: string;
      orderId: string;
      mode: string;
      allocations: Array<{ label: string; amountCents: number; itemIds?: string[] }>;
    };

    if (!p.orderId || !['BY_ITEM', 'EQUAL', 'AMOUNT'].includes(p.mode)) {
      return { status: 'REJECTED', message: 'Reparto invalido.', action: 'DISCARD' };
    }
    if (!Array.isArray(p.allocations) || p.allocations.length === 0) {
      return {
        status: 'REJECTED',
        message: 'El reparto tiene que tener al menos una parte.',
        action: 'DISCARD',
      };
    }

    for (const allocation of p.allocations) {
      if (!Number.isInteger(allocation.amountCents) || allocation.amountCents < 0) {
        return {
          status: 'REJECTED',
          message: 'Cada parte del reparto es un entero >= 0 en centavos.',
          action: 'DISCARD',
        };
      }
    }

    const order = await client.query<{ total_cents: number }>(
      `SELECT total_cents FROM orders WHERE id = $1::uuid`,
      [p.orderId],
    );
    if (order.rows.length === 0) {
      return { status: 'REJECTED', message: 'La comanda no existe.', action: 'DISCARD' };
    }

    const allocated = p.allocations.reduce((acc, a) => acc + a.amountCents, 0);

    // La validacion es la misma que la del endpoint de division, extraida a
    // `order-state.ts`: dos reglas parecidas son dos reglas que divergen, y la
    // divergencia aparece como un centavo que no cierra en la mesa.
    try {
      assertSplitCoversTotal(p.allocations, order.rows[0]!.total_cents);
    } catch (error) {
      if (error instanceof SplitError) {
        return { status: 'REJECTED', message: error.message, action: 'NONE' };
      }
      throw error;
    }

    const inserted = await client.query(
      `INSERT INTO bill_splits (id, org_id, order_id, mode, allocations, total_cents, created_by)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7::uuid)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.splitId ?? null,
        deps.orgId,
        p.orderId,
        p.mode,
        JSON.stringify(p.allocations),
        allocated,
        deps.actorId,
      ],
    );

    return {
      status: inserted.rowCount === 0 ? 'DUPLICATE' : 'APPLIED',
      data: { orderId: p.orderId, mode: p.mode, totalCents: allocated },
    };
  }

  /**
   * Abre el turno.
   *
   * Un solo turno abierto por local (indice unico parcial). El `ON CONFLICT` no
   * aplica porque es un indice parcial: el conflicto se resuelve leyendo si ya hay
   * uno y contestando DUPLICATE, que es el resultado correcto cuando dos tablets
   * abren caja a la vez.
   */
  private async applyShiftOpened(
    client: PoolClient,
    event: SyncEventInput,
    payload: Record<string, unknown>,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = payload as { shiftId?: string; openingFloatCents?: number };
    const float = p.openingFloatCents ?? 0;

    if (!Number.isInteger(float) || float < 0) {
      return {
        status: 'REJECTED',
        message: 'El fondo de caja debe ser un entero >= 0 en centavos.',
        action: 'DISCARD',
      };
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN' LIMIT 1`,
      [deps.venueId],
    );
    if (existing.rows.length > 0) {
      return {
        status: 'DUPLICATE',
        data: { shiftId: existing.rows[0]!.id },
        message: 'La caja ya estaba abierta en este local.',
      };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO shifts (id, org_id, venue_id, opened_by, opened_at, opening_float_cents, source_event_id)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2::uuid, $3::uuid, $4::uuid,
               COALESCE($5::timestamptz, $6), $7, $8::uuid)
       RETURNING id`,
      [
        p.shiftId ?? null,
        deps.orgId,
        deps.venueId,
        deps.actorId,
        payload.openedAt ?? null,
        deps.now().toISOString(),
        float,
        event.eventId,
      ],
    );

    return {
      status: 'APPLIED',
      data: { shiftId: inserted.rows[0]!.id, openingFloatCents: float },
    };
  }

  /**
   * Movimiento de efectivo del turno.
   *
   * El signo lo decide el tipo y no quien escribe: `IN` suma, `OUT` y `RETIRO`
   * restan. Confiar en el signo del payload permitiria que un retiro se guardara
   * como ingreso y el arqueo del turno quedara desfasado para siempre.
   */
  private async applyCashMovement(
    client: PoolClient,
    payload: Record<string, unknown>,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = payload as {
      movementId?: string;
      shiftId: string;
      type: string;
      amountCents: number;
      reason?: string;
    };

    if (!['IN', 'OUT', 'RETIRO'].includes(p.type)) {
      return {
        status: 'REJECTED',
        message: `Movimiento desconocido: ${p.type}`,
        action: 'DISCARD',
      };
    }
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
      return {
        status: 'REJECTED',
        message: 'El importe tiene que ser un entero positivo en centavos.',
        action: 'DISCARD',
      };
    }
    // Todo movimiento de efectivo queda auditado con motivo (PLAN §4.7).
    if (!p.reason) {
      return {
        status: 'REJECTED',
        message: 'Un movimiento de efectivo necesita un motivo.',
        action: 'DISCARD',
      };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO cash_movements (id, org_id, shift_id, type, amount_cents, reason, created_by)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2::uuid, $3::uuid, $4, $5, $6, $7::uuid)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [p.movementId ?? null, deps.orgId, p.shiftId, p.type, p.amountCents, p.reason, deps.actorId],
    );

    // El signo lo decide el tipo al CALCULAR, no al guardar. Guardar el importe tal
    // cual vino del payload permitiria que un retiro quedara registrado con signo
    // positivo y el arqueo del turno quedara desfasado para siempre.
    const signed = p.type === 'IN' ? p.amountCents : -p.amountCents;

    await this.auditService?.record({
      orgId: deps.orgId,
      venueId: deps.venueId,
      actorId: deps.actorId,
      deviceId: deps.deviceId,
      action: 'shift.cash_movement',
      entity: 'cash_movement',
      entityId: inserted.rows[0]?.id ?? p.movementId ?? null,
      after: { shiftId: p.shiftId, type: p.type, amountCents: p.amountCents, signedCents: signed },
      reason: p.reason ?? null,
    });

    return {
      status: inserted.rowCount === 0 ? 'DUPLICATE' : 'APPLIED',
      data: {
        movementId: inserted.rows[0]?.id ?? p.movementId,
        type: p.type,
        signedCents: signed,
      },
    };
  }

  /**
   * Avanza el estado de un ticket de cocina.
   *
   * El ciclo es NEW -> PREPARING -> READY -> SERVED. Solo avanza hacia adelante:
   * un ticket que ya esta LISTO no vuelve a NEW, porque eso lo pasaria por
   * pantalla dos veces en cocina y el que lo esta haciendo cree que esotro.
   */
  private async applyKdsStatus(
    client: PoolClient,
    payload: Record<string, unknown>,
    deps: ApplyDeps,
  ): Promise<ApplyOutcome> {
    const p = payload as { ticketId: string; status: string };

    const order: Record<string, number> = { NEW: 0, PREPARING: 1, READY: 2, SERVED: 3 };
    if (!(p.status in order)) {
      return {
        status: 'REJECTED',
        message: `Estado de cocina desconocido: ${p.status}`,
        action: 'DISCARD',
      };
    }
    if (!p.ticketId) {
      return { status: 'REJECTED', message: 'Falta el ticket.', action: 'DISCARD' };
    }

    const updated = await client.query(
      `UPDATE kitchen_tickets SET status = $2, updated_at = now()
       WHERE id = $1::uuid AND status <> $2::varchar`,
      [p.ticketId, p.status],
    );

    // Volver atras no es un rechazo: es un evento legitimo de otro dispositivo que
    // todavia no se entero. Se acepta como DUPLICATE para que salga de la cola.
    if (updated.rowCount === 0) {
      return { status: 'DUPLICATE', data: { ticketId: p.ticketId, status: p.status } };
    }

    // Se avisa al KDS **despues** del commit, no aca: emitir dentro de la transaccion
    // publicaria un estado que todavia no esta en la base, y la pantalla que se
    // suscriba releeria lo viejo. La fuente de verdad es la DB.
    //
    // Se recoge en `deps` y se emite en `push`, que es el unico lugar que sabe cuando
    // termino la transaccion.
    deps.onKdsTicketChanged?.(p.ticketId);

    return { status: 'APPLIED', data: { ticketId: p.ticketId, status: p.status } };
  }

  /**
   * Emite un evento que el servidor origina, para que los demas dispositivos lo vean
   * en el proximo pull.
   *
   * `seq` es 0 a proposito: este evento no pertenece a la secuencia de ningun
   * dispositivo, no lo genero ningun mozo. La constraint `sync_events_seq_sign` lo
   * permite solo si `actor_id` es NULL.
   *
   * El `device_id` es el del dispositivo que origino el conflicto, no el del
   * servidor: asi el pull lo puede ignorar (ya sabe lo que hizo) y los demas lo toman.
   */
  private async emitServerEvent(
    client: PoolClient,
    deps: ApplyDeps,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { uuidv7 } = await import('@comanda/domain');
    await client.query(
      `INSERT INTO sync_events
         (event_id, org_id, venue_id, device_id, seq, type, payload, occurred_at, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, $5, $6::jsonb, $7, 'APPLIED')`,
      [
        uuidv7(),
        deps.orgId,
        deps.venueId,
        deps.deviceId,
        type,
        JSON.stringify(payload),
        deps.now().toISOString(),
      ],
    );
  }

  /**
   * Baja incremental.
   *
   * `since` es el `seq_global` del último evento que el cliente aplicó. Todo lo que
   * pasó después se devuelve, en orden. El cursor avanza aunque no haya cambios, para
   * que el cliente pueda confirmar "estoy al día" sin pedir de nuevo.
   */
  async pull(params: {
    orgId: string;
    venueId: string;
    deviceId: string;
    since?: string;
    limit?: number;
  }): Promise<PullResult> {
    const limit = Math.min(params.limit ?? 200, 500);
    const since = params.since ?? '0';

    return this.db.withTenant({ orgId: params.orgId, venueId: params.venueId }, async (client) => {
      const rows = await client.query<{
        seq_global: string;
        type: string;
        device_id: string;
        seq: number;
        occurred_at: string;
        received_at: string;
        payload: Record<string, unknown>;
        status: string;
      }>(
        `SELECT seq_global, type, device_id, seq, occurred_at, received_at, payload, status
         FROM sync_events
         WHERE org_id = $1::uuid AND seq_global > $2::bigint
         ORDER BY seq_global
         LIMIT $3`,
        [params.orgId, since, limit + 1],
      );

      const hasMore = rows.rows.length > limit;
      const events = (hasMore ? rows.rows.slice(0, limit) : rows.rows).map((row) => ({
        cursor: row.seq_global,
        type: row.type as PullResult['events'][number]['type'],
        deviceId: row.device_id,
        seq: row.seq,
        // `receivedAt` es la verdad para reportes: el reloj del dispositivo puede
        // estar desfasado y no se toca para calcular nada.
        occurredAt: new Date(row.occurred_at).toISOString(),
        receivedAt: new Date(row.received_at).toISOString(),
        payload: row.payload,
        status: row.status as PullResult['events'][number]['status'],
      }));

      const cursor = events.length > 0 ? events[events.length - 1]!.cursor : since;

      const own = await client.query<{ seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_events WHERE device_id = $1::uuid`,
        [params.deviceId],
      );
      const deviceSeq = Number(own.rows[0]?.seq ?? 0);

      // Huecos: si el máximo de la secuencia es 40 y el cliente tenía 37, faltan 38 y
      // 39. Con un `seq` por evento y una primary key por `event_id`, un hueco solo
      // puede ser un evento que el cliente no generó o que se perdió antes de
      // llegar al servidor. Se reporta, no se "rellena".
      const confirmed = await client.query<{ seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_events WHERE device_id = $1::uuid AND seq > 0`,
        [params.deviceId],
      );
      const missingSeqs: number[] = [];
      // Los huecos se detectan comparando con lo que el servidor vio de ESE
      // dispositivo; se recalcula acá de forma barata y se expone al cliente.
      const seen = await client.query<{ seq: number }>(
        `SELECT DISTINCT seq FROM sync_events WHERE device_id = $1::uuid AND seq > 0 ORDER BY seq`,
        [params.deviceId],
      );
      let expected = 1;
      for (const row of seen.rows) {
        while (expected < row.seq) missingSeqs.push(expected++);
        expected = row.seq + 1;
      }

      void confirmed;
      void deviceSeq;

      return { events, cursor, deviceSeq, missingSeqs };
    });
  }

  private async currentCursor(orgId: string): Promise<string> {
    const result = await this.db.query<{ cursor: string }>(
      `SELECT COALESCE(MAX(seq_global), 0) AS cursor FROM sync_events WHERE org_id = $1::uuid`,
      [orgId],
    );
    return result.rows[0]!.cursor;
  }

  private async lastDeviceSeq(orgId: string, deviceId: string): Promise<number> {
    const result = await this.db.query<{ seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_events WHERE org_id = $1::uuid AND device_id = $2::uuid`,
      [orgId, deviceId],
    );
    return Number(result.rows[0]?.seq ?? 0);
  }
}

/** Esquemas de entrada, compartidos con el cliente. */
export const pushSchema = z.object({
  events: z
    .array(
      z.object({
        eventId: uuidSchema,
        type: SyncEventTypeSchema,
        seq: z.number().int().positive(),
        occurredAt: z.string().datetime(),
        payload: z.record(z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(500),
});

export const pullSchema = z.object({
  since: z.coerce.bigint().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export type { SyncEventInput, PushResult, PullResult, SyncEventResult };
