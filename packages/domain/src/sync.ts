import { z } from 'zod';

/**
 * Catalogo de eventos de sincronizacion.
 *
 * Vive en `domain` y no en el cliente ni en la API por una razon concreta: la
 * lista tiene que ser **la misma en los tres lugares**. Cuando el POS y el
 * servidor tienen cada uno su copia, alguien agrega un evento a uno y se olvida
 * del otro, y el síntoma es un `REJECTED` con un mensaje que no explica nada
 * ("tipo de evento desconocido") en un local a las dos de la mañana.
 *
 * La constraint de `sync_events.type` en la base es el cuarto lugar donde esta
 * lista esta escrita. Si se agrega un evento aca y no en la migracion, el push
 * falla por una violacion de check, no por un evento desconocido.
 */

/**
 * Tipos de evento que el POS produce.
 *
 * Notacion: los eventos que mueven la comanda (`ORDER_*`) son la fuente de la
 * verdad. Los de mesa (`TABLE_*`) son la vista que el servidor emite para
 * mantener el mapa al dia: en el flujo normal un cambio de estado de mesa no
 * viaja como evento propio, se deriva de abrir o cerrar la comanda.
 */
export const SYNC_EVENT_TYPES = [
  // Comanda
  'ORDER_OPENED',
  'ORDER_ITEM_ADDED',
  'ORDER_ITEM_VOIDED',
  'ORDER_NOTE_SET',
  'ORDER_ITEM_COURSE_SET',
  'ORDER_SEAT_SET',
  'ORDER_CLOSED',
  'ORDER_CANCELED',
  // Cobro
  'PAYMENT_RECORDED',
  'TIP_ADDED',
  'SPLIT_SAVED',
  /** Descuento y tasa de servicio: estado de la orden, no operacion sobre el total. */
  'ORDER_CHARGES_SET',
  // Caja
  'SHIFT_OPENED',
  'SHIFT_CASH_MOVEMENT',
  // Cocina
  'KDS_STATUS_SET',
  // Salon: los produce el POS para el mapa de mesas
  'TABLE_OPENED',
  'TABLE_ITEM_ADDED',
  'TABLE_ITEM_VOIDED',
  'TABLE_NOTE_SET',
  // Cambios que el servidor emite para actualizar la replica del POS
  'CATALOG_PUBLISHED',
  'TABLE_STATUS_CHANGED',
] as const;

export type SyncEventType = (typeof SYNC_EVENT_TYPES)[number];

/** Union para validar en el borde sin arrastrar el array. */
export const SyncEventTypeSchema = z.enum(SYNC_EVENT_TYPES);

export const SYNC_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(SYNC_EVENT_TYPES);

/**
 * Eventos que el POS puede encolar: los que produce una accion del mozo.
 *
 * Los que empieza por `TABLE_STATUS_CHANGED` y `CATALOG_PUBLISHED` los genera el
 * servidor, asi que un POS que los encole esta escribiendo algo que el servidor
 * no espera.
 */
export const CLIENT_PRODUCED_EVENT_TYPES = SYNC_EVENT_TYPES.filter(
  (type) => type !== 'TABLE_STATUS_CHANGED' && type !== 'CATALOG_PUBLISHED',
);

/** Eventos que solo puede emitir el servidor. */
export const SERVER_ONLY_EVENT_TYPES = [
  'TABLE_STATUS_CHANGED',
  'CATALOG_PUBLISHED',
] as const satisfies readonly SyncEventType[];

/**
 * Eventos que tocan dinero.
 *
 * Se separan porque son los que exigen idempotencia estricta y los que un
 * operador no puede corregir a mano: si un cobro se duplica, hay que devolver
 * plata y el arqueo del turno ya cerro.
 */
export const MONEY_EVENT_TYPES = [
  'PAYMENT_RECORDED',
  'TIP_ADDED',
  'SPLIT_SAVED',
  'ORDER_CHARGES_SET',
  'SHIFT_CASH_MOVEMENT',
] as const satisfies readonly SyncEventType[];

/**
 * Eventos que exigen motivo escrito.
 *
 * Sin motivo no hay forma de responder "por que se desconto esto", y el
 * `AUDIT_ACTIONS_REQUIRING_REASON` del dominio ya lo exige del lado del servidor.
 */
export const REASON_REQUIRED_EVENT_TYPES = [
  'ORDER_ITEM_VOIDED',
  'SHIFT_CASH_MOVEMENT',
  'ORDER_CHARGES_SET',
] as const satisfies readonly SyncEventType[];

/** Evento con su payload crudo, tal como viaja del POS al servidor. */
export interface SyncEventInput {
  /** UUIDv7 generado en el dispositivo. Es la idempotencia del push. */
  eventId: string;
  type: SyncEventType;
  /** Secuencia monotona del dispositivo. Detecta huecos y reordenamientos. */
  seq: number;
  /** Reloj del dispositivo. Puede estar desfasado: nunca decide dinero. */
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** Como quedo un evento tras aplicarse en el servidor. */
export const SYNC_EVENT_STATUSES = ['APPLIED', 'DUPLICATE', 'REJECTED', 'CONFLICT'] as const;
export type SyncEventStatus = (typeof SYNC_EVENT_STATUSES)[number];

/**
 * Que tiene que hacer el POS con un evento que no se aplico limpio.
 *
 * Es una instruccion y no un estado: el cliente decide como la cumple, y por eso
 * el servidor no necesita saber nada del cliente.
 */
export const SYNC_ACTIONS = ['REASSIGN_TABLE', 'DISCARD', 'NONE'] as const;
export type SyncAction = (typeof SYNC_ACTIONS)[number];

export interface SyncEventResult {
  eventId: string;
  status: SyncEventStatus;
  /** Cursor global para seguir bajando. */
  cursor?: string;
  /** Ids que el POS tiene que guardar en su replica. */
  data?: Record<string, unknown>;
  /** Por que se rechazo, en palabras que se puedan mostrar al mozo. */
  message?: string;
  action?: SyncAction;
}

export interface PushResult {
  results: SyncEventResult[];
  /** Cursor a partir del cual seguir bajando. */
  cursor: string;
  /** Ultima secuencia que el servidor vio de este dispositivo. */
  acknowledgedSeq: number;
}

export interface PullEvent {
  cursor: string;
  type: SyncEventType;
  deviceId: string;
  seq: number;
  occurredAt: string;
  /** Reloj del servidor. Para reportes, este es el que manda. */
  receivedAt: string;
  payload: Record<string, unknown>;
  status: SyncEventStatus;
}

export interface PullResult {
  events: PullEvent[];
  /** Cursor siguiente. Si no hubo cambios, es el mismo que se pidio. */
  cursor: string;
  /** Ultima secuencia conocida de este dispositivo. */
  deviceSeq: number;
  /** Secuencias que faltan entre lo confirmado y lo recibido. */
  missingSeqs: number[];
}

/**
 * Conflicto que el servidor resolvio y que el POS tiene que absorber.
 *
 * El caso que lo motiva: dos tablets abren la misma mesa estando offline. Al
 * reconectar, el servidor decide cual se queda con la mesa segun el `occurred_at`
 * mas temprano, y le dice al perdedor que la libere. Si el POS ignorara esto,
 * los dos mostrarian la misma mesa ocupada con comandas distintas.
 */
export interface TableConflict {
  tableId: string;
  /** Comanda que el servidor le deja a este dispositivo. */
  winningOrderId: string;
  /** Comanda que quedo sin mesa y hay que reasignar. */
  displacedOrderId: string | null;
}
