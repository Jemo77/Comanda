/**
 * Tipos del protocolo de sincronizacion.
 *
 * El catalogo de eventos vive en `@comanda/domain` porque tiene que ser el mismo
 * en el POS y en el servidor. Este archivo solo reexporta: no duplica la lista.
 *
 * Cuando el POS y la API tienen cada uno su copia del enum, alguien agrega un
 * evento a uno y se olvida del otro, y el sintoma es un `REJECTED` con un mensaje
 * que no explica nada en un local a las dos de la mañana.
 */
export {
  SYNC_EVENT_TYPES,
  SYNC_EVENT_TYPE_SET,
  SyncEventTypeSchema,
  SERVER_ONLY_EVENT_TYPES,
  CLIENT_PRODUCED_EVENT_TYPES,
  MONEY_EVENT_TYPES,
  REASON_REQUIRED_EVENT_TYPES,
  SYNC_EVENT_STATUSES,
  SYNC_ACTIONS,
} from '@comanda/domain';

export type {
  SyncEventType,
  SyncEventStatus,
  SyncAction,
  SyncEventInput,
  SyncEventResult,
  PushResult,
  PullEvent,
  PullResult,
  TableConflict,
} from '@comanda/domain';

// `SyncEventType` se importa ademas de exportarse: un `export type` no trae el
// nombre al ambito local, y las interfaces de mas abajo lo necesitan.
import type { SyncEventType } from '@comanda/domain';

/** Estado de un evento dentro de la outbox local. */
export type OutboxStatus = 'pending' | 'syncing' | 'done' | 'failed';

/** Evento tal como lo guarda el POS antes de enviarlo. */
export interface OutboxEvent {
  /** UUIDv7 del dispositivo. Es la idempotencia: el servidor lo ignora si ya lo vio. */
  eventId: string;
  type: SyncEventType;
  /** Secuencia monotona del dispositivo. Detecta huecos y reordenamientos. */
  seq: number;
  /** Reloj del dispositivo. Puede estar desfasado: nunca decide dinero. */
  occurredAt: string;
  payload: Record<string, unknown>;
  deviceId: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
}
