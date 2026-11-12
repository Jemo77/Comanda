import type { OutboxEvent, PullResult, PushResult } from './protocol';
import type { SyncTransport } from './storage';

/**
 * Transporte HTTP contra `/sync/push` y `/sync/pull`.
 *
 * Es lo unico del paquete que toca la red, y esta aislado a proposito: el motor, la
 * outbox y la reconciliacion son puros y se testean sin red. Asi el unico lugar donde
 * puede fallar un fetch es este, y no hay logica de negocio mezclada con el `catch`.
 *
 * Dos detalles que parecen pequenos y no lo son:
 *
 *  - **Los errores de red no son errores de negocio.** Un `fetch` que falla tiene que
 *    salir por la excepcion para que el motor deje los eventos en la cola. Si
 *    devolviera un `PushResult` vacio, el motor creeria que todo se confirmo y
 *    vaciaria la outbox: la comanda se pierde en silencio.
 *
 *  - **Un 4xx del servidor es una respuesta, no un fallo de red.** Si el POS manda un
 *    evento invalido, el servidor responde 400 con detalle y hay que-mostrarlo; no
 *    tiene que reintentarse para siempre como si fuera una caida de red.
 */
export interface HttpTransportOptions {
  /** Base de la API, con el prefijo de version: `.../api/v1`. */
  baseUrl: string;
  /** Token de sesion. Cambia con el refresh, asi que se pasa por llamada. */
  getAccessToken: () => string | null;
  /** Se llama cuando el token expira, para que la app lo renueve y reintente. */
  onUnauthorized?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export class HttpSyncTransport implements SyncTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    /**
     * `fetch` se inyecta para los tests; en el navegador esta el nativo.
     *
     * El `bind` no es cosmetico y el motivo es uno que solo aparece en el POS: en el
     * navegador, `fetch` debe invocarse **con `globalThis` como receptor**, o tira
     * `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`. En Node
     * no pasa: `fetch` es una funcion suelta y el motor no chequea el receptor.
     *
     * Por eso los tests del paquete, que corren en Node con `fetch` inyectado, dan
     * verde con un POS que en el mostrador no sube **nada**: cada ciclo de
     * sincronizacion falla, la outbox nunca baja, y el sintoma en el local es que
     * todo se ve "pendiente" y nada llega al servidor. El unico lugar donde hay que
     * mirar para encontrarlo es el navegador.
     */
    const native = options.fetchImpl ?? globalThis.fetch;
    if (typeof native !== 'function') {
      throw new Error('HttpSyncTransport necesita fetch: no hay ninguno en este runtime.');
    }
    this.fetchImpl = native.bind(globalThis);
  }

  async push(accessToken: string, events: OutboxEvent[], _deviceId: string): Promise<PushResult> {
    const body = await this.request<PushResult>('POST', '/sync/push', accessToken, {
      events: events.map((event) => ({
        eventId: event.eventId,
        type: event.type,
        seq: event.seq,
        occurredAt: event.occurredAt,
        payload: event.payload,
      })),
    });

    return body;
  }

  async pull(accessToken: string, since: string, _deviceId: string): Promise<PullResult> {
    const query = new URLSearchParams({ since });
    return this.request<PullResult>('GET', `/sync/pull?${query.toString()}`, accessToken);
  }

  /**
   * Una peticion, con dos reintentos identidad.
   *
   * Reintentar es seguro por la idempotencia del `eventId`: el servidor descarta lo
   * que ya vio. Sin esto, un corte de red en el momento de enviar deja la comanda
   * en la cola hasta el proximo ciclo, y el mozo la ve "pendiente" sin razon.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    payload?: unknown,
  ): Promise<T> {
    const attempts = method === 'GET' ? 2 : 3;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.once<T>(method, path, accessToken, payload);
      } catch (error) {
        lastError = error;
        // Un 4xx no se reintenta: el servidor rechazo el evento de forma
        // deterministica y mandarlo otra vez va a fallar otra vez.
        if (isClientError(error)) throw error;
        // Backoff corto. El POS va a volver a intentarlo en el proximo ciclo
        // igual; esto solo cubre el corte de red de un momento.
        if (attempt < attempts - 1) await delay(150 * (attempt + 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Fallo de red desconocido.');
  }

  private async once<T>(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    payload?: unknown,
  ): Promise<T> {
    const token = accessToken || this.options.getAccessToken() || '';
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });

    if (response.ok) return (await response.json()) as T;

    // 401: el token vencio. Se pide uno nuevo y se reintenta una vez, porque el
    // POS funciona con refresh y no deberia perder un cobro por un token vencido.
    if (response.status === 401 && this.options.onUnauthorized) {
      const fresh = await this.options.onUnauthorized();
      if (fresh) return this.once<T>(method, path, fresh, payload);
    }

    throw await toProblemError(response);
  }
}

/**
 * Convierte un `problem+json` en un error con el mensaje del servidor.
 *
 * El POS muestra el `detail` al mozo, asi que un error generico tipo "HTTP 400"
 * no le sirve: lo que necesita saber es que paso.
 */
async function toProblemError(response: Response): Promise<Error> {
  let detail = `El servidor respondio ${response.status}.`;
  try {
    const problem = (await response.json()) as { detail?: string; code?: string };
    if (typeof problem.detail === 'string' && problem.detail.length > 0) {
      detail = problem.detail;
    }
  } catch {
    // Respuesta que no es JSON: un 502 de un proxy, por ejemplo. El mensaje
    // generico es mejor que mostrarle HTML de infraestructura al mozo.
  }

  const error = new Error(detail) as Error & { status?: number; code?: string };
  error.status = response.status;
  return error;
}

/** Un 4xx no se reintenta: el rechazo es deterministico. */
function isClientError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
