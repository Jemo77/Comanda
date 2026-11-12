import type { SyncStorage } from './storage';

/**
 * Diagnostico de la outbox.
 *
 * Un POS puede quedar con la outbox en un estado raro sin que nada falle de forma
 * visible: un evento perdido, un `seq` repetido, eventos atascados en `syncing`.
 * Estas funciones no corrigen nada: **describen**. La diferencia importa, porque
 * "arreglar" un hueco de secuencia inventando un evento faltante produce un evento
 * que el mozo nunca hizo.
 */

/** Un hueco entre dos secuencias. */
export interface SequenceGap {
  /** Secuencia del evento anterior al hueco. */
  after: number;
  /** Secuencias que faltan. */
  missing: number[];
}

export interface SequenceHealth {
  /** No hay huecos ni reordenamientos. */
  ok: boolean;
  /** Ultima secuencia generada en esta sesion. */
  localSeq: number;
  gaps: SequenceGap[];
  /** Eventos cuyo `seq` no va en aumento respecto del anterior. */
  outOfOrder: number;
  /** Eventos trabados en `syncing`, que solo se despejan al reabrir la app. */
  stuck: number;
}

/**
 * Revisa la secuencia local.
 *
 * Un hueco puede ser un evento que nunca se genero, uno que se perdio antes de
 * llegar al servidor, o uno que el servidor rechazo. No se puede distinguir desde
 * el dispositivo, asi que se reporta y no se rellena.
 */
export async function checkSequence(
  storage: SyncStorage,
  localSeq: number,
): Promise<SequenceHealth> {
  const batch = await storage.nextBatch(Number.MAX_SAFE_INTEGER);
  const ordered = [...batch].sort((a, b) => a.seq - b.seq);

  const gaps: SequenceGap[] = [];
  let previous: number | null = null;

  for (const event of ordered) {
    if (previous !== null && event.seq > previous + 1) {
      const missing: number[] = [];
      for (let seq = previous + 1; seq < event.seq; seq += 1) missing.push(seq);
      gaps.push({ after: previous, missing });
    }
    previous = event.seq;
  }

  // Fuera de orden respecto del orden en que quedaron guardados, no del `seq`: dos
  // eventos con el mismo `seq` es un problema aunque esten ordenados.
  const outOfOrder = batch.filter(
    (event, index) => index > 0 && event.seq <= batch[index - 1]!.seq,
  ).length;

  return {
    ok: gaps.length === 0 && outOfOrder === 0,
    localSeq,
    gaps,
    outOfOrder,
    stuck: 0,
  };
}

/**
 * Eventos que quedaron en `syncing`.
 *
 * `nextBatch` solo trae `pending` y `failed`, asi que los trabados se detectan por
 * la diferencia con el total pendiente. Si es mayor que cero al abrir la app, el
 * POS se cerro a mitad de un envio.
 */
export async function stuckEvents(storage: SyncStorage): Promise<number> {
  const enqueued = await storage.nextBatch(Number.MAX_SAFE_INTEGER);
  const pending = await storage.pendingCount();
  return Math.max(0, pending - enqueued.length);
}
