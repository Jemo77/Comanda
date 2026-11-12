import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ERROR_CODES,
  SplitError,
  billSplitSchema,
  problemDetails,
  suggestedTips,
  splitByAmount,
  splitByItem,
  splitEqual,
  uuidv7,
  type BillSplit,
  type OrderTotals,
  type Payment,
} from '@comanda/domain';
import type { PoolClient } from 'pg';
import type { Database } from '../../database/database.service';
// Import de VALOR a proposito: `emitDecoratorMetadata` escribe la clase real del
// segundo argumento del constructor en `design:paramtypes`, y con `import type` la clase se
// borra en tiempo de compilacion y Nest recibe `Function`. Ver el mismo comentario en
// `sync.service.ts`.
import { AuditService } from '../audit/audit.service';
import {
  assertSplitCoversTotal,
  computeOrderTotals,
  freeTable,
  refreshOrderTotal,
} from '../orders/order-state';
import { notFound, noOpenShift } from '../orders/orders.service';
import type { AddTipInput, PayInput, SplitBillInput } from './payments.types';

/**
 * Cobro: pagos, division de cuenta y propinas.
 *
 * Dos reglas atraviesan todo el modulo y las dos son de dinero:
 *
 *  1. **La API nunca ve datos de tarjeta.** `CARD`, `QR` y `TRANSFER` son pagos externos:
 *     el POS habla con la terminal o con la pasarela y despues manda el comprobante. Lo
 *     unico que se guarda es `provider_ref`. No hay ningun campo en el contrato, ni en la
 *     tabla, que pueda contener un PAN (PLAN §6, PCI).
 *
 *  2. **Cobrar es idempotente.** Un `Idempotency-Key` obligatorio va al
 *     `payments.source_event_id`, que tiene indice unico. Repetir el request devuelve el
 *     mismo resultado sin cobrar de nuevo: si el POS reintenta porque la respuesta se perdio
 *     en el camino, un cobro duplicado hay que devolverlo con plata ajena y el turno ya
 *     cerro.
 */

/** Quien cobro. La atribucion viaja al registro de auditoria. */
export interface PaymentActor {
  userId: string;
  name: string;
  deviceId?: string | null;
}

/**
 * Margen que se acepta sin motivo.
 *
 * **Cero.** Un peso de mas sin motivo es indistinguible de un error de caja, y el arqueo
 * del turno lo muestra como diferencia sin poder explicarla. Lo que el POS puede hacer es
 * mandar la propina, que si queda auditada y con su motivo natural (el cliente la dejo).
 */
export const OVERPAY_TOLERANCE_CENTS = 0;

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

interface SplittableRow {
  id: string;
  name_snapshot: string;
  amount_cents: number;
  seat: number | null;
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cobro
  // ---------------------------------------------------------------------------

  /**
   * Cobra una comanda, en mixto o en un solo metodo.
   *
   * El orden dentro de la transaccion es el que hace que esto sea idempotente:
   *
   *  1. Se bloquea la comanda (`FOR UPDATE`), asi que dos reintentos del mismo request se
   *     serializan en vez de competir.
   *  2. Se busca el `Idempotency-Key` entre los pagos. Si ya esta, el request es un reenvio
   *     y se devuelve el cobro ya registrado **antes de mirar cualquier otra cosa**: el
   *     primer request ya cerro la comanda, asi que un chequeo de estado despues devolveria
   *     un 409 en vez de la respuesta que el POS esta esperando.
   *  3. Se validan los importes **contra el total**, no contra lo que el cliente cree que
   *     debe, y se insertan las lineas.
   *  4. Se cierra la comanda si quedo cubierta.
   *
   * El `ON CONFLICT (source_event_id) DO NOTHING` de la primera linea es la garantia final:
   * la preconsulta del paso 2 no cierra la ventana entre dos requests que llegan juntos, y
   * el indice unico parcial es el que dice que paso de verdad. El que pierde devuelve el
   * cobro del otro en vez de duplicar el cobro.
   *
   * La propina se guarda entera en la **primera** linea. No es arbitrario: asi se mantiene
   * `SUM(payments.tip_cents) = orders.tip_cents`, que es lo que permite auditar la propina
   * sin recalcularla. Repartirla entre metodos seria una politica del local (pool, por
   * mozo) que todavia no existe, y decidirla aca seria inventar una.
   *
   * El pago NO suma al total de la comanda: el total es lo que se debe y ya esta calculado
   * desde los items. Lo que se acumula es lo pagado, y lo que falta se deriva restando.
   * Sumarlos mezclados haria que el arqueo del turno no cerrara nunca.
   */
  async pay(
    orgId: string,
    venueId: string,
    orderId: string,
    input: PayInput,
    actor: PaymentActor,
    idempotencyKey: string,
  ): Promise<{
    payments: Payment[];
    totals: OrderTotals;
    closed: boolean;
    replay: boolean;
    /** Ids de las lineas de este request. No viaja al cliente: es para la auditoria. */
    chargedIds: string[];
  }> {
    const result = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const order = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM orders WHERE id = $1::uuid AND venue_id = $2::uuid FOR UPDATE`,
        [orderId, venueId],
      );

      const found = order.rows[0];
      if (!found) throw notFound('Esa comanda no existe en este local.');

      // El reenvio se resuelve **antes** de mirar el estado de la comanda, y por el mismo
      // motivo que en la apertura: el primer request ya cerro la comanda, asi que el
      // segundo se encontraria con un 409 de "comanda cerrada" en vez de con su propio
      // cobro. Un reintento despues de un timeout tiene que devolver el resultado, no un
      // error que no dice que paso.
      const previo = await tx.query<{ order_id: string }>(
        `SELECT order_id FROM payments WHERE source_event_id = $1::uuid`,
        [idempotencyKey],
      );
      if (previo.rows.length > 0) {
        if (previo.rows[0]!.order_id !== orderId) {
          throw new ConflictException(
            problemDetails({
              status: 409,
              code: ERROR_CODES.CONFLICT,
              detail: 'Esa clave de idempotencia ya se usó en el cobro de otra comanda.',
            }),
          );
        }
        return this.replay(tx, venueId, orderId);
      }

      if (found.status === 'CLOSED' || found.status === 'CANCELLED') {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'La comanda ya está cerrada: no se puede cobrar.',
          }),
        );
      }

      // La caja abierta se resuelve **antes** de cobrar. Un pago fuera de un turno es
      // plata que el arqueo ciego no puede ver: el conteo del turno saldria bien y el del
      // local no, que es el peor de los dos mundos.
      const shift = await tx.query<{ id: string }>(
        `SELECT id FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN' LIMIT 1`,
        [venueId],
      );
      const shiftId = shift.rows[0]?.id;
      if (!shiftId) throw noOpenShift('cobrar');

      // La propina se suma antes de validar: el cliente la deja sobre la cuenta, asi que
      // forma parte de lo que hay que cubrir.
      if (input.tipCents > 0) {
        await tx.query(
          `UPDATE orders SET tip_cents = tip_cents + $2, updated_at = now()
            WHERE id = $1::uuid`,
          [orderId, input.tipCents],
        );
        await refreshOrderTotal(tx, orderId);
      }

      // Los totales se leen **antes** de insertar cualquier pago: si se leyeran despues, el
      // propio cobro recien insertado contaria como pagado y el restante saldria negativo,
      // que es exactamente el caso que dispara el error de "pago de mas".
      const before = await computeOrderTotals(tx, orderId);
      const paidCents = input.lines.reduce((acc, line) => acc + line.amountCents, 0);
      const remaining = assertCoversTotal(before, paidCents, input.overpayReason);

      // Los ids de las lineas de **este** request: la auditoria tiene que hablar de lo que
      // se acaba de cobrar, no de todos los pagos de la comanda.
      const cobrados: string[] = [];

      // La primera linea lleva la clave de idempotencia. Las demas quedan en NULL porque
      // el indice es unico: si las dos la llevaran, la segunda no podria insertarse nunca.
      const inserted = await tx.query<PaymentRow>(
        `INSERT INTO payments
           (id, org_id, order_id, method, amount_cents, tip_cents, provider, provider_ref,
            status, shift_id, received_by, source_event_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, 'APPROVED', $9::uuid, $10::uuid,
                 $11::uuid)
         ON CONFLICT (source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
         RETURNING id, order_id, method, amount_cents, tip_cents, provider, provider_ref,
                   status, shift_id, created_at`,
        [
          uuidv7(),
          orgId,
          orderId,
          input.lines[0]!.method,
          input.lines[0]!.amountCents,
          input.tipCents,
          input.lines[0]!.provider ?? null,
          input.lines[0]!.providerRef ?? null,
          shiftId,
          actor.userId,
          idempotencyKey,
        ],
      );

      // La preconsulta no alcanza sola: dos requests con la misma clave pueden pasar las
      // dos antes de que ninguno inserte. El indice unico decide, y el que pierde devuelve
      // el cobro del otro en vez de duplicarlo.
      if (inserted.rows.length === 0) return this.replay(tx, venueId, orderId);
      cobrados.push(inserted.rows[0]!.id);

      // El resto de las lineas. Se insertan recien despues de validar el total: si el cobro
      // no cuadra, la exception revierte la transaccion entera y no queda un cobro de
      // efectivo sin el de tarjeta que lo acompanaba.
      for (const line of input.lines.slice(1)) {
        const extra = await tx.query<{ id: string }>(
          `INSERT INTO payments
             (id, org_id, order_id, method, amount_cents, tip_cents, provider, provider_ref,
              status, shift_id, received_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 0, $6, $7, 'APPROVED', $8::uuid, $9::uuid)
           RETURNING id`,
          [
            uuidv7(),
            orgId,
            orderId,
            line.method,
            line.amountCents,
            line.provider ?? null,
            line.providerRef ?? null,
            shiftId,
            actor.userId,
          ],
        );
        cobrados.push(extra.rows[0]!.id);
      }

      let closed = false;
      if (remaining <= OVERPAY_TOLERANCE_CENTS) {
        // Cierra y libera la mesa en el mismo `UPDATE ... RETURNING`: la mesa de origen
        // sale de la fila que se acaba de cerrar, asi que no hace falta una segunda
        // consulta y no puede quedar una comanda cerrada con la mesa ocupada.
        const close = await tx.query<{ table_id: string | null }>(
          `UPDATE orders
              SET status = 'CLOSED', closed_at = now(), shift_id = $2::uuid,
                  source_device_id = $3::uuid, updated_at = now()
            WHERE id = $1::uuid AND status NOT IN ('CLOSED','CANCELLED')
          RETURNING table_id`,
          [orderId, shiftId, actor.deviceId ?? null],
        );

        if (close.rows[0]?.table_id) await freeTable(tx, close.rows[0].table_id);
        closed = close.rows.length > 0;
      }

      return {
        payments: await paymentsOfOrder(tx, orderId),
        totals: await computeOrderTotals(tx, orderId),
        closed,
        replay: false,
        chargedIds: cobrados,
      };
    });

    if (result.replay) return result;

    for (const payment of result.payments.filter((p) => result.chargedIds.includes(p.id))) {
      await this.audit.record({
        orgId,
        venueId,
        actorId: actor.userId,
        actorName: actor.name,
        deviceId: actor.deviceId ?? null,
        action: 'bill.paid',
        entity: 'payment',
        entityId: payment.id,
        after: {
          orderId,
          method: payment.method,
          amountCents: payment.amountCents,
          tipCents: payment.tipCents,
          // Solo la referencia del proveedor, nunca el dato de la tarjeta: el registro de
          // auditoria se lee mas que la base.
          provider: payment.provider,
          providerRef: payment.providerRef,
        },
      });
    }

    return result;
  }

  /**
   * Lo que falta cobrar.
   *
   * Es una lectura, no una cuenta persistida: `total - pagado`, en enteros, con
   * `orderTotals()` del dominio. Persistirlo seria un segundo numero que puede quedar viejo
   * y que el POS mostraria al lado del correcto.
   */
  async remainingToPay(
    orgId: string,
    venueId: string,
    orderId: string,
  ): Promise<OrderTotals & { orderId: string }> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const existe = await tx.query<{ id: string }>(
        `SELECT id FROM orders WHERE id = $1::uuid AND venue_id = $2::uuid`,
        [orderId, venueId],
      );
      if (existe.rows.length === 0) throw notFound('Esa comanda no existe en este local.');

      return { orderId, ...(await computeOrderTotals(tx, orderId)) };
    });
  }

  // ---------------------------------------------------------------------------
  // Division de cuenta
  // ---------------------------------------------------------------------------

  /**
   * Guarda el reparto de la cuenta.
   *
   * El reparto se **calcula una vez y se persiste**. Si se recalculara en cada pantalla,
   * dos personas pueden ver importes distintos para la misma mesa, que es exactamente el
   * reclamo que hace una mesa de seis.
   *
   * El calculo, cuando viene pedido, es del dominio (`splitEqual`, `splitByItem`,
   * `splitByAmount`): reparto en aritmetica entera, con el centavo de mas asignado a la
   * primera parte, y por eso las partes siempre suman el total. Cuando el cliente manda las
   * partes ya calculadas se guardan tal cual (es el caso de `SPLIT_SAVED` del sync) y lo
   * unico que se valida es que sumen el total.
   */
  async splitBill(
    orgId: string,
    venueId: string,
    orderId: string,
    input: SplitBillInput,
    actor: PaymentActor,
  ): Promise<BillSplit> {
    const saved = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const found = await tx.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1::uuid AND venue_id = $2::uuid`,
        [orderId, venueId],
      );
      const order = found.rows[0];
      if (!order) throw notFound('Esa comanda no existe en este local.');
      if (order.status === 'CLOSED' || order.status === 'CANCELLED') {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'La comanda ya está cerrada: no se puede dividir.',
          }),
        );
      }

      const totals = await computeOrderTotals(tx, orderId);
      const parts = input.allocations
        ? input.allocations.map((part) => ({
            label: part.label,
            amountCents: part.amountCents,
            itemIds: part.itemIds,
          }))
        : await this.computeParts(tx, orderId, input);

      try {
        // La misma validacion que hace el sync en `SPLIT_SAVED`, con el mismo mensaje:
        // extraida a `order-state.ts` para que las dos rutas no puedan divergir.
        assertSplitCoversTotal(parts, totals.totalCents);
      } catch (error) {
        if (error instanceof SplitError) throw unbalanced(error.message);
        throw error;
      }

      const id = uuidv7();
      // El `id` de cada parte se genera aca y no lo manda el cliente: el esquema del dominio
      // lo exige como uuid y es la identidad con la que la pantalla marca "esta parte ya se
      // pago" mas adelante.
      const allocations = parts.map((part) => ({
        id: uuidv7(),
        label: part.label,
        amountCents: part.amountCents,
        itemIds: part.itemIds,
        paid: false,
      }));

      await tx.query(
        `INSERT INTO bill_splits (id, org_id, order_id, mode, allocations, total_cents, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7::uuid)`,
        [
          id,
          orgId,
          orderId,
          input.mode,
          JSON.stringify(allocations),
          totals.totalCents,
          actor.userId,
        ],
      );

      await this.audit.record({
        orgId,
        venueId,
        actorId: actor.userId,
        actorName: actor.name,
        deviceId: actor.deviceId ?? null,
        action: 'bill.split',
        entity: 'bill_split',
        entityId: id,
        after: {
          orderId,
          mode: input.mode,
          parts: allocations.length,
          totalCents: totals.totalCents,
        },
      });

      return billSplitSchema.parse({
        id,
        orderId,
        mode: input.mode,
        allocations,
        totalCents: totals.totalCents,
      });
    });

    return saved;
  }

  // ---------------------------------------------------------------------------
  // Propinas
  // ---------------------------------------------------------------------------

  /**
   * Suma propina a la comanda.
   *
   * Porcentaje o importe, nunca los dos. El importe en basis points lo redondea
   * `suggestedTips()` del dominio: un 10% de $33.33 son $3.33, no $3.333, y el redondeo lo
   * tiene que hacer la misma funcion que corre el POS offline.
   *
   * Va como operacion propia y no como parte del pago porque la propina se carga despues de
   * enunciar la cuenta: el total ya estaba dicho al cliente y la propina se agrega encima.
   */
  async addTip(
    orgId: string,
    venueId: string,
    orderId: string,
    input: AddTipInput,
  ): Promise<{ orderId: string; tipCents: number; totals: OrderTotals }> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const found = await tx.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1::uuid AND venue_id = $2::uuid FOR UPDATE`,
        [orderId, venueId],
      );
      const order = found.rows[0];
      if (!order) throw notFound('Esa comanda no existe en este local.');
      if (order.status === 'CLOSED' || order.status === 'CANCELLED') {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'La comanda ya está cerrada: la propina ya se cobró con ella.',
          }),
        );
      }

      const tipCents =
        input.tipCents ??
        suggestedTips((await computeOrderTotals(tx, orderId)).totalCents, [input.basisPoints!])[0]!
          .cents;

      if (tipCents === 0) {
        return { orderId, tipCents: 0, totals: await computeOrderTotals(tx, orderId) };
      }

      await tx.query(
        `UPDATE orders SET tip_cents = tip_cents + $2, updated_at = now() WHERE id = $1::uuid`,
        [orderId, tipCents],
      );
      // El total incluye la propina: sin recalcular, `total_cents` y `tip_cents` dicen
      // cosas distintas y el cobro sale mal.
      await refreshOrderTotal(tx, orderId);

      return { orderId, tipCents, totals: await computeOrderTotals(tx, orderId) };
    });
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /**
   * Reparto calculado por el servidor.
   *
   * Los items van con su subtotal **ya con modificadores** (`splitByItem` reparte lineas, no
   * centavos sueltos) y sin los anulados: un item anulado no se cobra y por lo tanto no se
   * reparte. Incluirlo haria que las partes sumen mas que la cuenta.
   */
  private async computeParts(
    tx: PoolClient,
    orderId: string,
    input: SplitBillInput,
  ): Promise<Array<{ label: string; amountCents: number; itemIds: string[] }>> {
    // Los casts a `int` del SELECT no son cosmeticos: un `SUM()` devuelve `bigint`, que
    // `pg` entrega como texto, y `splitEqual` rechaza un importe que no sea entero. Sin el
    // cast, la pantalla de division de cuenta falla con "el importe del item no es un
    // entero" sin que haya ningun item visible todavia.
    const items = await tx.query<SplittableRow>(
      `SELECT oi.id, oi.name_snapshot, oi.seat,
              (oi.unit_price_cents
                 + COALESCE((SELECT SUM(price_delta_cents)::int
                               FROM order_item_modifiers
                              WHERE order_item_id = oi.id), 0)) * oi.quantity::int AS amount_cents
         FROM order_items oi
        WHERE oi.order_id = $1::uuid AND oi.status = 'ACTIVE'
        ORDER BY oi.created_at, oi.id`,
      [orderId],
    );

    const splittable = {
      currency: 'XXX',
      items: items.rows.map((row) => ({
        id: row.id,
        name: row.name_snapshot,
        amountCents: row.amount_cents,
        seat: row.seat,
      })),
    };

    switch (input.mode) {
      case 'EQUAL': {
        if (input.parts === undefined) {
          throw new BadRequestException(
            problemDetails({
              status: 400,
              code: ERROR_CODES.VALIDATION_FAILED,
              detail: 'Para dividir en partes iguales mandá cuántos comensales son.',
              errors: [{ path: 'parts', message: 'Cantidad de partes obligatoria en modo EQUAL.' }],
            }),
          );
        }

        return splitEqual(splittable, input.parts).map(toPart);
      }
      case 'BY_ITEM': {
        if (splittable.items.length === 0) {
          throw new UnprocessableEntityException(
            problemDetails({
              status: 422,
              code: ERROR_CODES.VALIDATION_FAILED,
              detail: 'La comanda no tiene ítems para dividir.',
            }),
          );
        }
        return splitByItem(splittable).map(toPart);
      }
      case 'AMOUNT': {
        const amounts = input.amounts;
        if (!amounts || amounts.length !== splittable.items.length) {
          throw new BadRequestException(
            problemDetails({
              status: 400,
              code: ERROR_CODES.VALIDATION_FAILED,
              detail: `Mandá un importe por ítem: la comanda tiene ${splittable.items.length}.`,
              errors: [
                { path: 'amounts', message: 'La lista de importes no coincide con los ítems.' },
              ],
            }),
          );
        }

        const manual = splitByAmount(splittable, amounts);
        if (!manual.balanced) {
          // El control va **antes** del cobro: si los montos escritos no dan el total, la
          // pantalla tiene que decirlo en el momento. Descubrirlo cuando el cliente ya se
          // fue es la peor forma de descuadrar una mesa.
          throw new UnprocessableEntityException(
            problemDetails({
              status: 422,
              code: ERROR_CODES.VALIDATION_FAILED,
              detail:
                manual.differenceCents === 0
                  ? 'Alguna parte quedó en cero: todos los importes tienen que ser mayores que cero.'
                  : `El reparto escrito difiere del total en ${manual.differenceCents} centavos.`,
            }),
          );
        }

        return manual.allocations.map(toPart);
      }
      default:
        throw new UnprocessableEntityException(
          problemDetails({
            status: 422,
            code: ERROR_CODES.VALIDATION_FAILED,
            detail: 'Modo de división desconocido.',
          }),
        );
    }
  }

  /**
   * Reenvio del mismo cobro.
   *
   * No recalcula nada ni vuelve a auditar: devuelve los pagos que ya estan registrados. Es
   * lo que hace que "reintentamos hasta que funcione" no sea una forma de cobrar dos veces,
   * que es el unico modo de falla que en este dominio cuesta plata.
   */
  private async replay(
    tx: PoolClient,
    venueId: string,
    orderId: string,
  ): Promise<{
    payments: Payment[];
    totals: OrderTotals;
    closed: boolean;
    replay: boolean;
    chargedIds: string[];
  }> {
    const totals = await computeOrderTotals(tx, orderId);
    const order = await tx.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1::uuid AND venue_id = $2::uuid`,
      [orderId, venueId],
    );

    return {
      payments: await paymentsOfOrder(tx, orderId),
      totals,
      closed: order.rows[0]?.status === 'CLOSED',
      replay: true,
      // Nada que auditar: en un reenvio no se cobro nada nuevo, y volver a escribir el
      // registro haria que "cuanto se cobro" dependiera de cuantas veces reintento el POS.
      chargedIds: [],
    };
  }
}

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

/**
 * Valida que el pago cubra la cuenta y devuelve lo que queda.
 *
 * "Cubrir" es `pagado - restante >= -tolerancia`, con tolerancia **cero**. Un peso de mas
 * sin motivo es indistinguible de un error de caja, y al arqueo no hay forma de
 * explicarlo: el unico que sabe si fue un cambio mal dado o una diferencia de mas es el
 * que escribe el motivo.
 */
function assertCoversTotal(
  totals: OrderTotals,
  paidCents: number,
  overpayReason: string | undefined,
): number {
  const remaining = totals.totalCents - (totals.paidCents + paidCents);

  if (remaining > 0) {
    throw new UnprocessableEntityException(
      problemDetails({
        status: 422,
        code: ERROR_CODES.VALIDATION_FAILED,
        detail: `El pago no cubre la cuenta: faltan ${remaining} centavos.`,
        errors: [{ path: 'lines', message: 'El importe pagado es menor que el total.' }],
      }),
    );
  }

  const excess = -remaining - OVERPAY_TOLERANCE_CENTS;
  if (excess > 0 && !overpayReason) {
    throw new UnprocessableEntityException(
      problemDetails({
        status: 422,
        code: ERROR_CODES.VALIDATION_FAILED,
        detail: `El pago excede la cuenta por ${excess} centavos: hace falta un motivo.`,
        errors: [{ path: 'overpayReason', message: 'Cobrar de más exige un motivo.' }],
      }),
    );
  }

  return remaining;
}

async function paymentsOfOrder(tx: PoolClient, orderId: string): Promise<Payment[]> {
  const result = await tx.query<PaymentRow>(
    `SELECT id, order_id, method, amount_cents, tip_cents, provider, provider_ref,
            status, shift_id, created_at
       FROM payments
      WHERE order_id = $1::uuid AND status = 'APPROVED'
      ORDER BY created_at, id`,
    [orderId],
  );

  return result.rows.map((row) => ({
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
  }));
}

function toPart(allocation: { label: string; amount: { cents: number }; itemIds: string[] }): {
  label: string;
  amountCents: number;
  itemIds: string[];
} {
  return {
    label: allocation.label,
    amountCents: allocation.amount.cents,
    itemIds: allocation.itemIds,
  };
}

function unbalanced(detail: string): UnprocessableEntityException {
  return new UnprocessableEntityException(
    problemDetails({ status: 422, code: ERROR_CODES.VALIDATION_FAILED, detail }),
  );
}
