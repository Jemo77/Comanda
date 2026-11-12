import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orderTotals } from '@comanda/domain';
import type { PromotionRule } from '@comanda/pricing-engine';
import type { LocalOrder, LocalOrderItem } from '../data/db';

// La outbox y la replica se stubean antes de importar el store: los tests tienen que
// correr en Node, y Dexie necesita `indexedDB`. Lo que se prueba aca es la logica
// de suma y de validacion, no la persistencia, que es de Dexie.
const enqueued: Array<{ type: string; payload: Record<string, unknown> }> = [];
const written = {
  orders: [] as LocalOrder[],
  items: [] as LocalOrderItem[],
};

vi.mock('../data/sync', () => ({
  enqueueEvent: async (type: string, payload: Record<string, unknown>) => {
    enqueued.push({ type, payload });
    return true;
  },
}));

vi.mock('../data/db', () => ({
  db: {
    orders: {
      put: async (order: LocalOrder) => {
        written.orders.push(order);
      },
      update: async () => undefined,
    },
    orderItems: {
      put: async (item: LocalOrderItem) => {
        written.items.push(item);
      },
      update: async () => undefined,
      bulkPut: async () => undefined,
    },
    kitchenTickets: {
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => undefined,
      // La cocina se lee con `where(...).equals(...)`, que devuelve una coleccion:
      // el mock tiene que soportar el `.toArray()` o el store revienta en una promesa
      // flotante y el test pasa sin probar nada.
      where: () => ({
        equals: () => ({
          toArray: async () => [] as unknown[],
          delete: async () => undefined,
        }),
      }),
    },
    stations: { get: async () => undefined },
  },
}));

const { computeTotals, itemTotalCents, useOrder } = await import('./order');
const { setActiveRules } = await import('./pricing');

/** Comanda de prueba. */
const order: LocalOrder = {
  id: 'order-1',
  venueId: 'venue-1',
  tableId: 'table-1',
  tableLabel: '3',
  numberLabel: '3',
  channel: 'POS',
  status: 'OPEN',
  openedAt: '2026-01-01T00:00:00.000Z',
  openedBy: '',
  guests: 2,
  discountCents: 0,
  serviceBps: 0,
};

/** Item de prueba. */
function item(overrides: Partial<LocalOrderItem> = {}): LocalOrderItem {
  return {
    id: 'item-1',
    orderId: 'order-1',
    productId: 'product-1',
    name: 'Capuchino',
    quantity: 1,
    unitPriceCents: 3400,
    appliedRules: [],
    status: 'ACTIVE',
    course: 1,
    seat: null,
    note: null,
    modifiers: [],
    voidReason: null,
    voidedAt: null,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  enqueued.length = 0;
  written.orders.length = 0;
  written.items.length = 0;
  // La cache de precios es de modulo: sin este reset, la promo de
  // un test se aplicaria en el siguiente.
  setActiveRules([]);
  useOrder.getState().reset();
});

describe('computeTotals', () => {
  it('suma los items activos con sus modificadores adentro del precio', () => {
    const totals = computeTotals({
      order,
      items: [
        item(),
        item({
          id: 'item-2',
          quantity: 2,
          modifiers: [{ name: 'Doble', modifierId: null, priceDeltaCents: 250 }],
        }),
      ],
      paidCents: 0,
      tipCents: 0,
    });

    // 3400 + (3400 + 250) * 2 = 10700
    expect(totals.subtotalCents).toBe(10_700);
  });

  it('un item anulado no suma, y el motivo no cambia el total', () => {
    const totals = computeTotals({
      order,
      items: [item(), item({ id: 'item-2', status: 'VOIDED', voidReason: 'Se cayo' })],
      paidCents: 0,
      tipCents: 0,
    });

    expect(totals.subtotalCents).toBe(3400);
  });

  it('el servicio se calcula sobre el neto, no sobre la lista', () => {
    // Un descuento del 1000 sobre 10000 y 10% de servicio dan 990, no 1000: el
    // local que cobra servicio sobre lo que ya desconto es el reclamo clasico.
    const totals = computeTotals({
      order: { ...order, discountCents: 1000, serviceBps: 1000 },
      items: [item({ unitPriceCents: 10_000 })],
      paidCents: 0,
      tipCents: 0,
    });

    expect(totals.subtotalCents).toBe(10_000);
    expect(totals.discountCents).toBe(1000);
    expect(totals.serviceCents).toBe(900);
    expect(totals.totalCents).toBe(9_900);
  });

  it('un descuento mayor que la cuenta deja el total en cero, nunca negativo', () => {
    const totals = computeTotals({
      order: { ...order, discountCents: 999_999 },
      items: [item({ unitPriceCents: 1000 })],
      paidCents: 0,
      tipCents: 0,
    });

    expect(totals.totalCents).toBe(0);
  });

  it('el restante es lo que falta cobrar, con los pagos ya hechos', () => {
    const totals = computeTotals({
      order,
      items: [item({ unitPriceCents: 5000 })],
      paidCents: 2000,
      tipCents: 500,
    });

    expect(totals.totalCents).toBe(5500);
    expect(totals.paidCents).toBe(2000);
    expect(totals.remainingCents).toBe(3500);
  });

  it('da el mismo numero que `orderTotals` del dominio', () => {
    // Es la garantia que hace que el total que ve el mozo sea el que cobra el
    // servidor: no hay una segunda implementacion de la suma que pueda divergir.
    const items = [
      item({ modifiers: [{ name: 'Almendra', modifierId: null, priceDeltaCents: 200 }] }),
    ];

    const local = computeTotals({ order, items, paidCents: 0, tipCents: 0 });
    const dominio = orderTotals({
      items: [
        {
          unitPriceCents: 3400,
          quantity: 1,
          status: 'ACTIVE',
          modifiers: [{ priceDeltaCents: 200 }],
        },
      ],
      currency: 'XXX',
    });

    expect(local.totalCents).toBe(dominio.totalCents);
  });
});

describe('itemTotalCents', () => {
  it('multiplica cantidad por precio mas el delta de los modificadores', () => {
    expect(
      itemTotalCents({
        unitPriceCents: 3400,
        quantity: 3,
        modifiers: [{ name: 'Doble', modifierId: null, priceDeltaCents: 250 }],
      }),
    ).toBe(10_950);
  });

  it('un delta negativo descuenta del mismo modo que uno positivo suma', () => {
    expect(
      itemTotalCents({
        unitPriceCents: 3400,
        quantity: 1,
        modifiers: [{ name: 'Sin queso', modifierId: null, priceDeltaCents: -800 }],
      }),
    ).toBe(2600);
  });
});

describe('acciones de la comanda', () => {
  it('abrir una mesa escribe la replica y encola ORDER_OPENED', () => {
    useOrder.getState().openTable('table-3', '3', 4);

    const state = useOrder.getState();
    expect(state.order?.tableLabel).toBe('3');
    expect(state.order?.status).toBe('OPEN');
    expect(written.orders).toHaveLength(1);
    expect(enqueued.at(-1)?.type).toBe('ORDER_OPENED');
  });

  it('volver a tocar la mesa abierta no abre una segunda comanda', () => {
    useOrder.getState().openTable('table-3', '3', 4);
    const first = useOrder.getState().order?.id;

    useOrder.getState().openTable('table-3', '3', 4);

    expect(useOrder.getState().order?.id).toBe(first);
    expect(enqueued.filter((evento) => evento.type === 'ORDER_OPENED')).toHaveLength(1);
  });

  it('agregar un item sin mesa abierta no hace nada', () => {
    // El boton esta deshabilitado en la pantalla, pero el store es la ultima linea
    // de defensa: un item sin comanda es un item que nadie puede cobrar.
    useOrder
      .getState()
      .addItem({ id: 'p1', name: 'Cafe', priceCents: 2500, categoryId: 'cat-1', stationId: null }, [], null, 1);

    expect(useOrder.getState().items).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('anular exige motivo y lo manda en el evento', () => {
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder
      .getState()
      .addItem({ id: 'p1', name: 'Cafe', priceCents: 2500, categoryId: 'cat-1', stationId: null }, [], null, 1);

    const itemId = useOrder.getState().items[0]!.id;
    useOrder.getState().voidItem(itemId, 'Se cayo la taza');

    expect(useOrder.getState().items[0]?.status).toBe('VOIDED');
    expect(enqueued.at(-1)?.type).toBe('ORDER_ITEM_VOIDED');
    expect(enqueued.at(-1)?.payload.reason).toBe('Se cayo la taza');
  });

  it('anular dos veces el mismo item no genera dos eventos', () => {
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder
      .getState()
      .addItem({ id: 'p1', name: 'Cafe', priceCents: 2500, categoryId: 'cat-1', stationId: null }, [], null, 1);

    const itemId = useOrder.getState().items[0]!.id;
    useOrder.getState().voidItem(itemId, 'Error');
    useOrder.getState().voidItem(itemId, 'Error otra vez');

    expect(enqueued.filter((evento) => evento.type === 'ORDER_ITEM_VOIDED')).toHaveLength(1);
  });

  it('el pago mixto encola una linea por metodo', () => {
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder.getState().pay(
      [
        { method: 'CASH', amountCents: 3000, providerRef: null },
        { method: 'CARD', amountCents: 2000, providerRef: 'term-77' },
      ],
      0,
    );

    const pagos = enqueued.filter((evento) => evento.type === 'PAYMENT_RECORDED');
    expect(pagos).toHaveLength(2);
    expect(pagos.map((evento) => evento.payload.method).sort()).toEqual(['CARD', 'CASH']);
  });

  it('el vuelto no es negativo cuando el mozo paga de mas con tarjeta', () => {
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder
      .getState()
      .addItem({ id: 'p1', name: 'Cafe', priceCents: 2500, categoryId: 'cat-1', stationId: null }, [], null, 1);

    useOrder.getState().pay([{ method: 'CARD', amountCents: 2500, providerRef: null }], 0);

    expect(useOrder.getState().receipt).toEqual({ changeCents: 0, paidCents: 2500 });
  });

  it('cerrar libera la comanda en memoria y encola ORDER_CLOSED', () => {
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder.getState().closeOrder();

    expect(useOrder.getState().order).toBeNull();
    expect(useOrder.getState().items).toHaveLength(0);
    expect(enqueued.at(-1)?.type).toBe('ORDER_CLOSED');
  });

  it('cerrar dos veces no encola dos cierres', () => {
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder.getState().closeOrder();
    useOrder.getState().closeOrder();

    expect(enqueued.filter((evento) => evento.type === 'ORDER_CLOSED')).toHaveLength(1);
  });

  it('el descuento y el servicio se guardan como parametros, no como total', () => {
    // Es lo que hace que dos recalculos seguidos den el mismo numero: el total se
    // vuelve a derivar de items mas estos dos valores, y no de un importe ya
    // restado.
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder.getState().setCharges(1000, 1000, 'Cortesia del local');

    const state = useOrder.getState();
    expect(state.order?.discountCents).toBe(1000);
    expect(state.order?.serviceBps).toBe(1000);
    expect(enqueued.at(-1)?.type).toBe('ORDER_CHARGES_SET');
    expect(enqueued.at(-1)?.payload.reason).toBe('Cortesia del local');
  });
});

describe('precio con promociones', () => {
  /** Promo de 10% sobre un producto puntual, sin horario: vigente siempre. */
  const promoDeCafe: PromotionRule = {
    id: 'rule-cafe-10',
    type: 'PERCENT',
    scope: 'PRODUCT',
    scopeId: 'p1',
    schedule: null,
    params: { bps: 1000 },
    priority: 0,
    stackable: false,
    active: true,
  };

  it('agregar un item aplica la promo vigente y congela el snapshot', () => {
    // El POS evalua las promos con el mismo motor que el servidor:
    // sin esto, una venta de mostrador en happy hour cobraria de
    // mas y nadie se enteraria hasta reconciliar.
    setActiveRules([promoDeCafe]);
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder.getState().addItem(
      { id: 'p1', name: 'Cafe', priceCents: 2500, categoryId: 'cat-1', stationId: null },
      [],
      null,
      1,
    );

    const item = useOrder.getState().items[0]!;
    // 10% sobre 2500 = 2250.
    expect(item.unitPriceCents).toBe(2250);
    // El snapshot explica el precio meses despues, aunque la promo
    // ya no exista.
    const applied = item.appliedRules as Array<{ ruleId: string }>;
    expect(applied[0]?.ruleId).toBe('rule-cafe-10');
    // El evento es lo que sube: si el precio no viajara con el,
    // el servidor reconstruiria el total con el precio de lista.
    expect(enqueued.at(-1)?.payload.unitPriceCents).toBe(2250);
  });

  it('una promo de otro producto no cambia el precio de la linea', () => {
    setActiveRules([
      { ...promoDeCafe, scopeId: 'otro-producto', params: { bps: 5000 } },
    ]);
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder.getState().addItem(
      { id: 'p1', name: 'Cafe', priceCents: 2500, categoryId: 'cat-1', stationId: null },
      [],
      null,
      1,
    );

    const item = useOrder.getState().items[0]!;
    expect(item.unitPriceCents).toBe(2500);
    expect(item.appliedRules).toEqual([]);
  });

  it('una promo fuera de vigencia no aplica', () => {
    // `endsOn` en el pasado es la unica forma de un "nunca vigente"
    // determinista: un horario que no coincide con "ahora" depende
    // de la hora en que corre el test.
    setActiveRules([
      {
        ...promoDeCafe,
        id: 'rule-vieja',
        schedule: {
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          from: '00:00',
          to: '23:59',
          timezone: 'America/Argentina/Buenos_Aires',
          endsOn: '2000-01-01T00:00:00.000Z',
        },
      },
    ]);
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder.getState().addItem(
      { id: 'p1', name: 'Cafe', priceCents: 2500, categoryId: 'cat-1', stationId: null },
      [],
      null,
      1,
    );

    expect(useOrder.getState().items[0]?.unitPriceCents).toBe(2500);
  });

  it('una promo dada de baja no aplica', () => {
    // La baja logica es la forma en que el dueno retira una promo
    // sin romper las comandas que ya la explican.
    setActiveRules([{ ...promoDeCafe, active: false }]);
    useOrder.getState().openTable('table-3', '3', 2);
    useOrder.getState().addItem(
      { id: 'p1', name: 'Cafe', priceCents: 2500, categoryId: 'cat-1', stationId: null },
      [],
      null,
      1,
    );

    expect(useOrder.getState().items[0]?.unitPriceCents).toBe(2500);
  });
});
