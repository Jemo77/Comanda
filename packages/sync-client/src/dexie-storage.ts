import Dexie, { type EntityTable, type Transaction } from 'dexie';
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
 * `SyncStorage` sobre IndexedDB, con Dexie.
 *
 * Es la implementacion que corre en el POS. La counterpart de pruebas es
 * `MemorySyncStorage`, y las dos tienen que cumplir el mismo contrato: donde se
 * porten distinto, uno de los dos esta mal. Los tests de migracion y los de
 * reconciliacion fijan ese contrato del lado de la memoria.
 *
 * Dos cosas que no son negociables:
 *
 *  1. **`applyRemote` es atomico.** Si el POS se cierra entre dos escrituras de un
 *     mismo evento, al reabrir la replica queda con medio estado y el mozo cobra de
 *     mas. Por eso el lote entero va en una transaccion de Dexie.
 *
 *  2. **La outbox nunca se sobreescribe con nada del servidor.** Lo que sale del
 *     dispositivo y lo que baja son dos cosas separadas. Confundirlas es como se
 *     pierde una comanda.
 */

/** Estado por dispositivo: cursor del pull y comanda activa. */
export interface DeviceStateRow {
  deviceId: string;
  cursor: string;
  activeOrderId: string | null;
  /** Secuencia del dispositivo, para retomar la outbox sin repetir `seq`. */
  localSeq: number;
  lastSyncedAt: string | null;
}

export class ComandaDexie extends Dexie {
  outbox!: EntityTable<OutboxEvent, 'eventId'>;
  deviceState!: EntityTable<DeviceStateRow, 'deviceId'>;
  /**
   * `replicaTables` y no `tables`: `tables` es un getter interno de Dexie que
   * devuelve los esquemas de la base. Declarar una tabla con ese nombre pisa el
   * getter y Dexie revienta con `db.tables.forEach is not a function` al abrir, que
   * es un error de lo mas confuso que se pueden ver en un POS.
   */
  replicaTables!: EntityTable<ReplicaTable, 'id'>;
  orders!: EntityTable<ReplicaOrder, 'id'>;

  constructor(name = 'comanda') {
    super(name);

    // Indices explicitos, y solo los que se usan:
    //  - `status` es para "que eventos tengo que subir".
    //  - `seq` es para el lote ordenado, que es el orden en que ocurrio.
    //  - `status` en orders y tables es para pintar el mapa sin traer todo.
    this.version(1).stores({
      outbox: 'eventId, status, seq, [deviceId+status], occurredAt',
      deviceState: 'deviceId',
      replicaTables: 'id, status, floorId',
      orders: 'id, status, tableId, openedAt',
    });
  }
}

export class DexieSyncStorage implements SyncStorage {
  constructor(
    private readonly db: ComandaDexie,
    private readonly deviceId: string,
  ) {}

  // --- Outbox ---

  async putEvent(event: OutboxEvent): Promise<void> {
    await this.db.outbox.put(event);
  }

  async nextBatch(limit: number): Promise<OutboxEvent[]> {
    // Dexie no ordena por un `anyOf` sin TraverseableIndex; el filtro se hace en
    // memoria sobre un rango acotado por `seq`, que es el orden que importa.
    const candidates = await this.db.outbox.orderBy('seq').toArray();
    return candidates
      .filter((event) => event.status === 'pending' || event.status === 'failed')
      .slice(0, limit);
  }

  async removeEvents(eventIds: string[]): Promise<void> {
    // `bulkDelete` no falla si un id no esta, que es justo lo que se necesita: el
    // push pudo haber confirmado y el evento haberse limpiado por otra via.
    await this.db.outbox.bulkDelete(eventIds);
  }

  async requeueStuck(): Promise<number> {
    return this.db.transaction('rw', this.db.outbox, async () => {
      const stuck = await this.db.outbox.where('status').equals('syncing').toArray();
      if (stuck.length === 0) return 0;
      await this.db.outbox.bulkPut(
        stuck.map((event) => ({ ...event, status: 'pending' as const })),
      );
      return stuck.length;
    });
  }

  async pendingCount(): Promise<number> {
    return this.db.outbox.where('status').anyOf('pending', 'failed', 'syncing').count();
  }

  /**
   * Marca un lote como en curso.
   *
   * Vive en el storage y no en el motor porque es una operacion sobre la base
   * local: si el POS se cierra ahora, esos eventos quedan en `syncing` y
   * `requeueStuck` los devuelve a la cola en el proximo arranque.
   */
  async markSyncing(events: OutboxEvent[]): Promise<void> {
    await this.db.outbox.bulkPut(events.map((event) => ({ ...event, status: 'syncing' as const })));
  }

  // --- Cursor y estado del dispositivo ---

  private async readState(): Promise<DeviceStateRow> {
    const row = await this.db.deviceState.get(this.deviceId);
    return (
      row ?? {
        deviceId: this.deviceId,
        cursor: '0',
        activeOrderId: null,
        localSeq: 0,
        lastSyncedAt: null,
      }
    );
  }

  async getCursor(): Promise<string> {
    return (await this.readState()).cursor;
  }

  async setCursor(cursor: string): Promise<void> {
    await this.db.deviceState.put({
      ...(await this.readState()),
      cursor,
      lastSyncedAt: new Date().toISOString(),
    });
  }

  async getActiveOrderId(): Promise<string | null> {
    return (await this.readState()).activeOrderId;
  }

  async setActiveOrderId(orderId: string | null): Promise<void> {
    await this.db.deviceState.put({ ...(await this.readState()), activeOrderId: orderId });
  }

  // --- Replica ---

  /**
   * Aplica un lote de eventos del servidor, atomico.
   *
   * Toda la replica se escribe en una transaccion: si el POS se apaga a mitad, no
   * queda con la mitad de los eventos aplicados. Sin esto, el mapa puede mostrar una
   * mesa liberada con la comanda todavia abierta, que es un cobro con dos numeros
   * distintos.
   */
  async applyRemote(events: readonly RemoteEvent[]): Promise<void> {
    if (events.length === 0) return;

    await this.db.transaction(
      'rw',
      [this.db.replicaTables, this.db.orders, this.db.deviceState],
      async (tx: Transaction) => {
        for (const event of events) {
          await this.applyOne(event, tx);
        }
      },
    );
  }

  private async applyOne(event: RemoteEvent, tx: Transaction): Promise<void> {
    const p = event.payload;

    switch (event.type) {
      case 'ORDER_OPENED': {
        const id = asString(p.orderId);
        if (!id) return;
        const existing = await this.db.orders.get(id);
        await this.db.orders.put({
          id,
          numberLabel: asString(p.numberLabel) ?? existing?.numberLabel ?? id,
          tableId: asString(p.tableId) ?? existing?.tableId ?? null,
          tableLabel: asString(p.tableLabel) ?? existing?.tableLabel ?? null,
          status: existing?.status ?? 'OPEN',
          openedAt: asString(p.openedAt) ?? event.receivedAt,
          guests: asNumber(p.guests) ?? existing?.guests ?? 1,
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

        const order = await this.db.orders.get(orderId);
        if (!order) return;

        // Idempotente por `itemId`: el mismo item puede llegar dos veces si el
        // servidor reemitio un evento. Sin esto, el ticket mostraria el doble.
        if (order.items.some((item) => item.id === itemId)) return;

        const item: ReplicaItem = {
          id: itemId,
          orderId,
          name: asString(p.name) ?? '',
          quantity: asNumber(p.quantity) ?? 1,
          unitPriceCents: asNumber(p.unitPriceCents) ?? 0,
          modifiers: Array.isArray(p.modifiers)
            ? p.modifiers.map((raw) => {
                const modifier = raw as Record<string, unknown>;
                return {
                  name: asString(modifier.name) ?? '',
                  priceDeltaCents: asNumber(modifier.priceDeltaCents) ?? 0,
                };
              })
            : [],
          status: 'ACTIVE',
          note: asString(p.note),
          seat: asNumber(p.seat),
          course: asNumber(p.course) ?? 1,
        };

        // El delta de los modificadores entra en el precio unitario efectivo, igual
        // que en `orderTotals`: en un ticket real "capuchino con shot" es un
        // producto, no dos.
        const modifierDelta = item.modifiers.reduce(
          (acc, modifier) => acc + modifier.priceDeltaCents,
          0,
        );

        await this.db.orders.put({
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
        const order = await this.db.orders.get(orderId);
        if (!order) return;

        const item = order.items.find((candidate) => candidate.id === itemId);
        if (!item || item.status === 'VOIDED') return;

        const modifierDelta = item.modifiers.reduce(
          (acc, modifier) => acc + modifier.priceDeltaCents,
          0,
        );

        await this.db.orders.put({
          ...order,
          items: order.items.map((candidate) =>
            candidate.id === itemId ? { ...candidate, status: 'VOIDED' } : candidate,
          ),
          // El total baja por el importe del item: el POS tiene que mostrar lo mismo
          // que el servidor va a cobrar.
          totalCents: order.totalCents - (item.unitPriceCents + modifierDelta) * item.quantity,
        });
        return;
      }

      case 'ORDER_CLOSED': {
        const orderId = asString(p.orderId);
        if (!orderId) return;
        const order = await this.db.orders.get(orderId);
        if (!order) return;
        await this.db.orders.put({ ...order, status: 'CLOSED' });
        return;
      }

      case 'PAYMENT_RECORDED': {
        const orderId = asString(p.orderId);
        if (!orderId) return;
        const order = await this.db.orders.get(orderId);
        if (!order) return;
        await this.db.orders.put({
          ...order,
          tipCents: order.tipCents + (asNumber(p.tipCents) ?? 0),
        });
        return;
      }

      case 'TABLE_STATUS_CHANGED': {
        const tableId = asString(p.tableId);
        if (!tableId) return;
        const existing = await this.db.replicaTables.get(tableId);

        await this.db.replicaTables.put({
          id: tableId,
          floorId: existing?.floorId ?? 'unknown',
          label: asString(p.label) ?? existing?.label ?? tableId,
          seats: existing?.seats ?? 2,
          status: (asString(p.status) as ReplicaTable['status']) ?? existing?.status ?? 'LIBRE',
          orderId: asString(p.orderId),
          occupiedSince: asString(p.occupiedSince),
        });

        // Si el servidor le quito la mesa a una comanda, esa comanda queda sin mesa.
        // Sin esto, el POS sigue mostrando una mesa ocupada por una comanda que el
        // servidor ya no tiene, y el mozo cobra sobre una mesa que no existe.
        const displacedId = asString(p.displacedOrderId);
        if (displacedId) {
          const displaced = await this.db.orders.get(displacedId);
          if (displaced) await this.db.orders.put({ ...displaced, tableId: null });
        }
        return;
      }

      default:
        // Un evento que este cliente no entiende puede ser de otra version del POS
        // instalada en otra tablet. Romper el ciclo por eso seria perder toda la
        // sincronizacion.
        void tx;
        return;
    }
  }

  async snapshot(): Promise<ReplicaSnapshot> {
    const [tables, orders, state] = await Promise.all([
      this.db.replicaTables.toArray(),
      this.db.orders.toArray(),
      this.readState(),
    ]);

    return { tables, orders, activeOrderId: state.activeOrderId };
  }

  // --- Mantenimiento ---

  /** Borra la replica local. Se usa al cerrar sesion y al cambiar de local. */
  async clear(): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.outbox, this.db.replicaTables, this.db.orders, this.db.deviceState],
      async () => {
        await Promise.all([
          this.db.outbox.clear(),
          this.db.replicaTables.clear(),
          this.db.orders.clear(),
          this.db.deviceState.clear(),
        ]);
      },
    );
  }

  /** Cuenta eventos esperando envio, para el indicador del spine. */
  pendingCountSync(): Promise<number> {
    return this.pendingCount();
  }

  /** Numero de eventos en `syncing`, para diagnosticar una app cerrada a medias. */
  async stuckCount(): Promise<number> {
    return this.db.outbox.where('status').equals('syncing').count();
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
