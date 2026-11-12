import {
  OrderStatus,
  type BillSplit,
  type Order,
  type OrderTotals,
  type Payment,
} from '@comanda/domain';
import { z } from 'zod';

/**
 * Contratos de entrada de comandas.
 *
 * Viven en el modulo y no en `@comanda/domain` a proposito: los esquemas de `domain`
 * son el formato de la replica y de la outbox (los corre el POS antes de subir), y
 * estos son peticiones de administracion de una comanda. Ver el mismo criterio en
 * `tables.types.ts`.
 *
 * Lo que **si** se reusa del dominio son los enums (`OrderStatus`, `OrderChannel`,
 * `PaymentMethod`) y los calculos (`orderTotals`, `split*`). Un contrato de entrada que
 * reimplementa un enum es un contrato que un dia diverge del que valida el POS.
 */

/** Tope de una pagina del listado. Acota el `LIMIT` y el tamano de la respuesta. */
export const ORDERS_PAGE_MAX = 100;

/**
 * Cuantos comensales se pueden sentar en una comanda.
 *
 * El dominio va a 60 (`orderSchema.guests`); aca se corta en 40, que es el tope de
 * `floorTableSchema.seats` y de `order_items.seat`. A mas comensales no hay mesa que
 * los siente ni item al que asignarlos, asi que el dato no seria utilizable.
 */
const GUESTS_MAX = 40;

const guests = z.number().int().min(1).max(GUESTS_MAX);

const course = z.number().int().min(1).max(9);
const seat = z.number().int().min(1).max(40);

const itemIds = z.array(z.string().uuid()).min(1, 'Mandá al menos un item.').max(100);

/**
 * Filtro del listado de comandas.
 *
 * `status` acepta **varios** estados (`?status=OPEN&status=PEDIDO_CUENTA`): el caso real
 * del mostrador es "las abiertas y las que pidieron la cuenta", que son dos estados y
 * una sola consulta. Con un enum singular habria que elegir uno y perder la otra mitad
 * de la pantalla.
 */
export const listOrdersQuerySchema = z.object({
  status: z
    .union([OrderStatus, z.array(OrderStatus)])
    .optional()
    .transform((value) => (value === undefined ? undefined : [value].flat())),
  tableId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(ORDERS_PAGE_MAX).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

/**
 * Apertura de comanda.
 *
 * `channel` es `QR` por defecto y no `POS` porque este endpoint es el camino **online**
 * (autopedido por QR y mostrador con red). El POS que opera offline abre comandas por el
 * sync, no por acá, y en el catalogo de eventos los dos caminos se distinguen ya.
 */
export const openOrderSchema = z.object({
  tableId: z.string().uuid().nullish(),
  guests: guests.default(1),
  channel: z.enum(['QR', 'POS', 'TAKEAWAY', 'DELIVERY']).default('QR'),
  /** Numero visible. Si no viene lo genera el servidor: ver `openOrder` del servicio. */
  numberLabel: z.string().trim().min(1).max(24).optional(),
});
export type OpenOrderInput = z.infer<typeof openOrderSchema>;

/** Un modificador elegido. Solo el id: el nombre y el precio los pone el servidor. */
export const chosenModifierSchema = z.object({
  modifierId: z.string().uuid(),
});
export type ChosenModifier = z.infer<typeof chosenModifierSchema>;

/**
 * Alta de item online.
 *
 * **No acepta `unitPriceCents`.** No es una omision: si el precio lo mandara el cliente,
 * el endpoint seria un `INSERT` con el importe que el cliente quiera. El precio sale del
 * catalogo, pasa por el motor de promociones y se guarda como snapshot en el item.
 *
 * Los modificadores tampoco aceptan `priceDeltaCents`: mandan el `modifierId` y el
 * servidor busca el nombre y eldelta. Un delta enviado por el cliente es la misma
 * manipulacion con un campo menos.
 */
export const addItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99).default(1),
  modifiers: z.array(chosenModifierSchema).max(20).default([]),
  course: course.default(1),
  seat: seat.nullish(),
  note: z.string().max(300).nullish(),
});
export type AddItemInput = z.infer<typeof addItemSchema>;

/**
 * Anulacion de item.
 *
 * El motivo es obligatorio y no un `.optional()` con un chequeo en el servicio: la
 * constraint `order_items_void_consistent` lo exige en la base, asi que si el motivo
 * llegara a faltar el `UPDATE` reventaria con un error de Postgres que el mozo no
 * entiende. Que lo exija el contrato hace que el error llegue antes y diga que hacer.
 */
export const voidItemSchema = z.object({
  reason: z
    .string({ required_error: 'Anular sin motivo no se permite.' })
    .trim()
    .min(1, 'Anular sin motivo no se permite.')
    .max(300),
});
export type VoidItemInput = z.infer<typeof voidItemSchema>;

/** Nota de la comanda. `null` la borra: una nota vacia es "no hay nota". */
export const orderNoteSchema = z.object({
  note: z.string().max(300).nullish(),
});
export type OrderNoteInput = z.infer<typeof orderNoteSchema>;

/** Asignacion de items a un curso. */
export const setCourseSchema = z.object({
  itemIds,
  course,
});
export type SetCourseInput = z.infer<typeof setCourseSchema>;

/** Asignacion de items a un comensal. */
export const setSeatSchema = z.object({
  itemIds,
  seat: seat.nullish(),
});
export type SetSeatInput = z.infer<typeof setSeatSchema>;

/** Cierre manual de la comanda (ademas del automatico al cubrir el total). */
export const closeOrderSchema = z.object({});
export type CloseOrderInput = z.infer<typeof closeOrderSchema>;

/** Transferencia a otra mesa. */
export const transferOrderSchema = z.object({
  toTableId: z.string().uuid(),
});
export type TransferOrderInput = z.infer<typeof transferOrderSchema>;

/**
 * Union de dos comandas.
 *
 * `intoOrderId` y no `fromOrderId`: quien pide la union dice adonde va, porque la
 * comanda que sobrevive es la que tiene la mesa y el mozo ya la tiene en pantalla.
 */
export const mergeOrdersSchema = z.object({
  intoOrderId: z.string().uuid(),
});
export type MergeOrdersInput = z.infer<typeof mergeOrdersSchema>;

/**
 * Propinas sugeridas: la lista de porcentajes llega como texto porque viaja en el query
 * string (`?bps=500,1000`). Se valida el formato aca y se convierte en basis points en el
 * servicio: el esquema de entrada y el de salida tienen que ser el mismo tipo para que el
 * `ZodValidationPipe` pueda garantizar el contrato.
 */
export const tipSuggestionsQuerySchema = z.object({
  bps: z
    .string()
    .regex(
      /^\d{1,5}(,\d{1,5}){0,5}$/,
      'Mandá hasta 6 porcentajes en basis points, separados por coma (ej: 500,1000,1500).',
    )
    .optional(),
});
export type TipSuggestionsQuery = z.infer<typeof tipSuggestionsQuerySchema>;

/** Porcentajes que se ofrecen cuando el local no dice los suyos. */
export const DEFAULT_TIP_BASIS_POINTS = [500, 1000, 1500] as const;

/** Una comanda del listado: todo lo que el POS necesita para pintar el ticket. */
export type OrderSummary = Order & {
  /** Nota de la comanda. No entra en el `Order` del dominio todavia. */
  note: string | null;
  paidCents: number;
  remainingCents: number;
  payments: Payment[];
};

/**
 * Comanda completa: la orden, sus totales, la cuenta y el turno en el que se cobra.
 *
 * `payments` y `splits` vienen porque la pantalla de cuenta los necesita siempre, y
 * `shift` porque "en qué caja se cobra esto" es la primera pregunta del arqueo. Todo en
 * una respuesta: con endpoint separados, pintar la cuenta son cuatro viajes de red y
 * los importes de cada uno pueden no ser los mismos si algo cambio entre ellos.
 */
export interface OrderDetail {
  order: Order;
  totals: OrderTotals;
  payments: Payment[];
  splits: BillSplit[];
  shift: OrderShift | null;
}

/**
 * Turno tal como lo ve el POS que cobra.
 *
 * Deliberadamente **sin** `expectedCashCents` ni `diffCents`: el arqueo es ciego, asi
 * que ningun endpoint del camino del cajero puede devolver esos numeros. Ver
 * `cash.service.ts`, que es donde esa regla se aplica de verdad.
 */
export interface OrderShift {
  id: string;
  venueId: string;
  openedAt: string;
  openingFloatCents: number;
  status: 'OPEN' | 'CLOSED';
}

/** Estados que aceptan items nuevos. */
export const OPEN_STATUSES = [
  'OPEN',
  'PEDIDO_CUENTA',
  'PENDIENTE_APROBACION',
] as const satisfies readonly OrderStatus[];
