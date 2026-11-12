import { priceLine, type PromotionRule } from '@comanda/pricing-engine';

/**
 * Reglas vigentes para el POS.
 *
 * Vive como cache en memoria, aparte de la replica: la replica (Dexie) sobrevive
 * a un reinicio offline, y la cache se rehidrata desde la replica al arrancar y de
 * la red en cada ciclo de hidratacion. Las lineas congelan el resultado de esta
 * cache en el momento de agregarlas (`unitPriceCents` + `appliedRules`), igual
 * que el servidor congela el suyo: los totales de una comanda no cambian porque
 * el dueno edite una promo mientras el mozo la toma.
 */

let activeRules: PromotionRule[] = [];
let venueCurrency = 'ARS';
let venueTimezone = 'America/Argentina/Buenos_Aires';

export function setActiveRules(rules: readonly PromotionRule[]): void {
  activeRules = [...rules];
}

export function getActiveRules(): readonly PromotionRule[] {
  return activeRules;
}

export function setVenuePricing(currency: string, timezone: string): void {
  if (currency) venueCurrency = currency;
  if (timezone) venueTimezone = timezone;
}

export function getVenueCurrency(): string {
  return venueCurrency;
}

/**
 * Precio de la linea segun el motor compartido, igual que en el servidor.
 *
 * Con la cache vacia (primer turno, o local sin promos) es un passthrough: el
 * precio es el de lista. Con carta sincronizada y reglas activas, Happy Hour,
 * 2x1 y el resto aplican igual offline que online: es la misma funcion pura
 * en ambos lados, y las reglas son las mismas filas de `price_rules`.
 */
export function priceForProduct(
  product: { id: string; categoryId: string | null; priceCents: number },
  quantity: number,
  currency: string,
): { unitPriceCents: number; appliedRules: unknown } {
  const candidates = activeRules.filter(
    (rule) =>
      rule.active &&
      (rule.scope === 'ORDER' || (rule.scope === 'PRODUCT' && rule.scopeId === product.id) || (rule.scope === 'CATEGORY' && rule.scopeId === product.categoryId)),
  );

  const priced = priceLine(
    {
      lineId: 'pos-line',
      productId: product.id,
      categoryId: product.categoryId,
      quantity,
      unitPriceCents: product.priceCents,
      currency,
    },
    { now: Date.now(), timezone: venueTimezone, currency: venueCurrency },
    candidates,
  );

  return { unitPriceCents: priced.unitPriceCents, appliedRules: priced.applied };
}
