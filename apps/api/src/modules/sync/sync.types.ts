import type { PoolClient } from 'pg';

/**
 * Tipos del protocolo de sincronizacion.
 *
 * El catalogo de eventos vive en `@comanda/domain` y se reexporta desde ahi: el
 * POS y el servidor tienen que compartir exactamente la misma lista. Cada copia
 * propia es una invitation a que alguien agregue un evento a un lado y el otro
 * lado lo rechace sin explicacion.
 *
 * Lo que queda en este archivo es lo que es propriamente del servidor.
 */
export {
  SYNC_EVENT_TYPES,
  SyncEventTypeSchema,
  SYNC_EVENT_STATUSES,
  SYNC_ACTIONS,
  SERVER_ONLY_EVENT_TYPES,
  MONEY_EVENT_TYPES,
  REASON_REQUIRED_EVENT_TYPES,
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

import type { SyncEventStatus } from '@comanda/domain';

/** Como quedo cada evento tras aplicarse. El cliente lo lee para corregir su copia. */
export type ApplyStatus = SyncEventStatus;

/** Resultado de aplicar un evento individual. */
export interface ApplyOutcome {
  status: SyncEventStatus;
  data?: Record<string, unknown>;
  message?: string;
  action?: SyncEventResultAction;
}

export type SyncEventResultAction = 'REASSIGN_TABLE' | 'DISCARD' | 'NONE';

/**
 * Lo que necesita el `apply` para decidir.
 *
 * Se pasa por constructor y no se lee del `request`: el apply corre dentro de la
 * transaccion que ya abrio el interceptor de tenant, y leer el contexto de ahi
 * otra vez seria una segunda fuente de verdad para la misma cosa.
 */
export interface ApplyDeps {
  /** Id del local, tomado de la sesion. */
  venueId: string;
  orgId: string;
  actorId: string | null;
  deviceId: string;
  /** Reloj inyectable: los tests de conflicto de mesa fijan la hora. */
  now: () => Date;
  /**
   * Avisa que un ticket cambio de estado, para que el KDS lo recargue.
   *
   * Va como callback y no como llamada directa al gateway por una razon concreta: el
   * handler corre **dentro** de la transaccion, y emitir ahi publicaria un estado que
   * todavia no esta en la base. El collector lo guarda y `push` lo emite despues del
   * COMMIT, que es cuando la fila existe de verdad.
   *
   * Opcional: los tests que llaman al handler directo no tienen KDS al que avisarle.
   */
  onKdsTicketChanged?: (ticketId: string) => void;
  /**
   * Avisa que los items de una comanda cambiaron (alta o anulacion).
   *
   * Las lineas del ticket se derivan de `order_items`, asi que un item anulado sale del
   * papel de cocina sin que nadie lo diga: sin este aviso, el KDS sigue mostrando algo
   * que ya no existe.
   */
  onKdsOrderChanged?: (orderId: string) => void;
}

export type { PoolClient };
