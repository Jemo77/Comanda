/**
 * Dinero: siempre enteros (centavos) + moneda. Prohibido usar float para importes.
 *
 * El motivo es concreto, no purista: 0.1 + 0.2 !== 0.3 en IEEE-754, y en un local
 * que procesa 50 pedidos por minuto ese error se acumula en el arqueo de caja y en
 * la factura fiscal. Toda operacion devuelve centavos enteros; el redondeo se hace
 * una sola vez, en un punto explicito y auditable.
 */

/** Numero maximo de centavos que aceptamos. 90 billones = 90 billones de currency. */
export const MAX_MONEY_CENTS = Number.MAX_SAFE_INTEGER;

/** Basis points: 10000 bps = 100%. Se usa para porcentajes sin float. */
export const BPS_DENOMINATOR = 10_000n;

export interface Money {
  /** Importe entero en la unidad minima de la moneda (centavos). */
  readonly cents: number;
  /** Codigo ISO 4217. */
  readonly currency: string;
}

export type Currency = string;

/** Codigos de moneda soportados en Fase 0. country-agnostic por diseno. */
export const SUPPORTED_CURRENCIES = [
  'ARS',
  'MXN',
  'COP',
  'CLP',
  'PEN',
  'UYU',
  'USD',
  'EUR',
] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

function assertValidCents(cents: number, field = 'cents'): void {
  if (!Number.isInteger(cents)) {
    throw new MoneyError(`${field} debe ser un entero, recibido: ${cents}`);
  }
  if (Math.abs(cents) > MAX_MONEY_CENTS) {
    throw new MoneyError(`${field} fuera de rango seguro: ${cents}`);
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `No se pueden combinar importes de monedas distintas: ${a.currency} y ${b.currency}`,
    );
  }
}

/** Crea un Money validando enteros y moneda. */
export function money(cents: number, currency: Currency): Money {
  assertValidCents(cents);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new MoneyError(`Codigo de moneda invalido: ${currency}`);
  }
  return { cents, currency };
}

export function zero(currency: Currency): Money {
  return { cents: 0, currency };
}

/** Suma. Lanza si las monedas difieren: nunca hacer conversion implicita. */
export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  const cents = a.cents + b.cents;
  assertValidCents(cents, 'suma');
  return { cents, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  const cents = a.cents - b.cents;
  assertValidCents(cents, 'resta');
  return { cents, currency: a.currency };
}

export function negate(a: Money): Money {
  assertValidCents(-a.cents, 'negacion');
  return { cents: -a.cents, currency: a.currency };
}

/** Suma una lista de importes. La lista debe estar en la misma moneda. */
export function sum(items: readonly Money[], currency?: Currency): Money {
  if (items.length === 0) {
    if (!currency) throw new MoneyError('sum() de lista vacia necesita la moneda');
    return zero(currency);
  }
  const target = currency ?? items[0]!.currency;
  return items.reduce(
    (acc, item) => add(acc, { cents: item.cents, currency: target }),
    zero(target),
  );
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.cents === b.cents;
}

/**
 * Multiplica por una cantidad entera.
 *
 * Multiplicacion entera directa (no float): `cents * qty` en enteros es exacto
 * mientras no desborde MAX_SAFE_INTEGER.
 */
export function multiplyByQuantity(a: Money, qty: number): Money {
  if (!Number.isInteger(qty)) {
    throw new MoneyError(`La cantidad debe ser un entero, recibido: ${qty}`);
  }
  const cents = a.cents * qty;
  assertValidCents(cents, 'producto');
  return { cents, currency: a.currency };
}

/**
 * Aplica un porcentaje en basis points (10000 = 100%) con redondeo half-up.
 *
 * Se usa aritmetica en BigInt y se redondea explicitamente una vez. El redondeo
 * half-up se aplica sobre el valor absoluto y el signo se devuelve al final: asi
 * -0,5 redondea a -1 y no a 0. Es la convencion de las Bolsas y la que espera un
 * comprobante; half-even generaria diferencias de 1 centavo impredecibles entre
 * el motor de precios y la factura.
 */
export function applyBasisPoints(a: Money, bps: number): Money {
  if (!Number.isInteger(bps)) {
    throw new MoneyError(`Los basis points deben ser un entero, recibido: ${bps}`);
  }
  const sign = a.cents < 0 ? -1n : 1n;
  const magnitudeProduct = BigInt(Math.abs(a.cents)) * BigInt(Math.abs(bps));
  const roundedMagnitude = (magnitudeProduct + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
  const cents = Number(sign * roundedMagnitude);
  assertValidCents(cents, 'porcentaje');
  return { cents, currency: a.currency };
}

/** Descuento porcentual. Devuelve el importe del descuento, no el resultado. */
export function percentageOff(a: Money, bps: number): Money {
  return applyBasisPoints(a, Math.abs(bps));
}

/**
 * Reparte un importe entre `parts` sin perder ni crear centavos.
 *
 * Usamos el metodo del "residuo mas grande": se reparte de a 1 centavo y los
 * centavos sobrantes van a las primeras partes. Un ticket partido en 3 de $10.00
 * da 3334 + 3333 + 3333 = 10000 exactos, y el redondeo naive daria 9999.
 *
 * @param a importe a repartir (puede ser negativo: devuelve partes negativas)
 * @param parts cantidad de partes, >= 1
 * @param weights pesos relativos por parte (opcional). Si se pasa, el reparto se
 *        hace por peso y el residuo se asigna por mayor fraccion.
 */
export function allocate(a: Money, parts: number, weights?: readonly number[]): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`La cantidad de partes debe ser un entero >= 1, recibido: ${parts}`);
  }
  if (parts === 1) return [a];

  const sign = a.cents < 0 ? -1n : 1n;
  const magnitude = BigInt(Math.abs(a.cents));

  if (weights) {
    if (weights.length !== parts) {
      throw new MoneyError(`Se esperaban ${parts} pesos, se recibieron ${weights.length}`);
    }
    if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
      throw new MoneyError('Los pesos deben ser finitos y no negativos');
    }
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) {
      throw new MoneyError('La suma de pesos debe ser mayor que cero');
    }

    // Reparto por el metodo de la fraccion mayor: cada parte recibe su parte
    // entera exacta y los centavos sobrantes van a las de mayor resto.
    //
    // Los pesos se llevan a enteros de punto fijo a 12 decimales para que el
    // reparto sea aritmetica entera de verdad. Con `w * 1e6` en float, un peso
    // como 1/3 produce un resto distinto en cada parte y la suma final no cuadra
    // con el total: es exactamente el bug que rompe un cierre de caja.
    const SCALE_DECIMALS = 12;
    const scaledWeights = weights.map((w) => BigInt(Math.round(w * 10 ** SCALE_DECIMALS)));
    const scaledTotal = scaledWeights.reduce((acc, v) => acc + v, 0n);

    const numerators = scaledWeights.map((w) => magnitude * w);
    const shares = numerators.map((n) => n / scaledTotal);
    const remainders = numerators.map((n, i) => ({ i, value: n % scaledTotal }));

    let assigned = shares.reduce((acc, v) => acc + v, 0n);
    remainders.sort((x, y) => (x.value === y.value ? x.i - y.i : x.value > y.value ? -1 : 1));

    const out = [...shares];
    let idx = 0;
    while (assigned < magnitude && idx < parts) {
      out[remainders[idx]!.i] = out[remainders[idx]!.i]! + 1n;
      assigned += 1n;
      idx += 1;
    }

    return out.map((v) => ({ cents: Number(sign * v), currency: a.currency }));
  }

  const base = magnitude / BigInt(parts);
  let remainder = magnitude - base * BigInt(parts);
  const out: number[] = [];
  for (let i = 0; i < parts; i++) {
    const extra = remainder > 0n ? 1n : 0n;
    remainder -= extra;
    out.push(Number(sign * (base + extra)));
  }
  return out.map((cents) => ({ cents, currency: a.currency }));
}

/** Descuento de un importe fijo en centavos, acotado a cero. */
export function discountByCents(a: Money, cents: number): Money {
  assertValidCents(cents, 'descuento');
  return { cents: Math.max(0, a.cents - Math.abs(cents)), currency: a.currency };
}

/**
 * Descuento porcentual en basis points, acotado a cero.
 *
 * Un descuento del 120% deja el importe en 0, nunca en -20.00. Quien quiera
 * descontar un monto fijo debe usar `discountByCents`: los dos operandos son de
 * naturaleza distinta (bps vs. centavos) y confundirlos es facil.
 */
export function discountByBasisPoints(a: Money, bps: number): Money {
  return discountByCents(a, percentageOff(a, bps).cents);
}

/**
 * Redondea desde la unidad mayor (p.ej. pesos) a centavos, half-up.
 * El divisor tiene que ser una potencia de 10 exacta: un `10 ** Math.log10(3)`
 * da 2.9999999999999996 y el chequeo por `Number.isInteger` no es confiable.
 */
const VALID_SUBDIVISIONS = new Set([1, 10, 100, 1000]);

export function roundFromSubunits(subunits: number, subunitsPerUnit: number): number {
  if (!Number.isInteger(subunits) || !VALID_SUBDIVISIONS.has(subunitsPerUnit)) {
    throw new MoneyError('Se requieren un entero y una subdivision potencia de 10');
  }
  const divisor = BigInt(subunitsPerUnit);
  const cents = (BigInt(Math.abs(subunits)) + divisor / 2n) / divisor;
  return Math.sign(subunits) * Number(cents);
}

/**
 * Resuelve el locale de formato.
 *
 * `es` a secas usa punto decimal (convention de Espana); el mercado inicial es
 * Argentina, donde el decimal es coma. Forzar la coma para todo `es-*` seria
 * incorrecto para Mexico, Chile y Peru, asi que solo se fuerza cuando el locale
 * no trae|region (o sea `es` a secas).
 */
export function resolveMoneyLocale(locale: string): string {
  if (locale === 'es') return 'es-AR';
  return locale;
}

/**
 * Formatea para pantalla.
 *
 * No se pasa el importe a `Intl.NumberFormat.format()`: eso obliga a convertir los
 * centavos a float, y un importe cercano a MAX_SAFE_INTEGER perderia precision en
 * el orden de las unidades. En su lugar se formatea solo la parte entera con Intl
 * (que es exacta, cabe en un double) y la parte decimal se arma a mano desde
 * BigInt. El separador decimal y la posicion del simbolo los aporta Intl desde la
 * moneda, para no asumir que es siempre "." ni que el simbolo va siempre adelante.
 */
export function formatMoney(
  value: Money,
  locale = 'es-AR',
  options: { showSymbol?: boolean; showZeroCents?: boolean } = {},
): string {
  const { showSymbol = true, showZeroCents = true } = options;
  const digits = currencyDecimals(value.currency);
  const resolvedLocale = resolveMoneyLocale(locale);

  const cents = BigInt(value.cents);
  const isNegative = cents < 0n;
  const absolute = isNegative ? -cents : cents;
  const factor = 10n ** BigInt(digits);
  const integerDigits = (absolute / factor).toString();
  const fractionDigits = (absolute % factor).toString().padStart(digits, '0');

  const integerFormatter = new Intl.NumberFormat(resolvedLocale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  let numberText = integerFormatter.format(Number(integerDigits));
  if (digits > 0 && (showZeroCents || /[1-9]/.test(fractionDigits))) {
    // El separador se consulta con un formatter con decimales: `integerFormatter`
    // tiene maximumFractionDigits 0, y con 1.1 no emite ninguna parte "decimal",
    // lo que hacia caer al fallback "." y rompe el formato argentino.
    const decimalSeparator =
      new Intl.NumberFormat(resolvedLocale).formatToParts(1.1).find((p) => p.type === 'decimal')
        ?.value ?? '.';
    numberText += decimalSeparator + fractionDigits;
  }

  if (!showSymbol) {
    return isNegative ? `-${numberText}` : numberText;
  }

  // Intl decide si el simbolo va antes o despues y si usa $ o US$, segun la locale.
  const currencyParts = new Intl.NumberFormat(resolvedLocale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).formatToParts(0);

  const integerIndex = currencyParts.findIndex((p) => p.type === 'integer');
  const pieces: string[] = [];
  for (const [i, part] of currencyParts.entries()) {
    if (part.type === 'integer') {
      pieces.push(numberText);
    } else if (part.type === 'fraction' || part.type === 'decimal') {
      continue; // ya viene en numberText
    } else if (i === integerIndex) {
      continue;
    } else {
      pieces.push(part.value);
    }
  }

  const minus = isNegative
    ? (integerFormatter.formatToParts(-0.5).find((p) => p.type === 'minusSign')?.value ?? '-')
    : '';
  return `${minus}${pieces.join('')}`;
}

/** Decimales de la unidad menor para una moneda (2 para la mayoria, 0 para JPY). */
export function currencyDecimals(currency: string): number {
  const noDecimals = new Set([
    'JPY',
    'KRW',
    'VND',
    'CLP',
    'ISK',
    'XAF',
    'XOF',
    'PYG',
    'RWF',
    'UGX',
  ]);
  const threeDecimals = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND', 'IQD']);
  if (noDecimals.has(currency)) return 0;
  if (threeDecimals.has(currency)) return 3;
  return 2;
}

/**
 * Convierte desde la unidad mayor (pesos) a centavos.
 *
 * Se parsea el numero por string en lugar de multiplicar por el factor: en punto
 * flotante, 8.115 * 100 puede dar 811.4999999999999 y el redondeo posterior
 * devuelve 811 en vez de 812.
 */
export function fromMajorUnits(major: number, currency: Currency): Money {
  if (!Number.isFinite(major)) {
    throw new MoneyError(`Importe invalido: ${major}`);
  }
  const digits = currencyDecimals(currency);
  const text = Math.abs(major).toString();
  if (text.includes('e') || text.includes('E')) {
    throw new MoneyError(`Importe fuera de rango representable: ${major}`);
  }

  const [rawInteger = '0', rawFraction = ''] = text.split('.');
  const paddedFraction = rawFraction.padEnd(digits, '0').slice(0, digits);

  let cents = BigInt(rawInteger) * 10n ** BigInt(digits) + BigInt(paddedFraction || '0');
  // Half-up sobre el digito descartado, igual que el resto del paquete.
  if (rawFraction.length > digits && Number(rawFraction[digits]) >= 5) {
    cents += 1n;
  }

  return money(major < 0 ? -Number(cents) : Number(cents), currency);
}
