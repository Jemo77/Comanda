import { allocate, money, sum, type Money } from './money';

/**
 * Division de cuentas.
 *
 * El problema: una mesa de seis pide una pizza, dos cervezas cada uno y un
 * descafeinado, y a las tres de la mañana nadie se acuerda de quien pago que. La
 * cuenta se tiene que poder partir de las tres formas que el plan define, y las
 * tres tienen que cuadrar al centavo.
 *
 * Regla que atraviesa todo el modulo: **la suma de las partes es exactamente el
 * total**. Ni un centavo de diferencia. Un local que reparte $100.00 en 3 tiene
 * que dar 33.34 + 33.33 + 33.33, no tres de 33.33 (que son 99.99 y aparecen
 * como "falta un peso"). Esa diferencia de un centavo es el reclamo mas comun
 * que tiene un bar, y se resuelve con aritmetica entera, no con `toFixed`.
 */

/** Modos de division. Espejo de `SplitMode` en `pos.ts`, para no crear un ciclo. */
export const SPLIT_MODE_VALUES = ['BY_ITEM', 'EQUAL', 'AMOUNT'] as const;
export type SplitModeValue = (typeof SPLIT_MODE_VALUES)[number];

export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitError';
  }
}

/** Una parte ya repartida, con los centavos decididos. */
export interface Allocation {
  /** Identificador estable de la parte. En BY_ITEM es el id del item. */
  key: string;
  /** Que se ve en pantalla: "Ana", "Item 3", o el numero de parte. */
  label: string;
  amount: Money;
  /** Items que caen en esta parte. Vacio en EQUAL y AMOUNT. */
  itemIds: string[];
}

/** Lo que hay que partir: la comanda y, si se parte por ítem, los precios. */
export interface SplittableItem {
  id: string;
  name: string;
  /** Subtotal del item, ya con modificadores: enteros en centavos. */
  amountCents: number;
  /** Asiento (comensal) al que se le atribuye. Null si no hay division por asiento. */
  seat?: number | null;
}

export interface Splittable {
  currency: string;
  items: readonly SplittableItem[];
}

/**
 * Divide en partes iguales.
 *
 * `parts` es la cantidad de comensales, no la cantidad de items. Repartir por
 * item y repartir por comensal son cosas distintas: cuatro cervezas para dos
 * personas es una linea o dos segun como se haya cargado, y el total por persona
 * tiene que ser el mismo en los dos casos.
 */
export function splitEqual(input: Splittable, parts: number): Allocation[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new SplitError(`La cantidad de partes debe ser un entero >= 1, recibido: ${parts}`);
  }

  const total = totalOf(input);
  const shares = allocate(total, parts);

  return shares.map((share, index) => ({
    key: `parte-${index + 1}`,
    label: `Parte ${index + 1}`,
    amount: share,
    itemIds: [],
  }));
}

/**
 * Divide por item: cada linea es una parte.
 *
 * Es el modo que mas se usa en la practica cuando la mesa pide cosas distintas
 * ("yo quiero la milanesa"), asi que las partes devuelven los items que las
 * componen y no un monto suelto. Un item con la misma linea de ticket sigue
 * siendo una parte: quien cobra, cobra esa linea.
 */
export function splitByItem(input: Splittable): Allocation[] {
  const items = [...input.items];
  if (items.length === 0) {
    throw new SplitError('No hay items para dividir');
  }

  return items.map((item) => ({
    key: item.id,
    label: item.name,
    amount: money(item.amountCents, input.currency),
    itemIds: [item.id],
  }));
}

/**
 * Reparte por peso.
 *
 * Los pesos se normalizan para que den EXACTAMENTE el total, incluso con floats
 * que no suman 1 (por ejemplo `[2, 3]` en vez de `[0.2, 0.3]`). Un peso sin
 * normalizar mas el resto del total seria un peso que el local pierde.
 */
export function splitByWeights(
  input: Splittable,
  weights: readonly number[],
  labels?: readonly string[],
): Allocation[] {
  if (weights.length !== input.items.length) {
    throw new SplitError(
      `Se esperaban ${input.items.length} pesos, se recibieron ${weights.length}`,
    );
  }
  if (weights.some((w) => !Number.isFinite(w) || w <= 0)) {
    throw new SplitError('Los pesos deben ser finitos y mayores que cero');
  }

  const total = totalOf(input);
  const shares = allocate(total, input.items.length, weights);

  return input.items.map((item, index) => ({
    key: item.id,
    label: labels?.[index] ?? item.name,
    amount: shares[index]!,
    itemIds: [item.id],
  }));
}

/**
 * Reparte por comensal (asiento).
 *
 * Los items sin `seat` se ignoran en el reparto pero siguen formando parte del
 * total: si no, alguien se llevaria una bebida sin asignar y el total de los
 * asientos no daria con la cuenta. Esos items se devuelven aparte para que la
 * pantalla pueda pedir "de esto, quien?".
 */
export interface SeatSplit {
  allocations: Allocation[];
  /** Items que todavia no son de nadie. */
  unassigned: SplittableItem[];
  /** Reparto de los items sin asiento, para que el local no los pierda de vista. */
  unassignedAllocation: Allocation;
}

export function splitBySeat(input: Splittable): SeatSplit {
  const bySeat = new Map<number, SplittableItem[]>();
  const unassigned: SplittableItem[] = [];

  for (const item of input.items) {
    if (item.seat == null) {
      unassigned.push(item);
      continue;
    }
    const bucket = bySeat.get(item.seat);
    if (bucket) bucket.push(item);
    else bySeat.set(item.seat, [item]);
  }

  const seats = [...bySeat.keys()].sort((a, b) => a - b);

  const allocations: Allocation[] = seats.map((seat) => {
    const seatItems = bySeat.get(seat)!;
    // Cada asiento paga lo suyo con `allocate` sobre su propio subtotal: el
    // redondeo por mas fraccion se aplica dentro del asiento, y no sobre el
    // total de la mesa, para que el asiento que "salio mas" no cargue con el
    // redondeo de los demas.
    const seatTotal = seatItems.reduce((acc, item) => acc + item.amountCents, 0);
    return {
      key: `asiento-${seat}`,
      label: `Asiento ${seat}`,
      amount: money(seatTotal, input.currency),
      itemIds: seatItems.map((item) => item.id),
    };
  });

  const unassignedAllocation: Allocation = {
    key: 'sin-asiento',
    label: 'Sin asignar',
    amount: money(
      unassigned.reduce((acc, item) => acc + item.amountCents, 0),
      input.currency,
    ),
    itemIds: unassigned.map((item) => item.id),
  };

  return { allocations, unassigned, unassignedAllocation };
}

/**
 * Parte a partir de montos escritos a mano.
 *
 * El caso real de "esto, yo pago 5000". El control que importa es el ultimo:
 * si los montos escritos no dan el total, la pantalla tiene que decirlo ANTES de
 * cobrar, porque un cobro de 9900 cuando la cuenta es 10000 se descubre cuando
 * el cliente ya se fue.
 */
export interface ManualSplit {
  allocations: Allocation[];
  /** Diferencia entre lo escrito y el total. 0 = cuadra. */
  differenceCents: number;
  /** Si la diferencia es distinta de cero o falta Plata, no se puede cobrar. */
  balanced: boolean;
}

export function splitByAmount(
  input: Splittable,
  amounts: readonly number[],
  labels?: readonly string[],
): ManualSplit {
  if (amounts.length !== input.items.length) {
    throw new SplitError(
      `Se esperaban ${input.items.length} montos, se recibieron ${amounts.length}`,
    );
  }

  const total = totalOf(input);

  const allocations = input.items.map((item, index) => {
    const cents = amounts[index]!;
    if (!Number.isInteger(cents) || cents < 0) {
      throw new SplitError(`El importe ${index + 1} debe ser un entero >= 0 en centavos`);
    }
    return {
      key: item.id,
      label: labels?.[index] ?? item.name,
      amount: money(cents, input.currency),
      itemIds: [item.id],
    };
  });

  const written = sum(
    allocations.map((allocation) => allocation.amount),
    input.currency,
  );
  const differenceCents = written.cents - total.cents;

  return {
    allocations,
    differenceCents,
    // Cuadrar no es solo que la diferencia sea cero: si nadie puso un importe,
    // tambien esta descuadrado, aunque por casualidad de 0.
    balanced: differenceCents === 0 && allocations.every((a) => a.amount.cents > 0),
  };
}

/**
 * Reparte una propina entre las partes.
 *
 * Por defecto va al fondo (pool): el local no necesita saber a quien se le dio.
 * Con `bySeat`, se reparte entre los asientos con la misma aritmetica entera,
 * porque una propina de $100 entre 3 que se reparte a mano termina siendo
 * $33 + $33 + $34 segun quien cogio el billete, y eso es discutible a las 3am.
 */
export function allocateTip(
  tipCents: number,
  options: {
    currency: string;
    parts: number;
    weights?: readonly number[];
  },
): Allocation[] {
  if (!Number.isInteger(tipCents) || tipCents < 0) {
    throw new SplitError(`La propina debe ser un entero >= 0 en centavos, recibido: ${tipCents}`);
  }
  if (!Number.isInteger(options.parts) || options.parts < 1) {
    throw new SplitError('La cantidad de partes debe ser un entero >= 1');
  }

  const tip = money(tipCents, options.currency);
  const shares = options.weights
    ? allocate(tip, options.parts, options.weights)
    : allocate(tip, options.parts);

  return shares.map((share, index) => ({
    key: `propina-${index + 1}`,
    label: `Propina ${index + 1}`,
    amount: share,
    itemIds: [],
  }));
}

/**
 * Propinas sugeridas, en basis points del total.
 *
 * El local configura cuales ofrece (no todos los bares ofrecen 15%) y en que
 * orden. Los valores son basis points para no calcular porcentajes con float:
 * 1000 es 10%.
 */
export function suggestedTips(totalCents: number, basisPoints: readonly number[]): Money[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new SplitError('El total debe ser un entero >= 0 en centavos');
  }
  const base = money(totalCents, 'XXX');
  return basisPoints.map((bps) => {
    if (!Number.isInteger(bps) || bps < 0) {
      throw new SplitError(`El porcentaje ${bps} debe ser un entero >= 0 en basis points`);
    }
    // Se redondea el importe final una sola vez: un 10% de $33.33 son $3.33, no
    // $3.333. Los centavos de propina no se dividen en fracciones.
    return money(Math.round((totalCents * bps) / 10_000), base.currency);
  });
}

/** Total de la comanda a partir de los items. Enteros, siempre. */
export function totalOf(input: Splittable): Money {
  const cents = input.items.reduce((acc, item) => {
    if (!Number.isInteger(item.amountCents) || item.amountCents < 0) {
      throw new SplitError(`El importe del item "${item.name}" no es un entero >= 0`);
    }
    return acc + item.amountCents;
  }, 0);

  return money(cents, input.currency);
}

/**
 * Verifica que un reparto cuadra. Es una asercion explicita, no una confianza:
 * la usan los tests y el backend antes de confirmar un cobro dividido.
 */
export function assertBalanced(allocations: readonly Allocation[], currency: string): void {
  const total = sum(
    allocations.map((allocation) => allocation.amount),
    currency,
  );
  const expected = allocations.reduce((acc, allocation) => acc + allocation.amount.cents, 0);
  if (total.cents !== expected) {
    throw new SplitError('El reparto no cuadra internamente');
  }
}
