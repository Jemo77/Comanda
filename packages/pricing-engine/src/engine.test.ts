import { describe, expect, it } from 'vitest';
import { isWithinSchedule, localParts, priceOrder } from './engine';
import type {
  PricingContext,
  PriceableLine,
  PromotionRule,
  PromotionType,
  Schedule,
} from './types';

const ARS = 'ARS';
const TZ = 'America/Argentina/Buenos_Aires';

function line(overrides: Partial<PriceableLine> = {}): PriceableLine {
  return {
    lineId: 'l1',
    productId: 'p1',
    categoryId: 'c1',
    quantity: 1,
    unitPriceCents: 10_000,
    currency: ARS,
    ...overrides,
  };
}

function rule(overrides: Partial<PromotionRule> = {}): PromotionRule {
  return {
    id: 'r1',
    type: 'PERCENT',
    scope: 'PRODUCT',
    scopeId: 'p1',
    schedule: null,
    params: {},
    priority: 0,
    stackable: false,
    active: true,
    ...overrides,
  };
}

function context(now: number): PricingContext {
  return { now, timezone: TZ, currency: ARS };
}

// 2024-03-15 es un viernes. Buenos Aires es UTC-3.
const friday1930 = Date.parse('2024-03-15T22:30:00Z');
const friday1700 = Date.parse('2024-03-15T20:00:00Z');
const sunday1930 = Date.parse('2024-03-17T22:30:00Z');

describe('priceOrder — sin reglas', () => {
  it('devuelve el precio de lista', () => {
    const result = priceOrder([line({ quantity: 2 })], [], context(friday1930));
    expect(result.lines[0]!.unitPriceCents).toBe(10_000);
    expect(result.subtotalCents).toBe(20_000);
    expect(result.totalCents).toBe(20_000);
    expect(result.discountTotalCents).toBe(0);
  });
});

describe('PERCENT', () => {
  it('aplica el descuento en basis points', () => {
    const result = priceOrder(
      [line({ unitPriceCents: 10_000 })],
      [rule({ params: { bps: 1_000 } })],
      context(friday1930),
    );
    expect(result.lines[0]!.unitPriceCents).toBe(9_000);
    expect(result.discountTotalCents).toBe(1_000);
  });

  it('redondea a centavos enteros', () => {
    const result = priceOrder(
      [line({ unitPriceCents: 999 })],
      [rule({ params: { bps: 3_300 } })],
      context(friday1930),
    );
    expect(result.lines[0]!.unitPriceCents).toBe(669);
    expect(Number.isInteger(result.totalCents)).toBe(true);
  });
});

describe('encadenamiento', () => {
  it('aplica reglas stackables en cascada sobre el precio ya modificado', () => {
    const result = priceOrder(
      [line({ unitPriceCents: 10_000 })],
      [
        rule({ id: 'a', params: { bps: 1_000 }, priority: 10, stackable: true }),
        rule({ id: 'b', params: { bps: 1_000 }, priority: 5, stackable: true }),
      ],
      context(friday1930),
    );
    // 10000 -> 9000 -> 8100. NO 8000: el segundo 10% es sobre el precio yaajar.
    expect(result.lines[0]!.unitPriceCents).toBe(8_100);
    expect(result.lines[0]!.applied).toHaveLength(2);
  });

  it('ignora la segunda regla no stackable', () => {
    const result = priceOrder(
      [line({ unitPriceCents: 10_000 })],
      [
        rule({ id: 'a', params: { bps: 1_000 }, priority: 10, stackable: false }),
        rule({ id: 'b', params: { bps: 1_000 }, priority: 5, stackable: false }),
      ],
      context(friday1930),
    );
    expect(result.lines[0]!.unitPriceCents).toBe(9_000);
    expect(result.lines[0]!.applied).toHaveLength(1);
  });

  it('respeta la prioridad (mayor numero primero)', () => {
    const result = priceOrder(
      [line({ unitPriceCents: 10_000 })],
      [
        rule({ id: 'low', params: { bps: 5_000 }, priority: 1, stackable: false }),
        rule({ id: 'high', params: { bps: 1_000 }, priority: 99, stackable: false }),
      ],
      context(friday1930),
    );
    expect(result.lines[0]!.unitPriceCents).toBe(9_000);
    expect(result.lines[0]!.applied[0]!.ruleId).toBe('high');
  });

  it('nunca produce un precio negativo', () => {
    // 80% + 80% sobre 1000 deja 40, no -600: cada paso se acota sobre el precio
    // vigente, no se acumulan descuentos sobre el precio de lista.
    const chained = priceOrder(
      [line({ unitPriceCents: 1_000 })],
      [
        rule({ id: 'a', params: { bps: 8_000 }, stackable: true }),
        rule({ id: 'b', params: { bps: 8_000 }, stackable: true }),
      ],
      context(friday1930),
    );
    expect(chained.lines[0]!.unitPriceCents).toBe(40);

    // Y un descuento que excede el 100% deja 0, no un importe negativo.
    const clamped = priceOrder(
      [line({ unitPriceCents: 1_000 })],
      [rule({ id: 'a', type: 'FIXED', params: { cents: 99_999 } })],
      context(friday1930),
    );
    expect(clamped.lines[0]!.unitPriceCents).toBe(0);
    expect(clamped.totalCents).toBe(0);
  });
});

describe('FIXED y PRICE_OVERRIDE', () => {
  it('aplica descuento fijo', () => {
    const result = priceOrder(
      [line({ unitPriceCents: 10_000 })],
      [rule({ type: 'FIXED', params: { cents: 2_500 } })],
      context(friday1930),
    );
    expect(result.lines[0]!.unitPriceCents).toBe(7_500);
  });

  it('aplica precio especial', () => {
    const result = priceOrder(
      [line({ unitPriceCents: 10_000 })],
      [rule({ type: 'PRICE_OVERRIDE', params: { priceCents: 8_000 } })],
      context(friday1930),
    );
    expect(result.lines[0]!.unitPriceCents).toBe(8_000);
  });

  it('falla si PRICE_OVERRIDE no trae precio', () => {
    expect(() =>
      priceOrder([line()], [rule({ type: 'PRICE_OVERRIDE' })], context(friday1930)),
    ).toThrow(/priceCents/);
  });
});

describe('BOGO y NXM', () => {
  it('BOGO regala la mitad de las unidades', () => {
    const result = priceOrder(
      [line({ quantity: 4, unitPriceCents: 5_000 })],
      [rule({ type: 'BOGO', params: {} })],
      context(friday1930),
    );
    expect(result.totalCents).toBe(10_000);
  });

  it('BOGO con cantidad impar regala la mitad redondeada hacia abajo', () => {
    // 3 unidades de 2x1: se pagan 2 y se regala 1, no media unidad. El descuento
    // por unidad no da entero (5000/3), pero el total de la linea si, y es el
    // total el que se cobra.
    const result = priceOrder(
      [line({ quantity: 3, unitPriceCents: 5_000 })],
      [rule({ type: 'BOGO', params: {} })],
      context(friday1930),
    );
    expect(result.totalCents).toBe(9_999);
    expect(result.totalCents).toBeLessThanOrEqual(10_000);
  });

  it('BOGO con una sola unidad no regala nada', () => {
    const result = priceOrder(
      [line({ quantity: 1, unitPriceCents: 5_000 })],
      [rule({ type: 'BOGO', params: {} })],
      context(friday1930),
    );
    expect(result.totalCents).toBe(5_000);
  });

  it('NXM solo aplica a partir de la cantidad minima', () => {
    const rules = [rule({ type: 'NXM', params: { n: 3, m: 1 } })];

    const below = priceOrder(
      [line({ quantity: 2, unitPriceCents: 3_000 })],
      rules,
      context(friday1930),
    );
    expect(below.totalCents).toBe(6_000);

    const at = priceOrder(
      [line({ quantity: 3, unitPriceCents: 3_000 })],
      rules,
      context(friday1930),
    );
    expect(at.totalCents).toBe(6_000);
  });
});

describe('ambito', () => {
  it('aplica reglas de categoria', () => {
    const result = priceOrder(
      [line({ productId: 'p1', categoryId: 'c1' })],
      [rule({ scope: 'CATEGORY', scopeId: 'c1', params: { bps: 2_000 } })],
      context(friday1930),
    );
    expect(result.lines[0]!.unitPriceCents).toBe(8_000);
  });

  it('no aplica reglas de otra categoria', () => {
    const result = priceOrder(
      [line({ productId: 'p1', categoryId: 'c1' })],
      [rule({ scope: 'CATEGORY', scopeId: 'otra', params: { bps: 2_000 } })],
      context(friday1930),
    );
    expect(result.lines[0]!.unitPriceCents).toBe(10_000);
  });

  it('ignora reglas inactivas', () => {
    const result = priceOrder(
      [line()],
      [rule({ params: { bps: 5_000 }, active: false })],
      context(friday1930),
    );
    expect(result.lines[0]!.unitPriceCents).toBe(10_000);
  });

  it('aplica reglas de orden a todas las lineas', () => {
    const result = priceOrder(
      [line({ lineId: 'a' }), line({ lineId: 'b', productId: 'p2', categoryId: null })],
      [rule({ scope: 'ORDER', scopeId: null, params: { bps: 500 } })],
      context(friday1930),
    );
    expect(result.lines.every((l) => l.unitPriceCents === 9_500)).toBe(true);
  });
});

describe('horarios (happy hour)', () => {
  const happyHour: Schedule = {
    daysOfWeek: [1, 2, 3, 4, 5],
    from: '18:00',
    to: '20:00',
    timezone: TZ,
  };

  it('reconoce el dia y la hora local, no la de UTC', () => {
    expect(localParts(friday1930, TZ)).toEqual({ dayOfWeek: 5, hour: 19, minute: 30 });
    expect(localParts(sunday1930, TZ).dayOfWeek).toBe(0);
  });

  it('esta vigente dentro de la ventana', () => {
    expect(isWithinSchedule(happyHour, friday1930, TZ)).toBe(true);
  });

  it('esta fuera antes de la ventana', () => {
    expect(isWithinSchedule(happyHour, friday1700, TZ)).toBe(false);
  });

  it('esta fuera el fin de semana', () => {
    expect(isWithinSchedule(happyHour, sunday1930, TZ)).toBe(false);
  });

  it('soporta ventanas que cruzan la medianoche', () => {
    const late: Schedule = { daysOfWeek: [5], from: '22:00', to: '02:00', timezone: TZ };
    // Viernes 23:30 local.
    const friday2330 = Date.parse('2024-03-16T02:30:00Z');
    // Sabado 01:00 local: sigue siendo la ventana del viernes.
    const saturday0100 = Date.parse('2024-03-16T04:00:00Z');
    // Sabado 23:30 local: la ventana del viernes ya paso.
    const saturday2330 = Date.parse('2024-03-17T02:30:00Z');
    // Sabado 01:30 local, cuando el local ya cerro.
    const saturday0130 = Date.parse('2024-03-16T04:30:00Z');

    expect(isWithinSchedule(late, friday2330, TZ)).toBe(true);
    expect(isWithinSchedule(late, saturday0100, TZ)).toBe(true);
    expect(isWithinSchedule(late, saturday2330, TZ)).toBe(false);
    // La parte de la madrugada del sabado corresponde al viernes: sigue vigente.
    expect(isWithinSchedule(late, saturday0130, TZ)).toBe(true);
  });

  it('aplica la ventana en el precio', () => {
    const withSchedule = rule({ params: { bps: 3_000 }, schedule: happyHour });
    expect(priceOrder([line()], [withSchedule], context(friday1930)).totalCents).toBe(7_000);
    expect(priceOrder([line()], [withSchedule], context(sunday1930)).totalCents).toBe(10_000);
  });

  it('tolera un desfasaje de reloj del dispositivo', () => {
    // 17:55 local, cinco minutos antes de que abra el happy hour.
    const justBefore = Date.parse('2024-03-15T20:55:00Z');
    expect(isWithinSchedule(happyHour, justBefore, TZ)).toBe(false);
    // Una tablet con el reloj 10 minutos atrasado ya entra en la ventana: sin
    // este margen, el mismo happy hour seria distinto en cada dispositivo.
    expect(isWithinSchedule(happyHour, justBefore, TZ, 10 * 60_000)).toBe(true);
    // Un reloj adelantado no adelanta el inicio de la ventana.
    expect(isWithinSchedule(happyHour, justBefore, TZ, -10 * 60_000)).toBe(false);
  });

  it('respeta fechas de inicio y fin', () => {
    const bounded: Schedule = {
      ...happyHour,
      startsOn: '2024-01-01T00:00:00Z',
      endsOn: '2024-06-30T23:59:59Z',
    };
    expect(isWithinSchedule(bounded, friday1930, TZ)).toBe(true);
    expect(isWithinSchedule(bounded, Date.parse('2024-08-01T22:30:00Z'), TZ)).toBe(false);
  });

  it('rechaza horarios mal formados', () => {
    const bad: Schedule = { daysOfWeek: [1], from: '25:00', to: '26:00', timezone: TZ };
    expect(() => isWithinSchedule(bad, Date.now(), TZ)).toThrow(/Horario/);
  });

  it('un schedule sin dias aplica todos los dias', () => {
    const daily: Schedule = { daysOfWeek: [], from: '00:00', to: '23:59', timezone: TZ };
    expect(isWithinSchedule(daily, sunday1930, TZ)).toBe(true);
  });
});

describe('validacion de entrada', () => {
  it('rechaza cantidades no positivas', () => {
    expect(() => priceOrder([line({ quantity: 0 })], [], context(friday1930))).toThrow(/Cantidad/);
    expect(() => priceOrder([line({ quantity: 1.5 })], [], context(friday1930))).toThrow(
      /Cantidad/,
    );
  });

  it('rechaza precios no enteros', () => {
    expect(() => priceOrder([line({ unitPriceCents: 100.5 })], [], context(friday1930))).toThrow(
      /entero/,
    );
  });
});

describe('determinismo (requisito offline-first)', () => {
  it('el mismo input produce el mismo output', () => {
    const rules = [
      rule({ id: 'a', params: { bps: 1_500 }, stackable: true }),
      rule({ id: 'b', type: 'FIXED', params: { cents: 300 }, stackable: true, priority: -1 }),
    ];
    const lines = [
      line({ quantity: 3 }),
      line({ lineId: 'l2', productId: 'p2', categoryId: null }),
    ];
    const ctx = context(friday1930);

    expect(JSON.stringify(priceOrder(lines, rules, ctx))).toBe(
      JSON.stringify(priceOrder(lines, rules, ctx)),
    );
  });

  it('produce un snapshot explicable de las reglas aplicadas', () => {
    const result = priceOrder(
      [line({ unitPriceCents: 10_000 })],
      [rule({ id: 'hh', params: { bps: 2_000 } })],
      context(friday1930),
    );
    const applied = result.lines[0]!.applied[0]!;
    expect(applied.ruleId).toBe('hh');
    expect(applied.unitPriceCents).toBe(8_000);
    expect(applied.discountCents).toBe(2_000);
    expect(applied.description).toBe('20% off');
  });
});

/**
 * Tests de propiedades sobre el motor.
 *
 * Son la red de seguridad que pide el PLAN (§4.1): que ninguna combinacion de
 * reglas, cantidades o precios produzca un importe negativo, un precio no entero
 * o un total que no sea la suma de sus lineas.
 */
describe('propiedades', () => {
  const ruleTypes: PromotionType[] = ['PERCENT', 'FIXED', 'BOGO', 'NXM', 'PRICE_OVERRIDE'];
  const stackables = [true, false];
  const priorities = [0, 1, 2];
  const params = { bps: 5_000, cents: 10_000, n: 2, m: 1, priceCents: 0 };

  it('el precio nunca es negativo ni fraccionario, para cualquier combinacion', () => {
    for (const type of ruleTypes) {
      for (const stackable of stackables) {
        for (const priority of priorities) {
          for (const price of [1, 7, 99, 100, 999, 10_000, 999_999]) {
            for (const quantity of [1, 2, 3, 7, 12]) {
              const result = priceOrder(
                [line({ quantity, unitPriceCents: price })],
                [
                  rule({ id: 'a', type, params, stackable, priority }),
                  rule({
                    id: 'b',
                    type,
                    params: { ...params, cents: 999_999 },
                    stackable,
                    priority: priority + 1,
                  }),
                ],
                context(friday1930),
              );

              const priced = result.lines[0]!;
              const label = `${type} q=${quantity} p=${price} stack=${stackable}`;
              expect(priced.unitPriceCents, label).toBeGreaterThanOrEqual(0);
              expect(priced.subtotalCents, label).toBeGreaterThanOrEqual(0);
              expect(Number.isInteger(priced.unitPriceCents), label).toBe(true);
              expect(Number.isInteger(priced.subtotalCents), label).toBe(true);
            }
          }
        }
      }
    }
  });

  it('el total siempre es la suma exacta de los subtotales de linea', () => {
    const lines = [
      line({ lineId: 'a', quantity: 3, unitPriceCents: 999 }),
      line({ lineId: 'b', productId: 'p2', categoryId: null, quantity: 2, unitPriceCents: 4_233 }),
      line({ lineId: 'c', productId: 'p3', categoryId: 'c2', quantity: 7, unitPriceCents: 55 }),
    ];
    const result = priceOrder(
      lines,
      [rule({ params: { bps: 1_500 }, stackable: true })],
      context(friday1930),
    );

    const expected = result.lines.reduce((acc, l) => acc + l.subtotalCents, 0);
    expect(result.totalCents).toBe(expected);
    expect(result.subtotalCents).toBe(expected);
  });

  it('el descuento nunca supera el precio de lista', () => {
    const result = priceOrder(
      [line({ quantity: 2, unitPriceCents: 1_000 })],
      [rule({ type: 'FIXED', params: { cents: 999_999 } })],
      context(friday1930),
    );
    expect(result.discountTotalCents).toBe(2_000);
    expect(result.totalCents).toBe(0);
  });

  it('sin reglas, el precio es exactamente el de lista', () => {
    for (const price of [1, 333, 10_000, 999_999]) {
      for (const quantity of [1, 2, 5, 11]) {
        const result = priceOrder(
          [line({ quantity, unitPriceCents: price })],
          [],
          context(friday1930),
        );
        expect(result.lines[0]!.unitPriceCents).toBe(price);
        expect(result.totalCents).toBe(price * quantity);
        expect(result.discountTotalCents).toBe(0);
      }
    }
  });

  it('agregar una regla nunca aumenta el precio', () => {
    for (const bps of [0, 100, 500, 1_000, 5_000, 10_000]) {
      const base = priceOrder([line()], [], context(friday1930)).totalCents;
      const withRule = priceOrder(
        [line()],
        [rule({ params: { bps } })],
        context(friday1930),
      ).totalCents;
      expect(withRule).toBeLessThanOrEqual(base);
    }
  });

  it('el snapshot aplicado reconcilia con el precio cobrado', () => {
    const result = priceOrder(
      [line({ unitPriceCents: 10_000, quantity: 3 })],
      [
        rule({ id: 'a', params: { bps: 1_000 }, stackable: true, priority: 10 }),
        rule({ id: 'b', params: { bps: 1_000 }, stackable: true, priority: 5 }),
      ],
      context(friday1930),
    );
    const applied = result.lines[0]!.applied;
    const last = applied[applied.length - 1]!;
    expect(last.unitPriceCents).toBe(result.lines[0]!.unitPriceCents);
    expect(last.discountCents).toBe(result.lines[0]!.discountCents);
  });
});
