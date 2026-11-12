import type { OutboxEvent } from './protocol';
import type {
  RemoteEvent,
  ReplicaItem,
  ReplicaOrder,
  ReplicaSnapshot,
  ReplicaTable,
  SyncStorage,
} from './storage';

/**
 * Storage en memoria.
 *
 * Sirve para dos cosas, y las dos importan:
 *
 *  1. **Tests de la reconciliacion en Node.** Correr la logica de sincronizacion
 *     contra un IndexedDB real obliga a levantar un navegador por caso; con esto
 *     los tests corren en milisegundos y sin navegador.
 *
 *  2. **Especificacion ejecutable del adaptador de Dexie.** Si esta clase y
 *     `DexieSyncStorage` se portan distinto, uno de los dos esta mal. Los tests
 *     de este archivo son la especificacion que el de Dexie tiene que cumplir.
 *
 * `applyRemote` se implementa con la misma semantica que el KDS y la comanda:
 * los eventos del servidor authoritative sobre la replica.
 */

/** Los eventos que el servidor authoritative sobre la replica. */
export class MemorySyncStorage implements SyncStorage {
  private readonly events = new Map<string, OutboxEvent>();
  private cursor = '0';

  /** Tablas y ordenes, para que `applyRemote` tenga sobre que operar. */
  readonly tables = new Map<string, ReplicaTable>();
  readonly orders = new Map<string, ReplicaOrder>();

  constructor(seed?: { cursor?: string }) {
    if (seed?.cursor) this.cursor = seed.cursor;
  }

  // --- Outbox ---

  async putEvent(event: OutboxEvent): Promise<void> {
    this.events.set(event.eventId, event);
  }

  async nextBatch(limit: number): Promise<OutboxEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.status === 'pending' || event.status === 'failed')
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async removeEvents(eventIds: string[]): Promise<void> {
    for (const id of eventIds) this.events.delete(id);
  }

  async requeueStuck(): Promise<number> {
    let count = 0;
    for (const [id, event] of this.events) {
      if (event.status === 'syncing') {
        this.events.set(id, { ...event, status: 'pending' });
        count += 1;
      }
    }
    return count;
  }

  async pendingCount(): Promise<number> {
    return [...this.events.values()].filter(
      (event) =>
        event.status === 'pending' || event.status === 'failed' || event.status === 'syncing',
    ).length;
  }

  /** Marca un lote como en curso. Lo usa el test de corte de red. */
  async markSyncing(events: OutboxEvent[]): Promise<void> {
    for (const event of events) {
      this.events.set(event.eventId, { ...event, status: 'syncing' });
    }
  }

  /** Eventos crudos, para las aserciones de los tests. */
  rawEvents(): OutboxEvent[] {
    return [...this.events.values()];
  }

  // --- Cursor ---

  async getCursor(): Promise<string> {
    return this.cursor;
  }

  async setCursor(cursor: string): Promise<void> {
    this.cursor = cursor;
  }

  // --- Replica ---

  async applyRemote(events: readonly RemoteEvent[]): Promise<void> {
    for (const event of events) {
      this.applyOne(event);
    }
  }

  private applyOne(event: RemoteEvent): void {
    const p = event.payload;

    switch (event.type) {
      case 'ORDER_OPENED': {
        const id = asString(p.orderId);
        if (!id) return;
        const existing = this.orders.get(id);
        this.orders.set(id, {
          id,
          numberLabel: asString(p.numberLabel) ?? existing?.numberLabel ?? id,
          tableId: asString(p.tableId),
          tableLabel: asString(p.tableLabel),
          status: existing?.status ?? 'OPEN',
          openedAt: asString(p.openedAt) ?? event.receivedAt,
          guests: asNumber(p.guests) ?? 1,
          totalCents: existing?.totalCents ?? 0,
          tipCents: existing?.tipCents ?? 0,
          items: existing?.items ?? [],
        });
        return;
      }

      case 'ORDER_ITEM_ADDED': {
        const itemId = asString(p.itemId);
        const orderId = asString(p.orderId);
        if (!itemId || !orderId) return;

        const order = this.orders.get(orderId);
        if (!order) return;

        // Idempotente por `itemId`: si el mismo item vuelve a llegar, no se
        // duplica. Es el mismo criterio del servidor.
        if (order.items.some((item) => item.id === itemId)) return;

        const item: ReplicaItem = {
          id: itemId,
          orderId,
          name: asString(p.name) ?? '',
          quantity: asNumber(p.quantity) ?? 1,
          unitPriceCents: asNumber(p.unitPriceCents) ?? 0,
          modifiers: Array.isArray(p.modifiers)
            ? p.modifiers.map((m) => ({
                name: asString((m as Record<string, unknown>).name) ?? '',
                priceDeltaCents: asNumber((m as Record<string, unknown>).priceDeltaCents) ?? 0,
              }))
            : [],
          status: 'ACTIVE',
          note: asString(p.note),
          seat: asNumber(p.seat),
          course: asNumber(p.course) ?? 1,
        };

        // El total se mueve con el delta de los modificadores adentro, igual que
        // en `orderTotals` y en el adaptador de Dexie. Las tres implementations
        // tienen que hacer lo mismo o el POS anuncia un numero y cobra otro.
        const modifierDelta = item.modifiers.reduce(
          (acc, modifier) => acc + modifier.priceDeltaCents,
          0,
        );

        this.orders.set(orderId, {
          ...order,
          items: [...order.items, item],
          totalCents: order.totalCents + (item.unitPriceCents + modifierDelta) * item.quantity,
        });
        return;
      }

      case 'ORDER_ITEM_VOIDED': {
        const orderId = asString(p.orderId);
        const itemId = asString(p.itemId);
        if (!orderId || !itemId) return;
        const order = this.orders.get(orderId);
        if (!order) return;
        const item = order.items.find((candidate) => candidate.id === itemId);
        if (!item || item.status === 'VOIDED') return;

        const modifierDelta = item.modifiers.reduce(
          (acc, modifier) => acc + modifier.priceDeltaCents,
          0,
        );

        this.orders.set(orderId, {
          ...order,
          items: order.items.map((candidate) =>
            candidate.id === itemId ? { ...candidate, status: 'VOIDED' } : candidate,
          ),
          // Bajar el total con el item, y solo una vez: si se descontara dos veces,
          // la cuenta daria negativa y el POS anunciaria un numero imposible.
          totalCents: order.totalCents - (item.unitPriceCents + modifierDelta) * item.quantity,
        });
        return;
      }

      case 'ORDER_CLOSED': {
        const orderId = asString(p.orderId);
        if (!orderId) return;
        const order = this.orders.get(orderId);
        if (!order) return;
        this.orders.set(orderId, { ...order, status: 'CLOSED' });
        return;
      }

      case 'PAYMENT_RECORDED': {
        const orderId = asString(p.orderId);
        if (!orderId) return;
        const order = this.orders.get(orderId);
        if (!order) return;
        // El pago NO mueve el total: el total es lo que se debe y ya esta calculado
        // desde los items. Lo que se acumula es lo pagado. Sumar el pago al total
        // mezclaria "lo que se debe" con "lo que se pagó".
        this.orders.set(orderId, {
          ...order,
          tipCents: order.tipCents + (asNumber(p.tipCents) ?? 0),
        });
        return;
      }

      case 'TABLE_STATUS_CHANGED': {
        const tableId = asString(p.tableId);
        if (!tableId) return;
        const existing = this.tables.get(tableId);
        this.tables.set(tableId, {
          id: tableId,
          floorId: existing?.floorId ?? 'unknown',
          label: asString(p.label) ?? existing?.label ?? tableId,
          seats: existing?.seats ?? 2,
          status: (asString(p.status) as ReplicaTable['status']) ?? existing?.status ?? 'LIBRE',
          orderId: asString(p.orderId),
          occupiedSince: asString(p.occupiedSince),
        });

        // Si el servidor le quito la mesa a una comanda, esa comanda queda sin
        // mesa: hay que soltarla en la replica, no dejarla apuntando a una mesa
        // que ya no es suya.
        const displacedId = asString(p.displacedOrderId);
        if (displacedId) {
          const displaced = this.orders.get(displacedId);
          if (displaced) this.orders.set(displacedId, { ...displaced, tableId: null });
        }
        return;
      }

      default:
        // Un evento que este cliente no sabe aplicar no es un error: puede ser de
        // otra version del POS. Lo que no puede ser es romper el ciclo.
        return;
    }
  }

  async snapshot(): Promise<ReplicaSnapshot> {
    return {
      tables: [...this.tables.values()],
      orders: [...this.orders.values()],
      activeOrderId: null,
    };
  }

  // --- Utilidades de test ---

  seedTable(table: ReplicaTable): void {
    this.tables.set(table.id, table);
  }

  seedOrder(order: ReplicaOrder): void {
    this.orders.set(order.id, order);
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
