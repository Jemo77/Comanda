import { create } from 'zustand';
import {
  orderTotals,
  uuidv7,
  type OrderItem,
  type OrderTotals,
  type PaymentMethod,
} from '@comanda/domain';
import {
  db,
  type LocalKitchenLine,
  type LocalKitchenTicket,
  type LocalOrder,
  type LocalOrderItem,
} from '../data/db';
import { enqueueEvent } from '../data/sync';
import { getVenueCurrency, priceForProduct } from './pricing';

/**
 * Comanda activa del POS.
 *
 * **La regla de oro de todo este archivo: UI optimista.** Cada accion escribe
 * primero en la replica local y despues encola el evento. El mozo vuelve a tener
 * el control en menos de 100 ms y el motor sube despues, con o sin cable. Un POS
 * que muestra un spinner mientras "sube" el item deja de vender en el momento
 * exacto en que el local se queda sin señal, que es justo cuando mas se vende.
 *
 * El orden de las dos escrituras no es negociable: primero la replica, despues la
 * cola. Si la tablet se apaga justo despues de que el mozo toco "cobrar", el
 * evento ya quedo en IndexedDB y el cobro no se pierde.
 *
 * Los totales **no se recalculan aca**: salen de `orderTotals()` del dominio, la
 * misma funcion pura que corre el servidor. Dos implementaciones de la misma suma
 * divergen, y cuando divergen el mozo ve un total y el sistema cobra otro.
 */

/** Producto de la carta, tal como lo pinta la pantalla. */
export interface OrderProduct {
  id: string;
  /** Categoria: la necesita el motor para las promos por categoria. */
  categoryId: string | null;
  name: string;
  priceCents: number;
  stationId: string | null;
}

/** Modificador elegido, con su nombre y su delta ya resueltos. */
export interface SelectedModifier {
  modifierId: string | null;
  name: string;
  priceDeltaCents: number;
}

/** Una linea de pago del cobro. El pago mixto es varias de estas. */
export interface PaymentLine {
  method: PaymentMethod;
  amountCents: number;
  /** Comprobante del terminal. Nunca el PAN: la API no ve el numero de tarjeta. */
  providerRef: string | null;
}

/** Que se ve en el bloque de cuenta despues de cobrar. */
export interface PaymentReceipt {
  /** Vuelto en efectivo. Negativo no: si no hay vuelto, es cero. */
  changeCents: number;
  /** Importe cobrado en total, con propina. */
  paidCents: number;
}

interface OrderState {
  order: LocalOrder | null;
  items: LocalOrderItem[];
  /** Importe ya cobrado en esta comanda, en centavos. */
  paidCents: number;
  /** Comprobante del cobro recien registrado, para que la pantalla muestre el vuelto. */
  receipt: PaymentReceipt | null;

  /** Carga una comanda abierta desde la replica. Idempotente. */
  load: (orderId: string) => Promise<void>;
  /** Cierra la comanda en memoria. El registro historico queda en la replica. */
  reset: () => void;

  openTable: (tableId: string, tableLabel: string, guests: number) => void;
  addItem: (
    product: OrderProduct,
    modifiers: readonly SelectedModifier[],
    note: string | null,
    quantity: number,
  ) => void;
  voidItem: (itemId: string, reason: string) => void;
  setCourse: (course: number) => void;
  setSeat: (seat: number | null) => void;
  requestBill: () => void;
  setCharges: (discountCents: number, serviceBps: number, reason: string) => void;
  pay: (payments: readonly PaymentLine[], tipCents: number) => void;
  closeOrder: () => void;
}

export const useOrder = create<OrderState>((set, get) => ({
  order: null,
  items: [],
  paidCents: 0,
  receipt: null,

  load: async (orderId) => {
    const order = await db.orders.get(orderId);
    if (!order) return;
    const items = await db.orderItems.where('orderId').equals(orderId).toArray();
    set({ order, items, paidCents: 0, receipt: null });
  },

  reset: () => set({ order: null, items: [], paidCents: 0, receipt: null }),

  openTable: (tableId, tableLabel, guests) => {
    const { order } = get();
    // Volver a tocar la mesa que ya esta abierta no abre una segunda comanda: lo
    // que el mozo quiere en ese gesto es volver a mirarla.
    if (order && order.tableId === tableId) return;

    const next: LocalOrder = {
      id: uuidv7(),
      venueId: '',
      tableId,
      tableLabel,
      // Numero visible, derivado de la mesa. Offline no hay correlativo global, asi
      // que dos tablets pueden mostrar el mismo numero y es intencional: el
      // identificador real es el UUID.
      numberLabel: (tableLabel ?? 'Mostrador').slice(0, 20),
      channel: 'POS',
      status: 'OPEN',
      openedAt: new Date().toISOString(),
      openedBy: '',
      guests,
      discountCents: 0,
      serviceBps: 0,
    };

    set({ order: next, items: [], paidCents: 0, receipt: null });
    void db.orders.put(next);
    void enqueueEvent('ORDER_OPENED', {
      orderId: next.id,
      tableId,
      tableLabel,
      numberLabel: next.numberLabel,
      channel: next.channel,
      guests,
      openedAt: next.openedAt,
    });
  },

  addItem: (product, modifiers, note, quantity) => {
    const { order } = get();
    if (!order) return;

    const priced = priceForProduct(product, quantity, getVenueCurrency());

    const item: LocalOrderItem = {
      id: uuidv7(),
      orderId: order.id,
      productId: product.id,
      // Snapshot, no referencia: dentro de seis meses el producto puede haberse
      // renombrado o haber cambiado de precio, y el ticket tiene que seguir diciendo
      // lo que se pidio.
      name: product.name,
      quantity,
      unitPriceCents: priced.unitPriceCents,
      appliedRules: priced.appliedRules,
      status: 'ACTIVE',
      course: 1,
      seat: null,
      note: note !== null && note.length > 0 ? note : null,
      modifiers: modifiers.map((modifier) => ({ ...modifier })),
      voidReason: null,
      voidedAt: null,
      addedAt: new Date().toISOString(),
    };

    set((state) => ({ items: [...state.items, item] }));
    void db.orderItems.put(item);
    void enqueueEvent('ORDER_ITEM_ADDED', {
      orderId: order.id,
      itemId: item.id,
      productId: product.id,
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      appliedRules: item.appliedRules,
      course: item.course,
      seat: item.seat,
      note: item.note,
      modifiers: item.modifiers,
    });

    // La cocina ve el ticket en el mismo instante que el mozo ve la linea. Un
    // segundo de diferencia en un ticket de entrada es un plato que sale tarde.
    if (product.stationId) {
      void addKitchenLine(order, item, product.stationId);
    }
  },

  voidItem: (itemId, reason) => {
    const { order, items } = get();
    if (!order) return;

    const item = items.find((candidate) => candidate.id === itemId);
    if (!item || item.status === 'VOIDED') return;

    const voidedAt = new Date().toISOString();
    set({
      items: items.map((candidate) =>
        candidate.id === itemId
          ? { ...candidate, status: 'VOIDED' as const, voidReason: reason, voidedAt }
          : candidate,
      ),
    });
    void db.orderItems.update(itemId, { status: 'VOIDED', voidReason: reason, voidedAt });

    // El motivo es obligatorio y viaja en el evento: sin el, "cuanto se descuento
    // por anulaciones" es una pregunta sin respuesta posible.
    void enqueueEvent('ORDER_ITEM_VOIDED', { orderId: order.id, itemId, reason });
    void dropKitchenLine(order.id, itemId);
  },

  setCourse: (course) => {
    const { order, items } = get();
    if (!order) return;

    // Cambia el curso de **todos** los items activos. Es lo que "mantener y disparar"
    // necesita: el mozo marca la entrada como curso 1 y dispara, no item por item.
    // El evento del servidor tambien es por lote, asi que decidirlo aca evita mandar
    // nueve eventos por lo que el mozo hizo con un gesto.
    const active = items.filter((item) => item.status === 'ACTIVE');
    if (active.length === 0) return;

    set({
      items: items.map((item) => (item.status === 'ACTIVE' ? { ...item, course } : item)),
    });
    void db.orderItems.bulkPut(active.map((item) => ({ ...item, course })));
    void enqueueEvent('ORDER_ITEM_COURSE_SET', {
      orderId: order.id,
      itemIds: active.map((item) => item.id),
      course,
    });
  },

  setSeat: (seat) => {
    const { order, items } = get();
    if (!order) return;

    const active = items.filter((item) => item.status === 'ACTIVE');
    if (active.length === 0) return;

    set({
      items: items.map((item) => (item.status === 'ACTIVE' ? { ...item, seat } : item)),
    });
    void db.orderItems.bulkPut(active.map((item) => ({ ...item, seat })));
    void enqueueEvent('ORDER_SEAT_SET', {
      orderId: order.id,
      itemIds: active.map((item) => item.id),
      seat,
    });
  },

  requestBill: () => {
    const { order } = get();
    if (!order || order.status === 'PEDIDO_CUENTA') return;

    // No va un evento propio: `PEDIDO_CUENTA` es un estado que el servidor deriva
    // del `ORDER_OPENED` y del `ORDER_CLOSED`. Mandar uno que el servidor no
    // tiene es un `REJECTED` en un local a las dos de la manana.
    set({ order: { ...order, status: 'PEDIDO_CUENTA' } });
    void db.orders.update(order.id, { status: 'PEDIDO_CUENTA' });
  },

  setCharges: (discountCents, serviceBps, reason) => {
    const { order } = get();
    if (!order) return;

    // El descuento y el servicio son **parametros** del total, no un importe restado
    // arriba. Guardarlos como estado es lo que hace que dos recalculos seguidos den
    // el mismo numero, sin importar quantas veces llegue el evento desde otro
    // dispositivo.
    set({ order: { ...order, discountCents, serviceBps } });
    void db.orders.update(order.id, { discountCents, serviceBps });
    void enqueueEvent('ORDER_CHARGES_SET', {
      orderId: order.id,
      discountCents,
      serviceBps,
      reason,
    });
  },

  pay: (payments, tipCents) => {
    const { order, items, paidCents } = get();
    if (!order) return;

    // Una linea de pago por metodo: es lo que permite el pago mixto sin que el
    // servidor tenga que adivinar como lo pago el mozo. El efectivo con vuelto son
    // dos lineas, no una con signo.
    for (const payment of payments) {
      void enqueueEvent('PAYMENT_RECORDED', {
        paymentId: uuidv7(),
        orderId: order.id,
        method: payment.method,
        amountCents: payment.amountCents,
        tipCents,
        provider: payment.method === 'CARD' ? 'terminal' : null,
        providerRef: payment.providerRef,
      });
    }

    if (tipCents > 0) {
      void enqueueEvent('TIP_ADDED', { orderId: order.id, tipCents });
    }

    // El vuelto se calcula contra el total **con** propina: el total del bloque de
    // cuenta ya incluia la propina que se eligio recien, y un vuelto corto por tres
    // centavos es un reclamo en la mesa.
    const charged = payments.reduce((acc, payment) => acc + payment.amountCents, 0);
    const totalCents = computeTotals({ order, items, paidCents: 0, tipCents }).totalCents;

    set({
      paidCents: paidCents + charged,
      receipt: { changeCents: Math.max(0, charged - totalCents), paidCents: charged },
    });
  },

  closeOrder: () => {
    const { order } = get();
    if (!order || order.status === 'CLOSED') return;

    set({ order: { ...order, status: 'CLOSED' } });
    void db.orders.update(order.id, { status: 'CLOSED' });
    void enqueueEvent('ORDER_CLOSED', { orderId: order.id });

    // La cocina deja de mostrar la comanda. Si queda abierta, el que esta lavando
    // los platos ve un ticket viejo que hay que ignorar, y con ruido de fondo lo
    // ignora tarde.
    void db.kitchenTickets.where('orderId').equals(order.id).delete();
    set({ order: null, items: [], paidCents: 0, receipt: null });
  },
}));

/**
 * Totales de la comanda activa.
 *
 * Es un hook y no un valor para que React solo repinte cuando cambian los items: si
 * el total se calculara en cada render, cualquier estado del shell (el indicador de
 * sync, el reloj del mapa) volveria a sumar la comanda entera.
 */
export function useTotals(tipCents = 0): OrderTotals {
  const order = useOrder((state) => state.order);
  const items = useOrder((state) => state.items);
  const paidCents = useOrder((state) => state.paidCents);
  return computeTotals({ order, items, paidCents, tipCents });
}

/**
 * Suma de la comanda.
 *
 * Delega en `orderTotals()` del dominio. Que el POS y el servidor corran la misma
 * funcion pura es lo que hace que el total que ve el mozo sea el total que se
 * cobra, incluso offline y aunque la carta cambie entremedio.
 */
export function computeTotals(params: {
  order: LocalOrder | null;
  items: readonly LocalOrderItem[];
  paidCents: number;
  tipCents: number;
}): OrderTotals {
  const { order, items, paidCents, tipCents } = params;
  return orderTotals({
    // `orderTotals` solo necesita precio, cantidad y estado. Se le pasa lo minimo y
    // no el item entero para que agregar un campo al dominio no rompa el POS.
    items: items.map((item) => ({
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      status: item.status,
      modifiers: item.modifiers,
    })),
    // La moneda no entra en el calculo: los totales son enteros y la moneda solo
    // hace falta para formatear.
    currency: 'XXX',
    discountCents: order?.discountCents ?? 0,
    serviceBps: order?.serviceBps ?? 0,
    tipCents,
    paidCents,
  });
}

/** Importe de una linea de ticket, con los modificadores adentro del precio. */
export function itemTotalCents(
  item: Pick<OrderItem, 'unitPriceCents' | 'quantity' | 'modifiers'>,
): number {
  const delta = item.modifiers.reduce((acc, modifier) => acc + modifier.priceDeltaCents, 0);
  return (item.unitPriceCents + delta) * item.quantity;
}

/**
 * Agrega el item al ticket de cocina de su estacion.
 *
 * El ticket se arma **desde la comanda local** y no desde una consulta al servidor:
 * la cocina tiene que ver el ticket en el mismo instante que el mozo ve la linea.
 */
async function addKitchenLine(
  order: LocalOrder,
  item: LocalOrderItem,
  stationId: string,
): Promise<void> {
  const [station, existing] = await Promise.all([
    db.stations.get(stationId),
    db.kitchenTickets.get(`${order.id}:${stationId}`),
  ]);

  const line = {
    itemId: item.id,
    name: item.name,
    quantity: item.quantity,
    note: item.note,
    modifiers: item.modifiers.map((modifier) => modifier.name),
    course: item.course,
  };

  // Un item repetido suma cantidad en vez de duplicar la linea: dos capuchinos para
  // la mesa 3 son "2x CAPUCHINO" en cocina, no dos renglones que el cocinero tiene que
  // sumar de memoria con ruido de fondo.
  const previous: LocalKitchenLine[] = existing?.lines ?? [];
  const lines = previous.map((candidate) =>
    candidate.itemId === item.id
      ? { ...candidate, quantity: candidate.quantity + item.quantity }
      : candidate,
  );
  if (!previous.some((candidate) => candidate.itemId === item.id)) lines.push(line);

  const ticket: LocalKitchenTicket = {
    id: `${order.id}:${stationId}`,
    stationId,
    stationName: station?.name ?? 'Estacion',
    orderId: order.id,
    orderNumberLabel: order.numberLabel,
    tableLabel: order.tableLabel,
    status: existing?.status ?? 'NEW',
    priority: 0,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lines,
  };

  await db.kitchenTickets.put(ticket);
}

/** Saca la linea de un item anulado del ticket de cocina. */
async function dropKitchenLine(orderId: string, itemId: string): Promise<void> {
  const tickets = await db.kitchenTickets.where('orderId').equals(orderId).toArray();
  await Promise.all(
    tickets.map(async (ticket) => {
      const lines = ticket.lines.filter((line) => line.itemId !== itemId);
      // Un ticket sin lineas no es un ticket: se borra. Dejarlo seria un papel vacio
      // en la pantalla de cocina que alguien tiene que sacar a mano.
      if (lines.length === 0) await db.kitchenTickets.delete(ticket.id);
      else await db.kitchenTickets.put({ ...ticket, lines });
    }),
  );
}
