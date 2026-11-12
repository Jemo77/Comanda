import type { PullResult, PushResult } from './protocol';
import { recoverInterruptedPush, reconcile, type ReconciliationReport } from './reconcile';
import type { SyncStorage, SyncTransport } from './storage';

/**
 * Motor de sincronizacion.
 *
 * Es lo que el POS llama cuando vuelve la conexion. Hace push de la outbox y pull
 * de lo que paso mientras estuvo offline, en ese orden:
 *
 *  1. **Push primero.** Si subimos antes de bajar, los eventos que el servidor
 *     genere por resolver *nuestro* conflicto de mesa llegan en el pull siguiente.
 *     Al reves, veriamos la mesa ocupada por una comanda que todavia no existe
 *     para nosotros y la pintura seria incorrecta.
 *
 *  2. **Un ciclo por vez.** Si hay un ciclo corriendo, el siguiente espera. Dos
 *     pushes simultaneos sobre la misma outbox pueden enviar el mismo evento dos
 *     veces; la idempotencia lo salva, pero gasta un viaje de red por evento.
 *
 *  3. **Fallar no es rechazar.** Un error de red deja los eventos en la cola para
 *     el proximo intento. Solo lo que el servidor *rechaza* (o sea, un payload
 *     invalido) sale de la cola: reenviar eso en bucle es ruido que nunca termina.
 */

export interface SyncRunResult {
  pushed: number;
  pulled: number;
  /** Eventos que el servidor no acepto y que la replica tiene que corregir. */
  reconciliation: ReconciliationReport;
  /** Ultimo cursor, guardado para la proxima vuelta. */
  cursor: string;
  /** Si el ciclo fallo por red, aca esta el motivo. */
  error: string | null;
}

export interface SyncEngineOptions {
  storage: SyncStorage;
  transport: SyncTransport;
  /** Dispositivo emisor. El servidor lo toma de la sesion, no del payload. */
  deviceId: string;
  /** Lote maximo por push. El servidor acepta hasta 500. */
  batchSize?: number;
  /**
   * Notifica la ultima secuencia que el servidor confirmo de este dispositivo.
   *
   * El motor no genera ids, asi que no puede retomar la secuencia por si mismo:
   * la mantiene el `Outbox`, que es el unico que emite `seq`. El callback mantiene
   * esa frontera en vez de duplicar el estado aqui.
   */
  onSeqConfirmed?: (seq: number) => void;
  logger?: (message: string) => void;
}

/** Tope de paginas por ciclo. Un POS que no converge en 50 viajes esta roto. */
const MAX_PAGES = 50;

export class SyncEngine {
  /** Cerrojo de ciclo. Un `sync` a la vez. */
  private running: Promise<SyncRunResult> | null = null;

  /** Ultimo resultado, para que la UI muestre "sincronizado, N pendientes". */
  private lastResult: SyncRunResult | null = null;

  private readonly batchSize: number;

  constructor(private readonly options: SyncEngineOptions) {
    this.batchSize = options.batchSize ?? 100;
  }

  getLastResult(): SyncRunResult | null {
    return this.lastResult;
  }

  /** Devuelve a la cola lo que quedo en `syncing` al cerrar la app. */
  async recover(): Promise<number> {
    return recoverInterruptedPush(this.options.storage);
  }

  /**
   * Corre un ciclo. Si ya hay uno corriendo, devuelve el resultado de ese.
   *
   * Que sea coalescente y no una cola es a proposito: la UI dispara `sync` cada
   * vez que vuelve la conexion y cada N segundos como red de seguridad. Encolar
   * esos disparos los acumularia en un pico de requests que no aporta nada.
   */
  async sync(accessToken: string): Promise<SyncRunResult> {
    if (this.running) return this.running;

    const cycle = this.run(accessToken).finally(() => {
      this.running = null;
    });

    this.running = cycle;
    return cycle;
  }

  private async run(accessToken: string): Promise<SyncRunResult> {
    const { storage, transport, deviceId, logger, onSeqConfirmed } = this.options;

    // Una tablet que se apogo a mitad de un envio deja eventos en `syncing`.
    // Recuperarlos es lo primero: si no, nunca se envian.
    await recoverInterruptedPush(storage);

    let pushed = 0;
    let pulled = 0;
    let reconciliation: ReconciliationReport | null = null;
    let cursor = await storage.getCursor();

    const fail = async (message: string): Promise<SyncRunResult> => ({
      pushed,
      pulled,
      // Si todavia no hubo un push que produjera informe, se arma uno con el
      // estado actual: la UI siempre necesita el cursor y los pendientes para
      // pintar, aunque el ciclo haya fallado.
      reconciliation: reconciliation ?? {
        acknowledged: [],
        rejected: [],
        tableConflicts: [],
        stillPending: await storage.pendingCount(),
        cursor,
      },
      cursor,
      error: message,
    });

    // --- Push, en lotes hasta vaciar la cola ---
    for (let batch = 0; batch < MAX_PAGES; batch += 1) {
      const events = (await storage.nextBatch(this.batchSize)).sort((a, b) => a.seq - b.seq);
      if (events.length === 0) break;

      let push: PushResult;
      try {
        push = await transport.push(accessToken, events, deviceId);
      } catch (error) {
        // Fallo de red o de servidor: NO se saca nada de la cola. El proximo
        // ciclo reintenta el mismo lote, y la idempotencia por `eventId` hace que
        // reintentar sea seguro.
        const message = describeError(error);
        logger?.(`sync: push fallo, se reintenta luego. ${message}`);
        this.lastResult = await fail(message);
        return this.lastResult;
      }

      const snapshot = await storage.snapshot();
      reconciliation = await reconcile(storage, push.results, {
        ownOrders: snapshot.orders,
        tables: snapshot.tables,
      });

      // La secuencia local se retoma desde lo que el servidor confirmo, para que
      // un reconectado largo no genere ids que choquen con los ya vistos.
      if (push.acknowledgedSeq > 0) onSeqConfirmed?.(push.acknowledgedSeq);

      pushed += events.length;
    }

    // --- Pull, pagina por pagina hasta llegar al final ---
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let pull: PullResult;
      try {
        pull = await transport.pull(accessToken, cursor, deviceId);
      } catch (error) {
        const message = describeError(error);
        logger?.(`sync: pull fallo, se reintenta luego. ${message}`);
        this.lastResult = await fail(message);
        return this.lastResult;
      }

      if (pull.events.length > 0) {
        await storage.applyRemote(pull.events);
        pulled += pull.events.length;
      }

      // El cursor avanza aunque la pagina venga vacia: asi el proximo ciclo
      // arranca desde aca y no vuelve a preguntar lo mismo.
      const advanced = pull.cursor;
      const isLastPage = pull.events.length === 0 || advanced === cursor;

      cursor = advanced;
      await storage.setCursor(cursor);

      // Corta si la pagina vino vacia (no hay mas que bajar) o si el cursor no se
      // movio. Lo segundo no deberia pasar con un servidor sano, pero sin este
      // chequeo un servidor que devuelve siempre el mismo cursor hace que el POS
      // pregunte MAX_PAGES veces por ciclo.
      if (isLastPage) break;
    }

    const finalSnapshot = await storage.snapshot();
    reconciliation =
      reconciliation ??
      (await reconcile(storage, [], {
        ownOrders: finalSnapshot.orders,
        tables: finalSnapshot.tables,
      }));

    this.lastResult = { pushed, pulled, reconciliation, cursor, error: null };
    return this.lastResult;
  }
}

/** Convierte cualquier error lanzado en algo que se pueda mostrar. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'No pudimos conectarnos con el servidor.';
}

export type { ReconciliationReport };
