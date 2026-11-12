import { applyBasisPoints, discountByCents, money } from '@comanda/domain';
import { PricingError } from './types';
import type {
  PricedLine,
  PricedOrder,
  PriceableLine,
  PricingContext,
  PromotionRule,
  Schedule,
} from './types';

/**
 * Evaluacion de reglas de precio.
 *
 * Orden de operaciones, que es la parte que hay que acertar:
 *
 *  1. Filtrar reglas activas y por vigencia (schedule en hora LOCAL del local).
 *  2. Aplicar de mayor a menor `priority`, respetando `stackable`.
 *  3. Cada descuento se calcula sobre el precio ya modificado por las anteriores,
 *     no sobre el de lista: encadenar dos de 50% da 75% off, no 100%.
 *  4. El total por linea se redondea a centavos UNA vez, al final. Si se
 *     redondeara por paso, un combo de items baratos perderia centavos por linea.
 *  5. Se persiste un snapshot de que reglas se aplicaron (linea `applied`),
 *     porque dentro de tres meses el precio tiene que poder explicarse aunque la
 *     regla ya no exista.
 */

/** Indice de reglas por ambito, para no recorrer todas por cada linea. */
export class RuleSet {
  private readonly byProduct = new Map<string, PromotionRule[]>();
  private readonly byCategory = new Map<string, PromotionRule[]>();
  private readonly global: PromotionRule[] = [];

  constructor(rules: readonly PromotionRule[]) {
    for (const rule of rules) {
      if (!rule.active) continue;
      if (rule.scope === 'ORDER') {
        this.global.push(rule);
      } else if (rule.scopeId) {
        const target = rule.scope === 'PRODUCT' ? this.byProduct : this.byCategory;
        const list = target.get(rule.scopeId);
        if (list) list.push(rule);
        else target.set(rule.scopeId, [rule]);
      }
    }
    const byPriority = (a: PromotionRule, b: PromotionRule) => b.priority - a.priority;
    this.global.sort(byPriority);
    for (const list of [...this.byProduct.values(), ...this.byCategory.values()]) {
      list.sort(byPriority);
    }
  }

  /** Reglas candidatas para una linea, ya ordenadas por prioridad. */
  candidatesFor(line: PriceableLine): PromotionRule[] {
    const product = this.byProduct.get(line.productId) ?? [];
    const category = line.categoryId ? (this.byCategory.get(line.categoryId) ?? []) : [];
    return [...product, ...category, ...this.global].sort((a, b) => b.priority - a.priority);
  }
}

/**
 * Convierte un instante UTC a las partes de la fecha local del local.
 * Se hace con Intl en vez de con offsets fijos porque el horario de verano
 * cambiante es justamente el caso que un happy hour tiene que acertar.
 */
export function localParts(
  now: number,
  timezone: string,
): {
  dayOfWeek: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(now));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdays[pick('weekday')] ?? 0;
  // Intl puede devolver "24" para medianoche en hora de 12h.
  const hour = Number(pick('hour')) % 24;
  return { dayOfWeek: weekday, hour, minute: Number(pick('minute')) };
}

function parseHhMm(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new PricingError(`Horario invalido "${value}", se esperaba HH:mm`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new PricingError(`Horario fuera de rango: ${value}`);
  }
  return { hour, minute };
}

/**
 * Verifica si un schedule esta vigente.
 *
 * El rango `from`-`to` puede cruzar la medianoche (un happy hour de 22 a 02): en
 * ese caso la ventana es [from, 24:00) UNION [00:00, to), y un `from <= actual
 * <= to` simple nunca seria verdadero.
 */
export function isWithinSchedule(
  schedule: Schedule,
  now: number,
  timezone: string,
  skewMs = 0,
): boolean {
  const effective = now + skewMs;

  if (schedule.startsOn && effective < Date.parse(schedule.startsOn)) return false;
  if (schedule.endsOn && effective > Date.parse(schedule.endsOn)) return false;

  const { dayOfWeek, hour, minute } = localParts(effective, timezone);
  const from = parseHhMm(schedule.from);
  const to = parseHhMm(schedule.to);
  const startMinutes = from.hour * 60 + from.minute;
  const endMinutes = to.hour * 60 + to.minute;
  const minutes = hour * 60 + minute;
  const crossesMidnight = isCrossMidnight(schedule);

  if (!crossesMidnight) {
    if (minutes < startMinutes || minutes >= endMinutes) return false;
    return matchesDay(schedule, dayOfWeek);
  }

  // Ventana partida: [from, 24:00) pertenece a HOY, [00:00, to) a AYER.
  // Sin esta separacion, un "viernes de 22 a 02" quedaria vigente todo el sabado
  // a la noche, que es cuando el local ya esta cerrado.
  if (minutes >= startMinutes) {
    return matchesDay(schedule, dayOfWeek);
  }
  if (minutes < endMinutes) {
    return matchesDay(schedule, (dayOfWeek + 6) % 7);
  }
  return false;
}

/** Un schedule sin dias declarados aplica todos los dias. */
function matchesDay(schedule: Schedule, dayOfWeek: number): boolean {
  return schedule.daysOfWeek.length === 0 || schedule.daysOfWeek.includes(dayOfWeek);
}

function isCrossMidnight(schedule: Schedule): boolean {
  const from = parseHhMm(schedule.from);
  const to = parseHhMm(schedule.to);
  return to.hour * 60 + to.minute <= from.hour * 60 + from.minute;
}

/** Calcula el precio de una linea aplicando las reglas vigentes. */
export function priceLine(
  line: PriceableLine,
  context: PricingContext,
  candidates: readonly PromotionRule[],
): PricedLine {
  if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
    throw new PricingError(`Cantidad invalida en la linea ${line.lineId}: ${line.quantity}`);
  }
  if (!Number.isInteger(line.unitPriceCents)) {
    throw new PricingError(`Precio no entero en la linea ${line.lineId}`);
  }

  let unitCents = line.unitPriceCents;
  const applied: PricedLine['applied'] = [];

  for (const rule of candidates) {
    if (
      rule.schedule &&
      !isWithinSchedule(rule.schedule, context.now, context.timezone, context.clockSkewMs)
    ) {
      continue;
    }
    // Reglas no apilables: si ya se aplico una que no se puede apilar, las demas
    // no apilables tambien se ignoran. Las apilables si se acumulan.
    if (!rule.stackable && applied.some((a) => !a.stackable)) {
      continue;
    }

    const discount = discountForRule(rule, unitCents, line);
    if (discount <= 0) continue;

    // El descuento se calcula sobre el precio ya modificado y se acota a 0 para
    // que el precio nunca sea negativo.
    const clamped = discountByCents(money(unitCents, line.currency), discount);
    unitCents = clamped.cents;
    applied.push({
      ruleId: rule.id,
      type: rule.type,
      stackable: rule.stackable,
      discountCents: Math.max(0, line.unitPriceCents - unitCents),
      unitPriceCents: unitCents,
      description: describeRule(rule),
    });
  }

  const subtotalCents = unitCents * line.quantity;
  return {
    lineId: line.lineId,
    quantity: line.quantity,
    listUnitPriceCents: line.unitPriceCents,
    unitPriceCents: unitCents,
    discountCents: line.unitPriceCents - unitCents,
    subtotalCents,
    applied,
  };
}

/** Descuento en centavos (o precio final absoluto) que produce la regla. */
function discountForRule(rule: PromotionRule, unitCents: number, line: PriceableLine): number {
  const currency = line.currency;
  switch (rule.type) {
    case 'PERCENT': {
      const bps = rule.params.bps ?? 0;
      return applyBasisPoints(money(unitCents, currency), bps).cents;
    }
    case 'FIXED':
      return rule.params.cents ?? 0;
    case 'PRICE_OVERRIDE': {
      const target = rule.params.priceCents;
      if (target === undefined) {
        throw new PricingError(`La regla ${rule.id} es PRICE_OVERRIDE sin priceCents`);
      }
      return unitCents - target;
    }
    case 'NXM': {
      // NXM afecta al total de la linea, no al precio unitario: se traduce a un
      // descuento por unidad solo si la cantidad alcanza el minimo.
      const n = rule.params.n ?? 2;
      const m = rule.params.m ?? 1;
      if (line.quantity < n) return 0;
      const freeUnits = Math.floor(line.quantity / n) * Math.min(m, n - 1);
      return Math.round((unitCents * freeUnits) / line.quantity);
    }
    case 'BOGO': {
      // BOGO: el mas barato gratis, con cantidad par.
      const half = Math.floor(line.quantity / 2);
      if (half < 1) return 0;
      return Math.round((unitCents * half) / line.quantity);
    }
    default: {
      throw new PricingError(`Tipo de promocion no soportado: ${String(rule.type)}`);
    }
  }
}

function describeRule(rule: PromotionRule): string {
  switch (rule.type) {
    case 'PERCENT':
      return `${((rule.params.bps ?? 0) / 100).toFixed(0)}% off`;
    case 'FIXED':
      return 'Descuento fijo';
    case 'BOGO':
      return '2x1';
    case 'NXM':
      return `${rule.params.n}x${rule.params.m}`;
    case 'PRICE_OVERRIDE':
      return 'Precio especial';
    default:
      return 'Promocion';
  }
}

/** Precioa una comanda completa. */
export function priceOrder(
  lines: readonly PriceableLine[],
  rules: readonly PromotionRule[],
  context: PricingContext,
): PricedOrder {
  const ruleSet = new RuleSet(rules);
  const priced: PricedLine[] = lines.map((line) =>
    priceLine(line, context, ruleSet.candidatesFor(line)),
  );

  const currency = context.currency;
  const subtotalCents = priced.reduce((acc, l) => acc + l.subtotalCents, 0);
  const listSubtotalCents = priced.reduce((acc, l) => acc + l.listUnitPriceCents * l.quantity, 0);

  return {
    currency,
    lines: priced,
    subtotalCents,
    totalCents: subtotalCents,
    discountTotalCents: Math.max(0, listSubtotalCents - subtotalCents),
  };
}
