import { SplitError, orderTotals, type OrderTotals } from '@comanda/domain';
import type { PoolClient } from 'pg';

/**
 * Nucleo de la comanda: el total, el turno abierto y la mesa.
 *
 * Estas operaciones ya existen en `sync.service.ts` y hacen falta **exactamente igual**
 * en los modulos de ordenes y de pagos. Duplicarlas era peor que repetirlas: el dia que
 * el total se calculara de una forma en el sync y de otra en el endpoint online, el mozo
 * veria un total y el sistema cobraria otro, y el diagnostico seria "la base esta mal"
 * cuando el problema son dos lineas de codigo.
 *
 * Por eso viven aca y las usan los dos caminos. No es un servicio de Nest: son funciones
 * que reciben el `PoolClient` de la transaccion que ya abrio el que llama, para que la
 * composicion de la transaccion siga siendo del servicio.
 */

/** Una parte de un reparto, en la forma minima que necesita la validacion. */
export interface SplitPart {
  amountCents: number;
}

/**
 * Verifica que las partes de un reparto sumen el total de la comanda.
 *
 * Se extrae del handler `SPLIT_SAVED` del sync y la usan tambien el endpoint de
 * division: son la misma regla y el mismo mensaje, porque el mozo tiene que ver la
 * misma explicacion si la division la hizo la tablet o el servidor.
 *
 * Lanza `SplitError` (del dominio) y no una excepcion HTTP: el sync la convierte en
 * `REJECTED` y el endpoint en un 422. La regla no sabe quien la esta invocando.
 */
export function assertSplitCoversTotal(parts: readonly SplitPart[], totalCents: number): void {
  const allocated = parts.reduce((acc, part) => acc + part.amountCents, 0);

  if (allocated !== totalCents) {
    // El mensaje dice los dos numeros porque es lo que el mozo necesita ver para
    // corregir el reparto, no un codigo.
    throw new SplitError(`El reparto suma ${allocated} y la cuenta tiene ${totalCents} centavos.`);
  }
}

/**
 * Totales de la comanda, tal como los ve el POS.
 *
 * Es `orderTotals()` del dominio alimentado con lo que hay en la base: los items con
 * sus modificadores, el descuento y la tasa de servicio de la comanda, la propina y lo
 * ya pagado. Es la MISMA funcion que corre la replica local del POS, y por eso el
 * total que muestra la tablet y el que cobra el servidor son el mismo numero.
 */
export async function computeOrderTotals(
  client: PoolClient,
  orderId: string,
  options: { lock?: boolean } = {},
): Promise<OrderTotals> {
  const order = await client.query<{
    discount_cents: number;
    service_bps: number;
    tip_cents: number;
  }>(
    // `FOR UPDATE` solo cuando el llamador va a escribir: la fila de la comanda es la
    // que todos los caminos tocan (items, propina, cobro) y dos escrituras
    // simultaneas sobre el total son la forma de que `total_cents` quede con el
    // promedio de dos estados que nunca existieron.
    `SELECT discount_cents, service_bps, tip_cents
       FROM orders WHERE id = $1::uuid${options.lock ? ' FOR UPDATE' : ''}`,
    [orderId],
  );
  if (order.rows.length === 0) return emptyTotals();

  const items = await client.query<{
    unit_price_cents: number;
    quantity: number;
    status: string;
    delta: string | null;
  }>(
    `SELECT oi.unit_price_cents, oi.quantity, oi.status, m.delta
       FROM order_items oi
       LEFT JOIN (
         SELECT order_item_id, SUM(price_delta_cents)::text AS delta
           FROM order_item_modifiers GROUP BY order_item_id
       ) m ON m.order_item_id = oi.id
      WHERE oi.order_id = $1::uuid`,
    [orderId],
  );

  const paid = await client.query<{ paid: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::text AS paid
       FROM payments
      WHERE order_id = $1::uuid AND status = 'APPROVED'`,
    [orderId],
  );

  const params = order.rows[0]!;
  return orderTotals({
    items: items.rows.map((row) => ({
      unitPriceCents: row.unit_price_cents,
      quantity: row.quantity,
      status: row.status === 'ACTIVE' ? ('ACTIVE' as const) : ('VOIDED' as const),
      modifiers: [{ priceDeltaCents: Number(row.delta ?? 0) }],
    })),
    // La moneda no se usa en el calculo: los totales son enteros y la moneda solo hace
    // falta para formatear. Se pasa la del local.
    currency: 'XXX',
    discountCents: params.discount_cents,
    serviceBps: params.service_bps,
    tipCents: params.tip_cents,
    paidCents: Number(paid.rows[0]?.paid ?? 0),
  });
}

function emptyTotals(): OrderTotals {
  return {
    subtotalCents: 0,
    discountCents: 0,
    serviceCents: 0,
    tipCents: 0,
    totalCents: 0,
    paidCents: 0,
    remainingCents: 0,
  };
}

/**
 * Recalcula el total cacheado de la comanda.
 *
 * Se recalcula SIEMPRE desde los items con `orderTotals()` del dominio, la misma
 * funcion que corre el POS sobre su replica local. No se reimplementa la suma en SQL:
 * dos implementaciones del mismo calculo divergen, y cuando divergen el mozo ve un
 * total y el sistema cobra otro.
 *
 * El descuento y la tasa de servicio se leen de la propia comanda, no del evento que
 * dispara el recalculo: son parte del estado de la orden, y asi el resultado no depende
 * de en que orden lleguen las cosas.
 */
export async function refreshOrderTotal(client: PoolClient, orderId: string): Promise<void> {
  const totals = await computeOrderTotals(client, orderId, { lock: true });
  await client.query(`UPDATE orders SET total_cents = $2, updated_at = now() WHERE id = $1::uuid`, [
    orderId,
    totals.totalCents,
  ]);
}

/**
 * Resuelve el turno abierto del local.
 *
 * Existe por una constraint, no por capricho: `orders_closed_consistent` exige
 * `shift_id NOT NULL` para cerrar una comanda. Sin resolverla aca, el `UPDATE` revienta
 * la constraint y, en el peor caso, la mesa queda ocupada para siempre con el cobro ya
 * hecho.
 *
 * El turno se resuelve en el servidor y no se confia en el payload porque es un hecho
 * autoritativo: hay a lo sumo uno abierto por local (indice unico parcial), asi que no
 * hay ambiguedad de cual elegir.
 */
export async function resolveOpenShift(
  client: PoolClient,
  venueId: string,
): Promise<string | null> {
  const shift = await client.query<{ id: string }>(
    `SELECT id FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN' LIMIT 1`,
    [venueId],
  );
  return shift.rows[0]?.id ?? null;
}

/**
 * Libera una mesa.
 *
 * Va en su propio metodo porque la misma operacion aparece al cerrar, al cancelar y al
 * transferir, y las tres tienen que dejar la mesa exactamente igual de libre: los tres
 * campos se escriben juntos y nunca uno solo, porque `tables_occupied_consistent` cubre
 * una sola direccion (ocupada implica comanda) y la inversa la cubre esta app.
 */
export async function freeTable(client: PoolClient, tableId: string): Promise<void> {
  await client.query(
    `UPDATE tables
        SET status = 'LIBRE', order_id = NULL, occupied_since = NULL, updated_at = now()
      WHERE id = $1::uuid`,
    [tableId],
  );
}
