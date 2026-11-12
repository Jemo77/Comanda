import { uuidv7 } from '@comanda/domain';
import type { OutboxEvent, SyncEventType } from './protocol';
import type { SyncStorage } from './storage';

/**
 * Outbox del POS.
 *
 * Cada accion del POS genera un evento con UUIDv7 y se guarda local antes de
 * tocar la red. Ese orden —escribir primero, enviar despues— es lo que hace que
 * una caida de red a mitad de una comanda no pierda nada: si la tablet se apaga
 * justo despues de que el mozo toco "cobrar", el evento ya esta en IndexedDB.
 *
 * La secuencia (`seq`) es monotona por dispositivo y no se reinicia. Si se
 * reiniciara al abrir la app, dos eventos distintos podrian compartir `seq` y el
 * servidor no podria notar que le falta uno en el medio. El hueco se reporta,
 * no se rellena: un `seq` faltante puede ser un evento que nunca se genero, y
 * adivinar cual seria peor que saber que falta.
 */

export interface NewEvent {
  type: SyncEventType;
  payload: Record<string, unknown>;
  deviceId: string;
}

export class Outbox {
  /** Secuencia del ultimo evento generado en esta sesion. */
  private seq = 0;

  constructor(
    private readonly storage: SyncStorage,
    private readonly options: {
      /** Reloj inyectable: los tests no dependen del reloj real. */
      now?: () => Date;
      generateId?: () => string;
    } = {},
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private generateId(): string {
    return this.options.generateId ? this.options.generateId() : uuidv7();
  }

  /**
   * Retoma la secuencia desde el servidor.
   *
   * Al reconectar, `pull` devuelve la ultima secuencia que el servidor vio de este
   * dispositivo. Restaurarla aca es lo que evita el choque de `seq` described
   * arriba.
   */
  restoreSeq(from: number): void {
    if (from > this.seq) this.seq = from;
  }

  /** Secuencia del proximo evento. Solo lectura, para inspeccion. */
  currentSeq(): number {
    return this.seq;
  }

  /**
   * Encola un evento y lo devuelve.
   *
   * El payload se clona al escribir. Es barato comparado con un bug en el que un
   * objeto que el mozo sigue editando (una nota, un item recien agregado) cambia
   * despues de quedar en la cola, y lo que se sube no es lo que se vio.
   */
  async enqueue(event: NewEvent): Promise<OutboxEvent> {
    this.seq += 1;
    const record: OutboxEvent = {
      eventId: this.generateId(),
      type: event.type,
      seq: this.seq,
      occurredAt: this.now().toISOString(),
      payload: structuredClone(event.payload),
      deviceId: event.deviceId,
      status: 'pending',
      attempts: 0,
      lastError: null,
    };

    await this.storage.putEvent(record);
    return record;
  }

  /**
   * Lote a enviar, en orden de `seq`.
   *
   * El orden importa y no es cosmético: el servidor aplica los eventos en el
   * orden en que llegan, asi que un lote desordenado podria aplicar "agregar
   * item" antes que "abrir comanda".
   */
  async nextBatch(limit = 100): Promise<OutboxEvent[]> {
    const batch = await this.storage.nextBatch(limit);
    return [...batch].sort((a, b) => a.seq - b.seq);
  }

  /** Cuenta los eventos esperando envio. */
  async pendingCount(): Promise<number> {
    return this.storage.pendingCount();
  }
}
