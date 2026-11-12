import type { OutboxEvent, PullResult, PushResult, SyncEventType } from './protocol';

/**
 * Almacenamiento del POS.
 *
 * Una interfaz en vez de Dexie directo, por dos razones concretas:
 *
 *  1. **Se puede testear en Node.** La logica de reconciliacion es lo mas
 *     importante del modo offline y probar eso contra un IndexedDB de verdad
 *     significa un navegador por cada caso. Con un adaptador en memoria, los
 *     tests corren en milisegundos y sin navegador.
 *
 *  2. **La replica y la outbox son cosas distintas.** La replica es "lo que el
 *     POS cree que es verdad" y se sobreescribe con lo que baja el servidor. La
 *     outbox es "lo que hay que subir" y nunca se pisa con nada del servidor.
 *     Confundirlas es como se pierde una comanda.
 */
export interface SyncStorage {
  // --- Outbox: sale del dispositivo, nunca se sobreescribe ---
  putEvent(event: OutboxEvent): Promise<void>;
  /** Lote pendiente en orden de `seq`, que es el orden en que ocurrio. */
  nextBatch(limit: number): Promise<OutboxEvent[]>;
  /** Marca como enviado. Si el evento no esta, se ignora: el push ya lo logro. */
  removeEvents(eventIds: string[]): Promise<void>;
  /** Vuelve a la cola lo que quedo en `syncing` (app cerrada a mitad de envio). */
  requeueStuck(): Promise<number>;
  pendingCount(): Promise<number>;

  // --- Replica: baja del servidor ---
  /** Guarda el cursor del pull. Es lo unico que sobrevive a la app cerrada. */
  getCursor(): Promise<string>;
  setCursor(cursor: string): Promise<void>;

  /**
   * Aplica un lote de eventos del servidor a la replica.
   *
   * Se delega entera al storage porque la aplicacion tiene que ser atomica: si
   * el POS se cierra entre dos escrituras de un mismo evento, al volver a abrir
   * la replica queda con medio estado y el mozo cobra de mas.
   */
  applyRemote(events: readonly RemoteEvent[]): Promise<void>;

  /** Replica actual, para que la UI pueda pintar sin preguntar a la red. */
  snapshot(): Promise<ReplicaSnapshot>;
}

/** Evento del servidor ya normalizado para aplicarse a la replica. */
export interface RemoteEvent {
  cursor: string;
  type: SyncEventType;
  payload: Record<string, unknown>;
  receivedAt: string;
  /** De que dispositivo vino. El propio POS ignora lo suyo. */
  deviceId: string;
}

/** Lo que la UI lee. Todo en enteros y snapshots, nunca referencias. */
export interface ReplicaSnapshot {
  tables: ReplicaTable[];
  orders: ReplicaOrder[];
  /** Comanda que el POS tiene abierta ahora, si hay. */
  activeOrderId: string | null;
}

export interface ReplicaTable {
  id: string;
  floorId: string;
  label: string;
  seats: number;
  status: 'LIBRE' | 'OCUPADA' | 'PIDIO_CUENTA' | 'RESERVADA' | 'BLOQUEADA';
  orderId: string | null;
  occupiedSince: string | null;
}

export interface ReplicaOrder {
  id: string;
  numberLabel: string;
  tableId: string | null;
  tableLabel: string | null;
  status: 'OPEN' | 'PEDIDO_CUENTA' | 'CLOSED' | 'CANCELLED';
  openedAt: string;
  guests: number;
  totalCents: number;
  tipCents: number;
  items: ReplicaItem[];
}

export interface ReplicaItem {
  id: string;
  orderId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  modifiers: Array<{ name: string; priceDeltaCents: number }>;
  status: 'ACTIVE' | 'VOIDED';
  note: string | null;
  seat: number | null;
  course: number;
}

/** Transporte HTTP. Se inyecta para poder testear sin red. */
export interface SyncTransport {
  push(accessToken: string, events: OutboxEvent[], deviceId: string): Promise<PushResult>;
  pull(accessToken: string, since: string, deviceId: string): Promise<PullResult>;
}
