import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  applyBasisPoints,
  currencyDecimals,
  discountByBasisPoints,
  discountByCents,
  equals,
  formatMoney,
  fromMajorUnits,
  money,
  MoneyError,
  multiplyByQuantity,
  percentageOff,
  resolveMoneyLocale,
  roundFromSubunits,
  subtract,
  sum,
  zero,
} from './money';

const ARS = 'ARS';

describe('money', () => {
  it('rechaza centavos no enteros', () => {
    expect(() => money(10.5, ARS)).toThrow(MoneyError);
    expect(() => money(NaN, ARS)).toThrow();
  });

  it('rechaza importes fuera del rango seguro', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, ARS)).toThrow(/rango/);
  });

  it('rechaza codigos de moneda invalidos', () => {
    expect(() => money(100, 'peso')).toThrow(/moneda/);
    expect(() => money(100, 'ars')).toThrow(/moneda/);
  });
});

describe('add / subtract', () => {
  it('suma y resta en la misma moneda', () => {
    expect(add(money(1000, ARS), money(250, ARS))).toEqual({ cents: 1250, currency: ARS });
    expect(subtract(money(1000, ARS), money(250, ARS))).toEqual({ cents: 750, currency: ARS });
  });

  it('no permite mezclar monedas', () => {
    expect(() => add(money(100, ARS), money(100, 'USD'))).toThrow(/monedas distintas/);
    expect(() => subtract(money(100, ARS), money(100, 'MXN'))).toThrow(/monedas distintas/);
  });
});

describe('sum', () => {
  it('suma una lista', () => {
    expect(sum([money(100, ARS), money(200, ARS), money(300, ARS)])).toEqual({
      cents: 600,
      currency: ARS,
    });
  });

  it('devuelve cero para lista vacia si se indica la moneda', () => {
    expect(sum([], ARS)).toEqual(zero(ARS));
  });

  it('exige la moneda en lista vacia', () => {
    expect(() => sum([])).toThrow(MoneyError);
  });
});

describe('multiplyByQuantity', () => {
  it('multiplica exacto sin arrastrar error de float', () => {
    // El clasico: 0.1 * 3 en float da 0.30000000000000004. Con enteros da 30.
    expect(multiplyly(money(10, ARS), 3)).toEqual({ cents: 30, currency: ARS });
    expect(multiplyByQuantity(money(333, ARS), 3)).toEqual({ cents: 999, currency: ARS });
  });

  it('rechaza cantidades no enteras', () => {
    expect(() => multiplyByQuantity(money(100, ARS), 1.5)).toThrow(/entero/);
  });
});

// Alias de test para no shadowear.
const multiplyly = multiplyByQuantity;

describe('applyBasisPoints', () => {
  it('aplica porcentajes sin float', () => {
    // 21% de 10000 = 2100 exacto
    expect(applyBasisPoints(money(10000, ARS), 2100)).toEqual({ cents: 2100, currency: ARS });
    // 10% de 9999 = 999.9 -> half-up 1000
    expect(applyBasisPoints(money(9999, ARS), 1000)).toEqual({ cents: 1000, currency: ARS });
    // 33.33% de 1000 = 333.3 -> 333
    expect(applyBasisPoints(money(1000, ARS), 3333)).toEqual({ cents: 333, currency: ARS });
  });

  it('redondea half-up simetricamente', () => {
    expect(applyBasisPoints(money(5, ARS), 1000)).toEqual({ cents: 1, currency: ARS });
    expect(applyBasisPoints(money(-5, ARS), 1000)).toEqual({ cents: -1, currency: ARS });
  });

  it('rechaza bps no enteros', () => {
    expect(() => applyBasisPoints(money(100, ARS), 10.5)).toThrow(MoneyError);
  });

  it('percentageOff ignora el signo', () => {
    expect(percentageOff(money(1000, ARS), -500)).toEqual({ cents: 50, currency: ARS });
  });
});

describe('discountByCents / discountByBasisPoints', () => {
  it('resta centavos fijos', () => {
    expect(discountByCents(money(10_000, ARS), 2_500)).toEqual({ cents: 7_500, currency: ARS });
    // Se ignora el signo: un descuento nunca suma.
    expect(discountByCents(money(10_000, ARS), -2_500)).toEqual({ cents: 7_500, currency: ARS });
  });

  it('nunca produce un importe negativo', () => {
    // Un descuento del 120% no puede dejar la cuenta en -2000.
    expect(discountByBasisPoints(money(10_000, ARS), 12_000)).toEqual({ cents: 0, currency: ARS });
    expect(discountByCents(money(100, ARS), 5_000)).toEqual({ cents: 0, currency: ARS });
  });

  it('aplica el descuento dentro del rango', () => {
    expect(discountByBasisPoints(money(10_000, ARS), 1_500)).toEqual({
      cents: 8_500,
      currency: ARS,
    });
  });

  it('rechaza centavos no enteros', () => {
    expect(() => discountByCents(money(100, ARS), 10.5)).toThrow(MoneyError);
  });
});

describe('allocate', () => {
  it('reparte sin perder ni crear centavos (3 partes de 10000)', () => {
    const parts = allocate(money(10000, ARS), 3);
    expect(parts).toEqual([
      { cents: 3334, currency: ARS },
      { cents: 3333, currency: ARS },
      { cents: 3333, currency: ARS },
    ]);
    expect(sum(parts).cents).toBe(10000);
  });

  it('reparte 7 partes de 100 centavos exactamente', () => {
    const parts = allocate(money(100, ARS), 7);
    expect(parts.map((p) => p.cents)).toEqual([15, 15, 14, 14, 14, 14, 14]);
    expect(sum(parts).cents).toBe(100);
  });

  it('una sola parte devuelve el importe completo', () => {
    expect(allocate(money(777, ARS), 1)).toEqual([{ cents: 777, currency: ARS }]);
  });

  it('maneja importes negativos', () => {
    const parts = allocate(money(-100, ARS), 3);
    expect(sum(parts).cents).toBe(-100);
    expect(parts.every((p) => p.cents <= 0)).toBe(true);
  });

  it('reparte por pesos', () => {
    const parts = allocate(money(1000, ARS), 3, [1, 1, 1]);
    expect(sum(parts).cents).toBe(1000);

    const weighted = allocate(money(1000, ARS), 2, [3, 1]);
    expect(sum(weighted).cents).toBe(1000);
    expect(weighted[0]!.cents).toBeGreaterThan(weighted[1]!.cents);
  });

  it('valida los argumentos', () => {
    expect(() => allocate(money(100, ARS), 0)).toThrow(MoneyError);
    expect(() => allocate(money(100, ARS), 2.5)).toThrow(MoneyError);
    expect(() => allocate(money(100, ARS), 2, [1, 2, 3])).toThrow(/pesos/);
    expect(() => allocate(money(100, ARS), 2, [-1, 1])).toThrow(/pesos/);
    expect(() => allocate(money(100, ARS), 2, [0, 0])).toThrow(/mayor que cero/);
  });

  it('es idempotente en muchas divisiones', () => {
    for (const total of [1, 7, 99, 100, 1001, 999999]) {
      for (const parts of [1, 2, 3, 7, 13]) {
        const result = allocate(money(total, ARS), parts);
        expect(sum(result).cents).toBe(total);
        // La diferencia entre partes nunca supera 1 centavo.
        const values = result.map((r) => r.cents);
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('roundFromSubunits', () => {
  it('redondea a centavos', () => {
    expect(roundFromSubunits(1050, 100)).toBe(11);
    expect(roundFromSubunits(-1050, 100)).toBe(-11);
  });

  it('rechaza subdivisiones que no son potencia de 10', () => {
    expect(() => roundFromSubunits(100, 3)).toThrow(/potencia de 10/);
    expect(() => roundFromSubunits(10.5, 100)).toThrow(MoneyError);
  });
});

/**
 * En es-AR el simbolo va seguido de espacio duro (U+00A0), no de un espacio
 * comun: es la convencion de Intl y evita que el monto "salte de linea" en un
 * ticket estrecho. Los tests lo verifican de forma explicita.
 */
const NBSP = '\u00a0';

describe('currencyDecimals / formatMoney', () => {
  it('conoce las excepciones de subdivision', () => {
    expect(currencyDecimals('ARS')).toBe(2);
    expect(currencyDecimals('JPY')).toBe(0);
    expect(currencyDecimals('KWD')).toBe(3);
  });

  it('formatea para es-AR con coma decimal y espacio duro', () => {
    expect(formatMoney(money(1420000, ARS))).toBe(`$${NBSP}14.200,00`);
    expect(formatMoney(money(1, ARS))).toBe(`$${NBSP}0,01`);
  });

  it('coloca el signo menos antes del simbolo en importes negativos', () => {
    expect(formatMoney(money(-1420001, ARS), 'es-AR')).toBe(`-$${NBSP}14.200,01`);
  });

  it('puede omitir el simbolo y los centavos', () => {
    expect(formatMoney(money(1420000, ARS), 'es-AR', { showSymbol: false })).toBe('14.200,00');
    expect(formatMoney(money(1420000, ARS), 'es-AR', { showZeroCents: false })).toBe(
      `$${NBSP}14.200`,
    );
    // Con centavos que no son cero, omitirlos cambiaria el importe: se conservan.
    expect(formatMoney(money(1420050, ARS), 'es-AR', { showZeroCents: false })).toBe(
      `$${NBSP}14.200,50`,
    );
  });

  it('formatea monedas sin centavos con el simbolo de la locale', () => {
    // JPY no tiene subdivision, asi que 1500 centavos son 1500 yen enteros.
    expect(formatMoney(money(1500, 'JPY'), 'ja-JP')).toBe('￥1,500');
    expect(formatMoney(money(1500, 'JPY'), 'en-US')).toBe('¥1,500');
  });

  it('usa coma decimal en es-AR y respeta las demas locales', () => {
    expect(formatMoney(money(1420000, ARS), 'es-AR')).toBe(`$${NBSP}14.200,00`);
    expect(formatMoney(money(1420000, ARS), 'es')).toBe(`$${NBSP}14.200,00`);
    // Mexico y Chile comparten el codigo "es" pero no la convencion argentina.
    expect(formatMoney(money(1420000, 'MXN'), 'es-MX')).toBe('$14,200.00');
    expect(resolveMoneyLocale('es')).toBe('es-AR');
    expect(resolveMoneyLocale('es-MX')).toBe('es-MX');
  });
});

describe('fromMajorUnits / equals', () => {
  it('convierte desde la unidad mayor', () => {
    expect(fromMajorUnits(15.5, ARS)).toEqual({ cents: 1550, currency: ARS });
    expect(fromMajorUnits(1500, 'JPY')).toEqual({ cents: 1500, currency: 'JPY' });
  });

  it('equals compara valor y moneda', () => {
    expect(equals(money(100, ARS), money(100, ARS))).toBe(true);
    expect(equals(money(100, ARS), money(100, 'USD'))).toBe(false);
  });
});
