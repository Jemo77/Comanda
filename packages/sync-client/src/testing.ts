import type { OutboxEvent, PullEvent, PullResult, PushResult, SyncEventResult } from './protocol';
import type { SyncTransport } from './storage';

/**
 * Transporte falso para tests.
 *
 * Simula al servidor sin red: decide que hacer con cada evento y guarda lo que
 * "recibio" para que el test pueda afirmar que no se duplico nada.
 *
 * Lo importante es que el transporte recorda TODO lo que le mandaron, incluso lo
 * que ya habia visto. Un transporte que "olvida" los repetidos haria pasar el
 * test de idempotencia por la razon equivocada: el bug real (reenviar sin
 * deduplicar) solo aparece cuando el servidor puede responder a un duplicado.
 */
export class FakeTransport implements SyncTransport {
  /** Todos los eventos recibidos, con repeticiones. */
  readonly received: OutboxEvent[] = [];

  /** Eventos que el servidor "vio" por primera vez. */
  readonly seen = new Set<string>();

  /** Eventos que el servidor tiene pendientes de entregar por pull. */
  private remoteEvents: PullEvent[] = [];

  private cursorSeq = 0;

  /** Falla el proximo push con este error. `null` desarma. */
  failNextPush: Error | null = null;

  /** Falla el proximo pull con este error. */
  failNextPull: Error | null = null;

  /** Contadores de red, para afirmar cuantos viajes hubo. */
  pushCalls = 0;
  pullCalls = 0;

  constructor(private readonly deviceId: string) {}

  async push(_token: string, events: OutboxEvent[], _device: string): Promise<PushResult> {
    this.pushCalls += 1;
    if (this.failNextPush) {
      const error = this.failNextPush;
      this.failNextPush = null;
      throw error;
    }

    const results: SyncEventResult[] = [];
    const seqs: number[] = [];

    for (const event of events) {
      this.received.push(event);

      if (this.seen.has(event.eventId)) {
        // Duplicado: el servidor responde DUPLICATE y NO vuelve a aplicar. Este
        // es el camino que hace seguro reenviar la cola entera.
        results.push({
          eventId: event.eventId,
          status: 'DUPLICATE',
          cursor: String(this.cursorSeq),
        });
        continue;
      }

      this.seen.add(event.eventId);
      seqs.push(event.seq);
      this.publish(event);

      results.push({
        eventId: event.eventId,
        status: 'APPLIED',
        cursor: String(this.cursorSeq),
        data: { orderId: event.payload.orderId, itemId: event.payload.itemId },
      });
    }

    return {
      results,
      cursor: String(this.cursorSeq),
      acknowledgedSeq: seqs.length > 0 ? Math.max(...seqs) : 0,
    };
  }

  async pull(_token: string, since: string, _device: string): Promise<PullResult> {
    this.pullCalls += 1;
    if (this.failNextPull) {
      const error = this.failNextPull;
      this.failNextPull = null;
      throw error;
    }

    const sinceSeq = Number(since);
    const pending = this.remoteEvents
      .filter((event) => Number(event.cursor) > sinceSeq)
      .sort((a, b) => Number(a.cursor) - Number(b.cursor));

    const page = pending.slice(0, 200);
    const cursor =
      page.length > 0
        ? page[page.length - 1]!.cursor
        : sinceSeq > this.cursorSeq
          ? since
          : String(this.cursorSeq);

    const deviceSeqs = this.received.map((event) => event.seq).filter((seq) => seq > 0);
    const deviceSeq = deviceSeqs.length > 0 ? Math.max(...deviceSeqs) : 0;

    return {
      events: page,
      cursor,
      deviceSeq,
      missingSeqs: [],
    };
  }

  /** Publica un evento como si lo hubiera generado el servidor. */
  publish(event: OutboxEvent, overrides: Partial<PullEvent> = {}): PullEvent {
    this.cursorSeq += 1;
    const published: PullEvent = {
      cursor: String(this.cursorSeq),
      type: event.type,
      deviceId: event.deviceId,
      seq: event.seq,
      occurredAt: event.occurredAt,
      receivedAt: new Date().toISOString(),
      payload: event.payload,
      status: 'APPLIED',
      ...overrides,
    };
    this.remoteEvents.push(published);
    return published;
  }

  /** Publica un evento arbitrario, para simular otro dispositivo. */
  publishRaw(event: Omit<PullEvent, 'cursor'>): PullEvent {
    this.cursorSeq += 1;
    const published: PullEvent = { ...event, cursor: String(this.cursorSeq) };
    this.remoteEvents.push(published);
    return published;
  }

  /** cuantos eventos unicos.server vio. */
  uniqueSeen(): number {
    return this.seen.size;
  }

  /** Cuantas veces se recibio un evento con ese id. */
  timesReceived(eventId: string): number {
    return this.received.filter((event) => event.eventId === eventId).length;
  }

  get device(): string {
    return this.deviceId;
  }
}

/** Error de red tipico, para simular un corte. */
export function networkError(message = 'Failed to fetch'): Error {
  return new Error(message);
}
