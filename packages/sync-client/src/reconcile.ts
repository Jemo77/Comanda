import type { OutboxEvent, SyncEventResult, SyncAction, TableConflict } from './protocol';
import type { SyncStorage, ReplicaOrder, ReplicaTable } from './storage';

/**
 * Reconciliacion: que hacer con lo que respondio el servidor.
 *
 * El POS es optimista: escribe en la replica y en la outbox, y sigue trabajando
 * como si la accion hubiera ocurrido. Eso es lo que hace que agregar un item sea
 * instantaneo y que el POS funcione sin cable. El precio de esa decision es que
 * el servidor puede decir "no" despues, y esta clase decide que hacer con ese
 * "no".
 *
 * Hay tres desenlaces y se distinguen a proposito:
 *
 *  - **APPLIED**: el servidor esta de acuerdo. Se borra de la outbox.
 *  - **DUPLICATE**: el servidor ya lo tenia. Tambien se borra: el reenvio de la
 *    cola entera tiene que ser seguro, y lo es justamente por esto.
 *  - **REJECTED / CONFLICT**: el POS tiene que *corregirse*. Un item que el
 *    servidor rechazo no puede quedar en la replica: el mozo lo veria en el
 *    ticket y al cobrar daria un numero que el servidor no tiene.
 *
 * La ultima linea es la que importa: un evento que no limpio se marca en
 * `conflicts` para que la UI lo muestre, en vez de desaparecer en silencio.
 */

export interface ReconciliationReport {
  /** Eventos que el servidor confirmo (nuevos o ya vistos). */
  acknowledged: string[];
  /** Eventos que el servidor no aplico y el POS tiene que revertir. */
  rejected: Array<{ eventId: string; reason: string; action: SyncAction }>;
  /** Mesa que hay que reasignar, si el servidor se quedo con otra comanda. */
  tableConflicts: TableConflict[];
  /** Numero de eventos que quedaron en la cola para el proximo intento. */
  stillPending: number;
  /** Cursor del pull, para la proxima vuelta. */
  cursor: string;
}

/**
 * Aplica los resultados de un push a la replica y la outbox.
 *
 * `results` viene del servidor. El servidor ya decidio; aca no se re-juzga nada,
 * solo se traduce su veredicto a cambios locales. La unica excepcion es la mesa:
 * ahi el servidor dice "perdi", y el POS tiene que saber cual comanda era suya.
 */
export async function reconcile(
  storage: SyncStorage,
  results: readonly SyncEventResult[],
  opts: {
    /** Ordenes del dispositivo, para resolver el caso de mesa en disputa. */
    ownOrders?: readonly ReplicaOrder[];
    tables?: readonly ReplicaTable[];
  } = {},
): Promise<ReconciliationReport> {
  const acknowledged: string[] = [];
  const rejected: ReconciliationReport['rejected'] = [];
  const tableConflicts: TableConflict[] = [];

  for (const result of results) {
    if (result.status === 'APPLIED' || result.status === 'DUPLICATE') {
      acknowledged.push(result.eventId);
      continue;
    }

    const action = result.action ?? 'NONE';
    const reason = result.message ?? 'El servidor no acepto la operacion.';

    rejected.push({ eventId: result.eventId, reason, action });

    // `REASSIGN_TABLE` es el unico caso donde el POS tiene que cambiar de mesa
    // una comanda que el mozo ya ve en pantalla. El servidor le dice explicitamente
    // que mesa y que comanda; el POS no lo deduce.
    if (action === 'REASSIGN_TABLE') {
      const conflict = readTableConflict(result);
      if (conflict) tableConflicts.push(conflict);
    }
  }

  // Los confirmados salen de la cola. Los rechazados tambien: reenviar un evento
  // que el servidor rechazo de forma deterministica (un payload invalido, un
  // producto que ya no existe) lo convertiria en un bucle infinito de rechazos.
  // Lo que se conserva para el proximo intento es lo que fallo por red, y eso se
  // maneja en `pushWithRetry`, no aca.
  if (acknowledged.length > 0 || rejected.length > 0) {
    await storage.removeEvents([...acknowledged, ...rejected.map((r) => r.eventId)]);
  }

  const stillPending = await storage.pendingCount();

  // Si hubo una mesa en disputa, hay que corregir la replica: la mesa sigue
  // ocupada, pero por otra comanda. Sin esto, el POS sigue mostrando la mesa con
  // la comanda que el servidor le quito.
  if (tableConflicts.length > 0) {
    await applyTableConflicts(storage, tableConflicts, opts);
  }

  const cursor = await storage.getCursor();

  return { acknowledged, rejected, tableConflicts, stillPending, cursor };
}

/**
 * Lee el conflicto de mesa de la respuesta del servidor.
 *
 * Se leen campos explicitos y no se infieren del mensaje: el mensaje esta escrito
 * para el mozo ("La mesa ya la tiene abierta otra comanda"), no para el codigo.
 */
function readTableConflict(result: SyncEventResult): TableConflict | null {
  const data = result.data ?? {};
  const tableId = data.tableId;
  const winningOrderId = data.orderId;

  if (typeof tableId !== 'string' || typeof winningOrderId !== 'string') {
    return null;
  }

  return {
    tableId,
    winningOrderId,
    displacedOrderId: typeof data.conflictingOrderId === 'string' ? data.conflictingOrderId : null,
  };
}

/**
 * Corrige la replica tras un conflicto de mesa.
 *
 * El orden importa: primero se suelta la mesa de la comanda desplazada, despues
 * se asigna a la ganadora. Al reves, la mesa queda un instante apuntando a dos
 * comandas y un render intermedio puede pintar la comanda equivocada.
 */
async function applyTableConflicts(
  storage: SyncStorage,
  conflicts: readonly TableConflict[],
  opts: {
    ownOrders?: readonly ReplicaOrder[];
    tables?: readonly ReplicaTable[];
  },
): Promise<void> {
  // Los conflicts los aplica el storage en su `applyRemote`, que ya sabe escribir
  // la replica de forma atomica. Aca solo se calcula que hay que escribir.
  for (const conflict of conflicts) {
    const displaced = conflict.displacedOrderId
      ? opts.ownOrders?.find((order) => order.id === conflict.displacedOrderId)
      : undefined;

    const table = opts.tables?.find((candidate) => candidate.id === conflict.tableId);

    await storage.applyRemote([
      {
        cursor: `conflict:${conflict.tableId}`,
        type: 'TABLE_STATUS_CHANGED',
        receivedAt: new Date().toISOString(),
        deviceId: 'server',
        payload: {
          tableId: conflict.tableId,
          orderId: conflict.winningOrderId,
          label: table?.label ?? null,
          status: 'OCUPADA',
          // La comanda desplazada queda sin mesa y con esto el POS la muestra
          // como "sin mesa", para que el mozo la vuelva a ubicar y no la pierda.
          displacedOrderId: displaced?.id ?? conflict.displacedOrderId,
        },
      },
    ]);
  }
}

/**
 * Devuelve a la cola lo que quedo en `syncing`.
 *
 * El POS se cierra a mitad de un envio con frecuencia (la tablet se apaga, el
 * mozo reinicia la app). Sin esto, esos eventos quedan clavados en `syncing`
 * para siempre y nunca llegan al servidor: el cobro se pierde en silencio, que
 * es la peor forma de perder un cobro.
 */
export async function recoverInterruptedPush(storage: SyncStorage): Promise<number> {
  return storage.requeueStuck();
}

/**
 * Cuenta eventos esperando envio.
 *
 * Vive en el spine del POS, no en un badge flotante: si cambia, tiene que cambiar
 * en el lugar donde el mozo ya mira.
 */
export async function pendingEventCount(storage: SyncStorage): Promise<number> {
  return storage.pendingCount();
}

/**
 * Resultado de encolar un evento.
 *
 * Se devuelve el evento para que quien encola pueda mostrar el id o correlacionar
 * la escritura local con el evento que subira.
 */
export type EnqueuedEvent = OutboxEvent;
