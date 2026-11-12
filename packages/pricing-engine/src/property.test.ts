import { describe, expect, it } from 'vitest';
import { priceOrder } from './engine';
import type {
  PricingContext,
  PriceableLine,
  PromotionRule,
  PromotionType,
} from './types';

/**
 * Tests de propiedades, no de ejemplos: el happy hour mal calculado no falla un
 * jueves de 19:00, falla el viernes 18:59 con otra combinacion de reglas. Un
 * archivo de ejemplos queda verde con el bug adentro; una propiedad que barren
 * muchos casos lo delata.
 *
 * El PRNG es deterministico: si un caso falla, se reproduce con la misma semilla.
 * No se usa aleatoriedad real porque un test que falla "a veces" no se puede
 * debugear.
 */

const ARS = 'ARS';
const TZ = 'America/Argentina/Buenos_Aires';
const FRIDAY = Date.parse('2024-03-15T22:30:00Z'); // viernes 19:30 en BA

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES: PromotionType[] = ['PERCENT', 'FIXED', 'BOGO', 'NXM', 'PRICE_OVERRIDE'];

function randomRules(rand: () => number, count: number): PromotionRule[] {
  const rules: PromotionRule[] = [];
  for (let i = 0; i < count; i += 1) {
    const type = TYPES[Math.floor(rand() * TYPES.length)]!;
    rules.push({
      id: `r${i}`,
      type,
      scope: 'PRODUCT',
      scopeId: 'p1',
      schedule: null,
      params: {
        bps: Math.floor(rand() * 12_000),
        cents: Math.floor(rand() * 30_000),
        n: 1 + Math.floor(rand() * 5),
        m: Math.floor(rand() * 5),
        priceCents: Math.floor(rand() * 20_000),
      },
      priority: Math.floor(rand() * 21) - 10,
      stackable: rand() < 0.5,
      active: rand() < 0.8,
    });
  }
  return rules;
}

function randomLines(rand: () => number, count: number): PriceableLine[] {
  const lines: PriceableLine[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push({
      lineId: `l${i}`,
      productId: 'p1',
      categoryId: 'c1',
      quantity: 1 + Math.floor(rand() * 8),
      unitPriceCents: Math.floor(rand() * 50_000),
      currency: ARS,
    });
  }
  return lines;
}

const context: PricingContext = { now: FRIDAY, timezone: TZ, currency: ARS };

describe('propiedades del motor de precios', () => {
  it('el precio nunca es negativo ni mayor que la lista, y el dinero es entero', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rand = mulberry32(seed);
      const priced = priceOrder(randomLines(rand, 4), randomRules(rand, 5), context);
      for (const line of priced.lines) {
        expect(Number.isInteger(line.unitPriceCents)).toBe(true);
        expect(line.unitPriceCents).toBeGreaterThanOrEqual(0);
        expect(line.unitPriceCents).toBeLessThanOrEqual(line.listUnitPriceCents);
        expect(line.discountCents).toBe(line.listUnitPriceCents - line.unitPriceCents);
        expect(line.discountCents).toBeGreaterThanOrEqual(0);
        expect(line.subtotalCents).toBe(line.unitPriceCents * line.quantity);
        for (const applied of line.applied) {
          expect(applied.discountCents).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(applied.discountCents)).toBe(true);
        }
      }
      expect(priced.totalCents).toBe(priced.subtotalCents);
      expect(priced.discountTotalCents).toBeGreaterThanOrEqual(0);
      const listSum = priced.lines.reduce((acc, l) => acc + l.listUnitPriceCents * l.quantity, 0);
      expect(priced.discountTotalCents).toBe(Math.max(0, listSum - priced.subtotalCents));
    }
  });

  it('es deterministico: el mismo input da el mismo output', () => {
    for (let seed = 100; seed <= 130; seed += 1) {
      const lines = randomLines(mulberry32(seed), 3);
      const rules = randomRules(mulberry32(seed + 1), 4);
      const a = priceOrder(lines, rules, context);
      const b = priceOrder(lines, rules, context);
      expect(a).toEqual(b);
    }
  });

  it('las reglas inactivas nunca aplican', () => {
    for (let seed = 200; seed <= 230; seed += 1) {
      const rand = mulberry32(seed);
      const rules = randomRules(rand, 6).map((r) => ({ ...r, active: false }));
      const priced = priceOrder(randomLines(rand, 3), rules, context);
      for (const line of priced.lines) {
        expect(line.applied).toHaveLength(0);
        expect(line.unitPriceCents).toBe(line.listUnitPriceCents);
      }
    }
  });

  it('una regla fuera de vigencia no descuenta', () => {
    const lines: PriceableLine[] = [
      { lineId: 'l1', productId: 'p1', categoryId: 'c1', quantity: 2, unitPriceCents: 5000, currency: ARS },
    ];
    const futureRule: PromotionRule = {
      id: 'future',
      type: 'PERCENT',
      scope: 'PRODUCT',
      scopeId: 'p1',
      schedule: {
        daysOfWeek: [],
        from: '00:00',
        to: '23:59',
        timezone: TZ,
        startsOn: new Date(FRIDAY + 86_400_000 * 30).toISOString(),
      },
      params: { bps: 5000 },
      priority: 1,
      stackable: false,
      active: true,
    };
    const priced = priceOrder(lines, [futureRule], context);
    expect(priced.lines[0]!.unitPriceCents).toBe(5000);
  });
});
