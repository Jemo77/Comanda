import type { PermissionKey } from '@comanda/domain';

/**
 * Motor de promociones y happy hour. Fase 2 del plan; el scaffolding se crea en
 * Fase 0 porque el modelo de datos (price_rules) ya esta definido y las reglas
 * de precios del catalogo dependen de este tipo.
 *
 * Puro e isomorfico: sin fecha del sistema (el tiempo entra como parametro), sin
 * I/O, sin aleatoriedad no inyectable. El POS lo evalua offline y el servidor
 * con exactamente el mismo codigo, que es la unica forma de que el precio de una
 * linea sea el mismo antes y despues de sincronizar.
 */

export const PROMOTION_TYPES = ['PERCENT', 'FIXED', 'BOGO', 'NXM', 'PRICE_OVERRIDE'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export const PROMOTION_SCOPES = ['PRODUCT', 'CATEGORY', 'ORDER'] as const;
export type PromotionScope = (typeof PROMOTION_SCOPES)[number];

export interface Schedule {
  /** Dias de la semana, 0 = domingo. Compatible con `Date.getDay()`. */
  daysOfWeek: readonly number[];
  /** Hora local de inicio, "HH:mm". El local, no UTC: un happy hour de 18 a 20
   *  debe seguir siendo 18 a 20 cuando cambia el horario de verano. */
  from: string;
  to: string;
  /** Zona IANA del local. */
  timezone: string;
  /** Fechas de inicio y fin en ISO. */
  startsOn?: string;
  endsOn?: string;
}

export interface PromotionRule {
  id: string;
  type: PromotionType;
  scope: PromotionScope;
  /** Id del producto o de la categoria segun `scope`. */
  scopeId: string | null;
  schedule: Schedule | null;
  /** Parametros segun el tipo: bps, cents, n, m. */
  params: {
    /** Tipo PERCENT: puntos basicos de descuento (1000 = 10%). */
    bps?: number;
    /** Tipo FIXED: centavos de descuento. */
    cents?: number;
    /** NXM: cantidad pagadora. */
    n?: number;
    /** NXM: cantidad bonificada. */
    m?: number;
    /** PRICE_OVERRIDE: centavos del precio final. */
    priceCents?: number;
  };
  /** Mayor numero, mayor precedencia. */
  priority: number;
  /** Si puede combinarse con otra regla ya aplicada. */
  stackable: boolean;
  active: boolean;
  /** Permiso requerido para aplicarla manualmente. */
  requiredPermission?: PermissionKey;
}

/** Una linea de comanda tal como la recibe el motor. */
export interface PriceableLine {
  lineId: string;
  productId: string;
  categoryId: string | null;
  quantity: number;
  unitPriceCents: number;
  currency: string;
}

/** Una regla que efectivamente se aplico, con su efecto ya calculado. */
export interface AppliedPromotion {
  ruleId: string;
  type: PromotionType;
  /** Si la regla era apilable. Se guarda porque define si las siguientes aplican. */
  stackable: boolean;
  /** Descuento acumulado en centavos desde el precio de lista. Nunca negativo. */
  discountCents: number;
  /** Precio unitario final, ya redondeado a centavos. */
  unitPriceCents: number;
  description: string;
}

export interface PricedLine {
  lineId: string;
  quantity: number;
  /** Precio de lista, sin promos. */
  listUnitPriceCents: number;
  /** Precio unitario final luego de todas las reglas. */
  unitPriceCents: number;
  /** Descuento total por unidad. Nunca negativo. */
  discountCents: number;
  /** Subtotal de la linea = unitPriceCents * quantity. */
  subtotalCents: number;
  applied: AppliedPromotion[];
}

export interface PricedOrder {
  currency: string;
  lines: PricedLine[];
  subtotalCents: number;
  totalCents: number;
  /** Suma de todos los descuentos aplicados. */
  discountTotalCents: number;
}

/**
 * Contexto de evaluacion.
 *
 * `now` entra explicito: el motor nunca lee el reloj. Asi el mismo input produce
 * el mismo output hoy y dentro de un año, que es lo que hace testeable el
 * happy hour y reproducible una factura vieja.
 */
export interface PricingContext {
  /** Instante actual en epoch ms (UTC). */
  now: number;
  timezone: string;
  currency: string;
  /** Ajustes del margen de error de reloj permitidos por el dispositivo. */
  clockSkewMs?: number;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}
