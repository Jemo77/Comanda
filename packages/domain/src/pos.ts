import { z } from 'zod';
import { money, type Money } from './money';

/**
 * Contratos del POS: catálogo, salón, comanda, cuenta, caja y cocina.
 *
 * Estos esquemas son la frontera compartida entre la API y el POS. No son solo
 * validación de entrada: son el **formato de la replica local** y el del payload
 * de la outbox. Que el mismo Zod describa las tres cosas es lo que hace posible
 * que el POS valide antes de subir y que el servidor no tenga quetranslationar.
 *
 * Tres reglas que atraviesan todo el archivo:
 *
 *  1. **Dinero es entero.** `priceCents`, `amountCents`, `tipCents`. No hay un
 *     solo float en un contrato de cobro.
 *  2. **Snapshot, no referencia.** Un ítem guarda el nombre y el precio del
 *     momento en que se agrego. Dentro de seis meses el producto puede haberse
 *     renombrado o borrado, y el ticket tiene que seguir diciendo lo que se pidió.
 *  3. **Append-only.** Un ítem no se borra: se anula, con motivo, quién y cuándo.
 */

// -----------------------------------------------------------------------------
// Enumeraciones del POS
// -----------------------------------------------------------------------------

/** Canal de la comanda. `POS` es el mostrador; los demás llegan por otros lados. */
export const ORDER_CHANNELS = ['POS', 'QR', 'TAKEAWAY', 'DELIVERY'] as const;
export const OrderChannel = z.enum(ORDER_CHANNELS);
export type OrderChannel = z.infer<typeof OrderChannel>;

/**
 * Estados de la comanda. `PEDIDO_CUENTA` es un estado, no una acción pendiente:
 * el mozo lo marca cuando alguien pide la cuenta y esa comanda deja de aceptar
 * ítems nuevos.
 */
export const ORDER_STATUSES = [
  'OPEN',
  'PEDIDO_CUENTA',
  'CLOSED',
  'CANCELLED',
  'PENDIENTE_APROBACION',
] as const;
export const OrderStatus = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatus>;

/**
 * Estados de mesa. `BLOQUEADA` es distinta de `RESERVADA`: bloqueada es "no la
 * uses" (mesa rota, en limpieza), reservada es "ya tiene nombre y hora".
 */
export const TABLE_STATUSES = [
  'LIBRE',
  'OCUPADA',
  'PIDIO_CUENTA',
  'RESERVADA',
  'BLOQUEADA',
] as const;
export const TableStatus = z.enum(TABLE_STATUSES);
export type TableStatus = z.infer<typeof TableStatus>;

/**
 * Estados de cocina. El ciclo es NEW -> PREPARANDO -> LISTO, y SERVED es el
 * cierre. Se separa PREPARING de LISTO porque son dos personas distintas: el que
 * cocina y el que lleva la bandeja.
 */
export const KITCHEN_STATUSES = ['NEW', 'PREPARING', 'READY', 'SERVED'] as const;
export const KitchenStatus = z.enum(KITCHEN_STATUSES);
export type KitchenStatus = z.infer<typeof KitchenStatus>;

/**
 * Metodos de pago. `CARD` es "pago externo": la API nunca ve el numero de
 * tarjeta (PLAN §6, PCI), solo el comprobante del terminal.
 */
export const PAYMENT_METHODS = ['CASH', 'CARD', 'QR', 'TRANSFER'] as const;
export const PaymentMethod = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

/** Modos de division de cuenta. */
export const SPLIT_MODES = ['BY_ITEM', 'EQUAL', 'AMOUNT'] as const;
export const SplitMode = z.enum(SPLIT_MODES);
export type SplitMode = z.infer<typeof SplitMode>;

/** Tipos de movimiento de efectivo. `IN` suma; `OUT` y `RETIRO` restan. */
export const CASH_MOVEMENT_TYPES = ['IN', 'OUT', 'RETIRO'] as const;
export const CashMovementType = z.enum(CASH_MOVEMENT_TYPES);
export type CashMovementType = z.infer<typeof CashMovementType>;

// -----------------------------------------------------------------------------
// Catálogo
// -----------------------------------------------------------------------------

/**
 * Estación de trabajo: barra, cocina o café.
 *
 * Decide a qué impresora o KDS va cada producto. Es el unico lugar donde vive
 * el ruteo, para que agregar un producto nuevo no toque el POS.
 */
export const stationSchema = z.object({
  id: z.string().uuid(),
  venueId: z.string().uuid(),
  name: z.string().min(1).max(60),
  kind: z.enum(['bar', 'cocina', 'cafe']),
  printerTarget: z.string().max(120).nullable(),
  sort: z.number().int(),
  active: z.boolean(),
});
export type Station = z.infer<typeof stationSchema>;

export const categorySchema = z.object({
  id: z.string().uuid(),
  /** NULL = categoría compartida por todos los locales de la organización. */
  venueId: z.string().uuid().nullable(),
  name: z.string().min(1).max(80),
  sort: z.number().int(),
  active: z.boolean(),
});
export type Category = z.infer<typeof categorySchema>;

export const productSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  name: z.string().min(1).max(120),
  sku: z.string().max(40).nullable(),
  priceCents: z.number().int().min(0),
  /** Tasa de impuesto como fracción (0.21). El motor fiscal es Fase 2. */
  taxRate: z.number().min(0).max(1),
  stationId: z.string().uuid().nullable(),
  available: z.boolean(),
  allergens: z.array(z.string()),
  tags: z.array(z.string()),
  sort: z.number().int(),
});
export type Product = z.infer<typeof productSchema>;

/**
 * Grupo de modificadores: "Leche", "Punto de cocción", "Extras".
 *
 * `minSelect > 0` hace el grupo obligatorio. `maxSelect` acota la multi-selección
 * y existe por una razon concreta: si el grupo "Extras" aceptara diez, el mozo
 * termina cargando una pizza con seis cosas sin querer.
 */
export const modifierGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  minSelect: z.number().int().min(0),
  maxSelect: z.number().int().min(1),
  sort: z.number().int(),
  active: z.boolean(),
});
export type ModifierGroup = z.infer<typeof modifierGroupSchema>;

/**
 * Un modificador concreto. `priceDeltaCents` puede ser negativo: "sin hielo" no
 * descuenta, pero "menos queso" sí.
 */
export const modifierSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  name: z.string().min(1).max(80),
  priceDeltaCents: z.number().int(),
  /** Cambios de escandallo (leche de almendras en vez de entera). Fase 4. */
  recipeOverride: z.record(z.unknown()),
  sort: z.number().int(),
  active: z.boolean(),
});
export type Modifier = z.infer<typeof modifierSchema>;

/**
 * Producto con sus grupos de modificadores, listo para pintar la pantalla de
 *Modifiers. Es lo que el POS lee de la replica: no hace 4 consultas por producto.
 */
export const productWithModifiersSchema = productSchema.extend({
  groups: z.array(
    modifierGroupSchema.extend({
      modifiers: z.array(modifierSchema),
    }),
  ),
});
export type ProductWithModifiers = z.infer<typeof productWithModifiersSchema>;

// -----------------------------------------------------------------------------
// Salón
// -----------------------------------------------------------------------------

export const floorSchema = z.object({
  id: z.string().uuid(),
  venueId: z.string().uuid(),
  name: z.string().min(1).max(60),
  sort: z.number().int(),
});
export type Floor = z.infer<typeof floorSchema>;

/**
 * Mesa con su geometría.
 *
 * `x/y/w/h` son unidades de grilla del editor de planos, no píxeles: el mismo
 * plano tiene que verse igual en una tablet de 8" y en la pantalla de la barra.
 */
export const floorTableSchema = z.object({
  id: z.string().uuid(),
  floorId: z.string().uuid(),
  label: z.string().min(1).max(20),
  seats: z.number().int().min(1).max(40),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  shape: z.enum(['rect', 'round', 'square']),
  status: TableStatus,
  /** Cuándo se ocupó. La alerta de "mesa hace 2h30" sale de acá. */
  occupiedSince: z.string().datetime().nullable(),
  orderId: z.string().uuid().nullable(),
});
export type FloorTable = z.infer<typeof floorTableSchema>;

// -----------------------------------------------------------------------------
// Comanda
// -----------------------------------------------------------------------------

export const orderItemModifierSchema = z.object({
  modifierId: z.string().uuid().nullable(),
  name: z.string().min(1).max(80),
  priceDeltaCents: z.number().int(),
});
export type OrderItemModifier = z.infer<typeof orderItemModifierSchema>;

export const orderItemSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  productId: z.string().uuid().nullable(),
  nameSnapshot: z.string().min(1).max(120),
  quantity: z.number().int().min(1),
  /** Snapshot del precio al agregar. Cambiar el catálogo no altera esto. */
  unitPriceCents: z.number().int().min(0),
  /** Reglas de precio aplicadas, para poder explicar el total después. */
  appliedRules: z.array(z.unknown()),
  status: z.enum(['ACTIVE', 'VOIDED']),
  course: z.number().int().min(1).max(9),
  seat: z.number().int().min(1).max(40).nullable(),
  note: z.string().max(300).nullable(),
  modifiers: z.array(orderItemModifierSchema),
  voidReason: z.string().max(300).nullable(),
  voidedAt: z.string().datetime().nullable(),
});
export type OrderItem = z.infer<typeof orderItemSchema>;

export const orderSchema = z.object({
  id: z.string().uuid(),
  venueId: z.string().uuid(),
  tableId: z.string().uuid().nullable(),
  tableLabel: z.string().nullable(),
  channel: OrderChannel,
  status: OrderStatus,
  /** Numero visible. Offline es `device_prefix-seq`, no correlativo global. */
  numberLabel: z.string().min(1).max(24),
  openedBy: z.string().uuid().nullable(),
  openedAt: z.string().datetime(),
  guests: z.number().int().min(1).max(60),
  shiftId: z.string().uuid().nullable(),
  totalCents: z.number().int().min(0),
  tipCents: z.number().int().min(0),
  items: z.array(orderItemSchema),
});
export type Order = z.infer<typeof orderSchema>;

// -----------------------------------------------------------------------------
// Cuenta: pagos, división y propinas
// -----------------------------------------------------------------------------

/**
 * Pago. `providerRef` es el comprobante del terminal, **nunca el PAN**: la API no
 * ve el numero de tarjeta en ningun camino.
 */
export const paymentSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  method: PaymentMethod,
  amountCents: z.number().int().min(1),
  tipCents: z.number().int().min(0),
  provider: z.string().max(24).nullable(),
  providerRef: z.string().max(120).nullable(),
  status: z.enum(['PENDING', 'APPROVED', 'FAILED', 'REFUNDED']),
  shiftId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type Payment = z.infer<typeof paymentSchema>;

/**
 * Una parte de la cuenta dividida.
 *
 * `amountCents` ya viene repartido: la division se calcula una vez y se persiste,
 * porque si se recalculara en cada pantalla dos personas podrian ver importes
 * distintos para la misma mesa.
 */
export const splitAllocationSchema = z.object({
  id: z.string().uuid(),
  /** Numero de parte (1..N) o id del item cuando el reparto es por ítem. */
  label: z.string().min(1).max(60),
  amountCents: z.number().int().min(0),
  /** Id del item cuando `mode` es BY_ITEM. */
  itemIds: z.array(z.string().uuid()),
  paid: z.boolean(),
});
export type SplitAllocation = z.infer<typeof splitAllocationSchema>;

export const billSplitSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  mode: SplitMode,
  allocations: z.array(splitAllocationSchema),
  totalCents: z.number().int().min(0),
});
export type BillSplit = z.infer<typeof billSplitSchema>;

// -----------------------------------------------------------------------------
// Caja y turnos
// -----------------------------------------------------------------------------

export const shiftSchema = z.object({
  id: z.string().uuid(),
  venueId: z.string().uuid(),
  openedBy: z.string().uuid(),
  openedAt: z.string().datetime(),
  openingFloatCents: z.number().int().min(0),
  closedAt: z.string().datetime().nullable(),
  /** Lo que el cajero DECLARA tener. El esperado no le llega a la pantalla. */
  declaredCashCents: z.number().int().nullable(),
  expectedCashCents: z.number().int().nullable(),
  diffCents: z.number().int().nullable(),
  status: z.enum(['OPEN', 'CLOSED']),
});
export type Shift = z.infer<typeof shiftSchema>;

export const cashMovementSchema = z.object({
  id: z.string().uuid(),
  shiftId: z.string().uuid(),
  type: CashMovementType,
  amountCents: z.number().int().min(1),
  reason: z.string().max(300).nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type CashMovement = z.infer<typeof cashMovementSchema>;

// -----------------------------------------------------------------------------
// Cocina
// -----------------------------------------------------------------------------

export const kitchenTicketSchema = z.object({
  id: z.string().uuid(),
  stationId: z.string().uuid(),
  orderId: z.string().uuid(),
  orderNumberLabel: z.string(),
  tableLabel: z.string().nullable(),
  status: KitchenStatus,
  priority: z.number().int(),
  createdAt: z.string().datetime(),
  /** Snapshot de los ítems del ticket: el KDS muestra lo que se pidió, no la comanda. */
  lines: z.array(
    z.object({
      itemId: z.string().uuid(),
      name: z.string(),
      quantity: z.number().int().min(1),
      note: z.string().nullable(),
      modifiers: z.array(z.string()),
      course: z.number().int().min(1),
    }),
  ),
});
export type KitchenTicket = z.infer<typeof kitchenTicketSchema>;

// -----------------------------------------------------------------------------
// Totales
// -----------------------------------------------------------------------------

/**
 * Totales de una comanda, en enteros.
 *
 * Es una función pura y no un SELECT: el POS la corre sobre su replica local con
 * la misma logica que el servidor, y por eso da el mismo numero antes y despues
 * de sincronizar. Un total que se calcula distinto offline es un cobro que el
 * cliente reclama.
 *
 * Los modificadores entran dentro del precio unitario efectivo del item, no como
 * una linea aparte: en un ticket real "capuchino doble" es un producto, no dos.
 */
export interface OrderTotals {
  subtotalCents: number;
  discountCents: number;
  serviceCents: number;
  tipCents: number;
  totalCents: number;
  paidCents: number;
  remainingCents: number;
}

export function orderTotals(params: {
  items: ReadonlyArray<
    Pick<OrderItem, 'unitPriceCents' | 'quantity' | 'status'> & {
      modifiers?: ReadonlyArray<{ priceDeltaCents: number }>;
    }
  >;
  currency: string;
  /** Snapshot de las reglas aplicadas, ya en centavos de descuento por unidad. */
  discountCents?: number;
  /** Servicio en basis points. 1000 = 10%. */
  serviceBps?: number;
  tipCents?: number;
  paidCents?: number;
}): OrderTotals {
  const subtotalCents = params.items
    .filter((item) => item.status === 'ACTIVE')
    .reduce((acc, item) => {
      const modifierDelta = (item.modifiers ?? []).reduce(
        (sum, modifier) => sum + modifier.priceDeltaCents,
        0,
      );
      return acc + (item.unitPriceCents + modifierDelta) * item.quantity;
    }, 0);

  const discountCents = Math.max(0, Math.min(params.discountCents ?? 0, subtotalCents));

  // El servicio se calcula sobre el neto, no sobre la lista: cobrar 10% de algo
  // que ya tiene descuento y mostrar otro total es el reclamo clasico del bar.
  const taxable = subtotalCents - discountCents;
  const serviceCents = Math.round((taxable * (params.serviceBps ?? 0)) / 10_000);

  const tipCents = Math.max(0, params.tipCents ?? 0);
  const paidCents = Math.max(0, params.paidCents ?? 0);
  const totalCents = taxable + serviceCents + tipCents;

  return {
    subtotalCents,
    discountCents,
    serviceCents,
    tipCents,
    totalCents,
    paidCents,
    remainingCents: totalCents - paidCents,
  };
}

/** Convierte los totales a `Money` del dominio, para formatear. */
export function totalsAsMoney(totals: OrderTotals, currency: string): Money {
  return money(totals.totalCents, currency);
}
