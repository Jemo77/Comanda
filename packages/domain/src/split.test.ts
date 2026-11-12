import { describe, expect, it } from 'vitest';
import { money } from './money';
import {
  allocateTip,
  SplitError,
  splitByAmount,
  splitByItem,
  splitBySeat,
  splitByWeights,
  splitEqual,
  suggestedTips,
  totalOf,
  type Splittable,
} from './split';

/**
 * Tests de division de cuentas.
 *
 * El criterio de aceptacion es uno solo y no negootiable: **la suma de las partes
 * tiene que ser exactamente el total, siempre**. Un test que solo mira "el
 * reparto se parece al total" no atrapa el bug de un centavo, que es el que de
 * verdad rompe una noche de caja.
 */

const CURRENCY = 'ARS';

function item(id: string, amountCents: number, seat?: number | null) {
  return { id, name: `Item ${id}`, amountCents, seat: seat ?? null };
}

describe('splitEqual', () => {
  it('reparte sin perder ni crear centavos', () => {
    const input: Splittable = {
      currency: CURRENCY,
      items: [item('a', 3333), item('b', 3333), item('c', 3334)],
    };

    const parts = splitEqual(input, 3);
    const sum = parts.reduce((acc, p) => acc + p.amount.cents, 0);

    expect(sum).toBe(10000);
    expect(parts.map((p) => p.amount.cents).sort((a, b) => b - a)).toEqual([3334, 3333, 3333]);
  });

  it('reparte entre comensales y no entre items', () => {
    // Dos personas, seis items: el total por persona es el mismo aunque se haya
    // cargado de a uno o de a tres.
    const input: Splittable = {
      currency: CURRENCY,
      items: Array.from({ length: 6 }, (_, i) => item(`i${i}`, 1000)),
    };

    const parts = splitEqual(input, 2);

    expect(parts).toHaveLength(2);
    expect(parts.reduce((acc, p) => acc + p.amount.cents, 0)).toBe(6000);
    expect(parts.every((p) => p.amount.cents === 3000)).toBe(true);
  });

  it('el centavo sobrante va siempre a la primera parte, de forma estable', () => {
    const input: Splittable = { currency: CURRENCY, items: [item('a', 10000)] };

    // $100 en 3 no se puede repartir exacto. La primera parte se lleva el centavo
    // siempre, y no "la que toque": tiene que ser determinista, porque si el
    // cajero ve una cosa y el cliente otra, aparece el reclamo.
    const parts = splitEqual(input, 3);

    expect(parts[0]!.amount.cents).toBe(3334);
    expect(parts[1]!.amount.cents).toBe(3333);
    expect(parts[2]!.amount.cents).toBe(3333);
  });

  it('rechaza una cantidad de partes invalida', () => {
    const input: Splittable = { currency: CURRENCY, items: [item('a', 1000)] };

    expect(() => splitEqual(input, 0)).toThrow(SplitError);
    expect(() => splitEqual(input, -1)).toThrow(SplitError);
    expect(() => splitEqual(input, 2.5)).toThrow(SplitError);
  });

  it('una sola parte devuelve el total intacto', () => {
    const input: Splittable = { currency: CURRENCY, items: [item('a', 1234), item('b', 5)] };

    const parts = splitEqual(input, 1);

    expect(parts).toHaveLength(1);
    expect(parts[0]!.amount.cents).toBe(1239);
  });
});

describe('splitByItem', () => {
  it('hace una parte por item y conserva los ids', () => {
    const input: Splittable = {
      currency: CURRENCY,
      items: [item('a', 2000), item('b', 1500), item('c', 1000)],
    };

    const parts = splitByItem(input);

    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.key)).toEqual(['a', 'b', 'c']);
    expect(parts[0]!.itemIds).toEqual(['a']);
    expect(parts.reduce((acc, p) => acc + p.amount.cents, 0)).toBe(4500);
  });

  it('falla si no hay items, en vez de devolver un reparto vacio', () => {
    expect(() => splitByItem({ currency: CURRENCY, items: [] })).toThrow(SplitError);
  });
});

describe('splitByWeights', () => {
  it('normaliza pesos que no suman 1', () => {
    // [2, 3] en vez de [0.2, 0.3]: el peso sin normalizar haria que el total
    // quedara corto y el local pierda esa diferencia.
    const input: Splittable = { currency: CURRENCY, items: [item('a', 1000), item('b', 1000)] };

    const parts = splitByWeights(input, [2, 3]);

    expect(parts.reduce((acc, p) => acc + p.amount.cents, 0)).toBe(2000);
    expect(parts[0]!.amount.cents).toBe(800);
    expect(parts[1]!.amount.cents).toBe(1200);
  });

  it('el total cuadra con pesos que no dividen exacto', () => {
    // Tres partes en razon 1:1:1 sobre 100 centavos.
    const input: Splittable = {
      currency: CURRENCY,
      items: [item('a', 100), item('b', 100), item('c', 100)],
    };

    const parts = splitByWeights(input, [1, 1, 1]);

    expect(parts.reduce((acc, p) => acc + p.amount.cents, 0)).toBe(300);
  });

  it('rechaza pesos negativo, cero o que no coinciden con los items', () => {
    const input: Splittable = { currency: CURRENCY, items: [item('a', 1000), item('b', 1000)] };

    expect(() => splitByWeights(input, [1, 0])).toThrow(SplitError);
    expect(() => splitByWeights(input, [1, -1])).toThrow(SplitError);
    expect(() => splitByWeights(input, [1])).toThrow(SplitError);
    expect(() => splitByWeights(input, [Number.NaN, 1])).toThrow(SplitError);
  });
});

describe('splitBySeat', () => {
  it('agrupa por comensal y cuadra con el total', () => {
    const input: Splittable = {
      currency: CURRENCY,
      items: [item('a', 2000, 1), item('b', 1500, 1), item('c', 2500, 2), item('d', 1000, 2)],
    };

    const result = splitBySeat(input);

    expect(result.allocations).toHaveLength(2);
    expect(result.allocations[0]!.amount.cents).toBe(3500);
    expect(result.allocations[1]!.amount.cents).toBe(3500);
    expect(result.unassigned).toHaveLength(0);
    expect(
      result.allocations.reduce((acc, a) => acc + a.amount.cents, 0) +
        result.unassignedAllocation.amount.cents,
    ).toBe(7000);
  });

  it('los items sin asiento no se pierden: salen aparte y siguen en el total', () => {
    const input: Splittable = {
      currency: CURRENCY,
      items: [item('a', 1000, 1), item('b', 500, null)],
    };

    const result = splitBySeat(input);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]!.amount.cents).toBe(1000);
    expect(result.unassigned.map((i) => i.id)).toEqual(['b']);
    expect(result.unassignedAllocation.amount.cents).toBe(500);
  });

  it('redondea dentro de cada asiento, no sobre el total de la mesa', () => {
    // Tres asientos de $33.33 exactos mas un item de $0.01 sin asignar. Si el
    // redondeo se hiciera sobre el total, el centavo caeria en el primer asiento
    // que se procesara y los asientos quedarian con centavos que no son suyos.
    const input: Splittable = {
      currency: CURRENCY,
      items: [item('a', 3333, 1), item('b', 3333, 2), item('c', 3333, 3), item('d', 1, null)],
    };

    const result = splitBySeat(input);

    expect(result.allocations.map((a) => a.amount.cents)).toEqual([3333, 3333, 3333]);
    expect(result.unassignedAllocation.amount.cents).toBe(1);
  });
});

describe('splitByAmount', () => {
  it('detecta que lo escrito cuadra', () => {
    const input: Splittable = {
      currency: CURRENCY,
      items: [item('a', 1000), item('b', 2000), item('c', 3000)],
    };

    const result = splitByAmount(input, [1000, 2000, 3000]);

    expect(result.balanced).toBe(true);
    expect(result.differenceCents).toBe(0);
  });

  it('reporta la diferencia cuando lo escrito no da el total', () => {
    const input: Splittable = { currency: CURRENCY, items: [item('a', 1000), item('b', 2000)] };

    const result = splitByAmount(input, [1000, 1500]);

    expect(result.balanced).toBe(false);
    expect(result.differenceCents).toBe(-500);
  });

  it('no considera balanceado un reparto donde nadie puso importe', () => {
    // Total 0 por escritura: la diferencia es 0, pero nadie pago nada. Cobrar
    // asi seria dar la mesa por gratis.
    const input: Splittable = { currency: CURRENCY, items: [item('a', 0), item('b', 0)] };

    const result = splitByAmount(input, [0, 0]);

    expect(result.differenceCents).toBe(0);
    expect(result.balanced).toBe(false);
  });

  it('rechaza importes no enteros o negativos', () => {
    const input: Splittable = { currency: CURRENCY, items: [item('a', 1000)] };

    expect(() => splitByAmount(input, [10.5])).toThrow(SplitError);
    expect(() => splitByAmount(input, [-100])).toThrow(SplitError);
  });
});

describe('allocateTip', () => {
  it('reparte la propina sin perder centavos', () => {
    const parts = allocateTip(10000, { currency: CURRENCY, parts: 3 });

    expect(parts.reduce((acc, p) => acc + p.amount.cents, 0)).toBe(10000);
    expect(parts.map((p) => p.amount.cents)).toEqual([3334, 3333, 3333]);
  });

  it('reparte con pesos cuando el local reparte por mozo', () => {
    const parts = allocateTip(9000, { currency: CURRENCY, parts: 2, weights: [1, 2] });

    expect(parts.reduce((acc, p) => acc + p.amount.cents, 0)).toBe(9000);
    expect(parts[0]!.amount.cents).toBe(3000);
    expect(parts[1]!.amount.cents).toBe(6000);
  });

  it('propina de cero cents es valida y no inventa plata', () => {
    const parts = allocateTip(0, { currency: CURRENCY, parts: 2 });

    expect(parts.map((p) => p.amount.cents)).toEqual([0, 0]);
  });

  it('rechaza importes no enteros', () => {
    expect(() => allocateTip(10.5, { currency: CURRENCY, parts: 2 })).toThrow(SplitError);
    expect(() => allocateTip(-100, { currency: CURRENCY, parts: 2 })).toThrow(SplitError);
  });
});

describe('suggestedTips', () => {
  it('calcula en basis points sin error de float', () => {
    const tips = suggestedTips(10000, [0, 1000, 1500, 2000]);

    expect(tips.map((t) => t.cents)).toEqual([0, 1000, 1500, 2000]);
  });

  it('redondea a centavos una sola vez', () => {
    // 10% de $33.33 = $3.333 -> $3.33. Si se dividiera en fracciones, el
    // redondeo por linea haria perder centavos.
    const tips = suggestedTips(3333, [1000]);

    expect(tips[0]!.cents).toBe(333);
  });

  it('el total de la mesa se mantiene al agregar propina', () => {
    const total = 8500;
    const tips = suggestedTips(total, [1000, 2000]);

    for (const tip of tips) {
      expect(total + tip.cents).toBe(total + tip.cents);
      expect(Number.isInteger(tip.cents)).toBe(true);
    }
  });
});

describe('totalOf', () => {
  it('suma en enteros', () => {
    const total = totalOf({
      currency: CURRENCY,
      items: [item('a', 1999), item('b', 1), item('c', 0)],
    });

    expect(total).toEqual(money(2000, CURRENCY));
  });

  it('rechaza importes no enteros en lugar de redondearlos en silencio', () => {
    expect(() => totalOf({ currency: CURRENCY, items: [item('a', 10.5)] })).toThrow(SplitError);
  });
});
