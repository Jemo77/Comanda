import { describe, expect, it } from 'vitest';
import { orderTotals, type OrderTotals } from './pos';

/**
 * Tests de totales de comanda.
 *
 * `orderTotals` corre en dos lugares a la vez: el POS lo evalua sobre la replica
 * local y el servidor lo recalcula al cobrar. Si los dos dieran numeros
 * distintos, el mozo muestra un total y el cliente recibe otro. Por eso el test
 * no mira "el total es correcto" sino que el total sea el mismo dato en los dos
 * caminos, y que los enteros no se dejen arrastrar por un float.
 */

const CURRENCY = 'ARS';

function line(
  unitPriceCents: number,
  quantity: number,
  modifiers: Array<{ priceDeltaCents: number }> = [],
  status: 'ACTIVE' | 'VOIDED' = 'ACTIVE',
) {
  return { unitPriceCents, quantity, modifiers, status };
}

describe('orderTotals', () => {
  it('suma precio por cantidad en enteros', () => {
    const totals = orderTotals({
      items: [line(3400, 2), line(2100, 1)],
      currency: CURRENCY,
    });

    expect(totals.subtotalCents).toBe(8900);
    expect(totals.totalCents).toBe(8900);
  });

  it('los modificadores entran en el precio unitario, no como linea aparte', () => {
    // Un capuchino con leche de almendras es un producto, no dos. Si el delta se
    // sumara una vez por item en vez de por unidad, "2 capuchinos con Shot"
    // cobraria un solo shot extra.
    const totals = orderTotals({
      items: [line(3000, 2, [{ priceDeltaCents: 500 }])],
      currency: CURRENCY,
    });

    expect(totals.subtotalCents).toBe(7000);
  });

  it('excluye los items anulados', () => {
    const totals = orderTotals({
      items: [line(3000, 1), line(5000, 1, [], 'VOIDED')],
      currency: CURRENCY,
    });

    expect(totals.subtotalCents).toBe(3000);
  });

  it('excluye un item anulado que aun trae modificadores', () => {
    const totals = orderTotals({
      items: [line(3000, 1), line(5000, 1, [{ priceDeltaCents: 900 }], 'VOIDED')],
      currency: CURRENCY,
    });

    expect(totals.subtotalCents).toBe(3000);
  });

  it('el servicio se calcula sobre el neto, no sobre la lista', () => {
    // $10.000 con $2.000 de descuento y 10% de servicio son $8.800, no $9.000.
    // Calcularlo sobre la lista es el reclamo clasico: el cartel de la mesa dice
    // un numero y el cobro otro.
    const totals = orderTotals({
      items: [line(10000, 1)],
      currency: CURRENCY,
      discountCents: 2000,
      serviceBps: 1000,
    });

    expect(totals.subtotalCents).toBe(10000);
    expect(totals.discountCents).toBe(2000);
    expect(totals.serviceCents).toBe(800);
    expect(totals.totalCents).toBe(8800);
  });

  it('acota el descuento al subtotal: nunca hay descuento sobre nada', () => {
    const totals = orderTotals({
      items: [line(1000, 1)],
      currency: CURRENCY,
      discountCents: 5000,
    });

    expect(totals.discountCents).toBe(1000);
    expect(totals.totalCents).toBe(0);
  });

  it('un descuento negativo se trata como cero', () => {
    const totals = orderTotals({
      items: [line(1000, 1)],
      currency: CURRENCY,
      discountCents: -500,
    });

    expect(totals.discountCents).toBe(0);
    expect(totals.totalCents).toBe(1000);
  });

  it('redondea el servicio a centavos enteros una sola vez', () => {
    // 10% de $33.33 = $3.333. Redondeado: $3.33. El total tiene que quedar en un
    // entero de centavos, no en $36.663.
    const totals = orderTotals({
      items: [line(3333, 1)],
      currency: CURRENCY,
      serviceBps: 1000,
    });

    expect(totals.serviceCents).toBe(333);
    expect(totals.totalCents).toBe(3666);
    expect(Number.isInteger(totals.totalCents)).toBe(true);
  });

  it('la propina se suma despues del servicio, no antes', () => {
    const totals = orderTotals({
      items: [line(10000, 1)],
      currency: CURRENCY,
      serviceBps: 1000,
      tipCents: 1200,
    });

    // 10.000 + 1.000 de servicio + 1.200 de propina.
    expect(totals.totalCents).toBe(12200);
  });

  it('calcula lo que falta cobrar con pagos mixtos', () => {
    // La mesa pago 6.000 en efectivo y 5.000 con tarjeta sobre una cuenta de
    // 12.000: todavia debe 1.000. El pago mixto es el caso normal, no la excepcion.
    const totals = orderTotals({
      items: [line(12000, 1)],
      currency: CURRENCY,
      paidCents: 11000,
    });

    expect(totals.paidCents).toBe(11000);
    expect(totals.remainingCents).toBe(1000);
  });

  it('lo pagado de mas deja la cuenta en negativo, no en cero', () => {
    // Si un local aceptara un sobrepago, ocultarlo en cero esconde un cambio mal
    // dado. El negativo es la senal de que hay que devolver plata.
    const totals = orderTotals({
      items: [line(10000, 1)],
      currency: CURRENCY,
      paidCents: 12000,
    });

    expect(totals.remainingCents).toBe(-2000);
  });

  it('una comanda vacia vale cero, no NaN', () => {
    const totals = orderTotals({ items: [], currency: CURRENCY });

    expect(totals.subtotalCents).toBe(0);
    expect(totals.totalCents).toBe(0);
    expect(totals.remainingCents).toBe(0);
    expect(Number.isNaN(totals.totalCents)).toBe(false);
  });

  it('los importes totales son siempre enteros, incluso con precios impares', () => {
    // Cantidad y precio vienen del POS y del servidor: si alguno llegara como
    // float, el total tiene que seguir siendo un entero de centavos.
    const totals = orderTotals({
      items: [line(333, 3, [{ priceDeltaCents: 111 }])],
      currency: CURRENCY,
      serviceBps: 3333,
    });

    for (const value of Object.values(totals)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe('determinismo', () => {
  it('la misma comanda da el mismo total siempre', () => {
    // El POS evalua esto offline y el servidor al cobrar. Si el resultado depende
    // del camino, el total que muestra el mozo y el que cobra el sistema
    // divergen y no hay forma de saber cual es el correcto.
    const items = [line(3400, 2, [{ priceDeltaCents: 250 }]), line(2100, 1)];
    const params = { items, currency: CURRENCY, serviceBps: 1000, discountCents: 500 };

    const first: OrderTotals = orderTotals(params);
    const second: OrderTotals = orderTotals(params);

    expect(second).toEqual(first);
  });
});
