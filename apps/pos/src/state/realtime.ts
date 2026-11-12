import { io } from 'socket.io-client';
import { getAccessToken } from '../data/token';

/**
 * Suscripcion a tiempo real del POS.
 *
 * ## Lo que hace, y lo que NO hace
 *
 * **Dispara un refresh. No reemplaza el estado.**
 *
 * La fuente de verdad del KDS sigue siendo la replica local (`db.kitchenTickets` en
 * IndexedDB). Cuando llega un evento del socket, lo que se hace es releer la replica y
 * repintar, exactamente igual que cuando el ciclo de sincronizacion termina. El socket
 * es una mejora de latencia, no una segunda fuente.
 *
 * La razon es una sola y es la que hizo este modulo: **un POS que solo funciona con el
 * socket vuelve a no vender cuando se cae la conexion**, que es exactamente lo que esta
 * fase vino a resolver. Un KDS que se vacia cuando la red se cae es peor que uno que
 * nunca se actualiza, porque el que esta en cocina deja de mirar la pantalla y va a
 * preguntar "¿que falta?" — y la respuesta honesta es "faltan cosas que si sabemos, pero
 * no te las podemos mostrar".
 *
 * Por eso no hay ningun `db.kitchenTickets.clear()` en este archivo, ni debe haberlo.
 *
 * ## Como esta conectado
 *
 * Socket.IO contra `/ws/kds` con el access token en el handshake. El canal es
 * `venue:{venueId}:kds`, y el servidor lo **verifica**: si el `venueId` del canal no es
 * el del token, la suscripcion se rechaza. Ver el ADR-0006 y `kds.gateway.ts`.
 *
 * La reconexion la maneja Socket.IO con backoff exponencial, y por eso el modulo no
 * reintenta a mano: dos reintentos sobre el mismo socket son dos timers compitiendo por
 * la misma conexion, y el sintoma es un POS que se reconecta dos veces por cada corte.
 */

/** Un cambio de estado de un ticket de cocina, tal como lo manda el socket. */
export interface KdsStatusEvent {
  ticketId: string;
  stationId: string;
  status: 'NEW' | 'PREPARING' | 'READY' | 'SERVED';
  receivedAt: string;
}

/** Estado de la conexion en vivo, para que la pantalla pueda decirlo. */
export type RealtimeStatus = 'disponible' | 'conectado' | 'desconectado';

/** Lo que la pantalla necesita saber del socket. */
export interface RealtimeHandlers {
  /**
   * Hay que releer el KDS.
   *
   * Se pasa el evento para que la pantalla pueda decidir si le importa (por ejemplo,
   * ignorar un `SERVED` si ya no lo muestra). Lo que **no** se puede es usarlo para
   * escribir el estado: el estado vive en la replica.
   */
  onKdsEvent?: (event: KdsStatusEvent) => void;
  /** Cambia el estado de la conexion. Para pintar "en vivo" o "sincroniza cada 5 s". */
  onStatus?: (status: RealtimeStatus) => void;
  /** Para tests: donde se resuelve el socket. */
  socketFactory?: (url: string, options: SocketOptions) => RealtimeSocket;
}

/**
 * Lo que se le pasa al socket.
 *
 * Es una forma propia y no el tipo de socket.io a proposito: el POS (y el test) no
 * dependen de la API de la libreria. Cambiar de version de socket.io no obliga a tocar
 * este archivo, y `socketFactory` puede devolver un doble sin construir un `io` de
 * verdad.
 */
export interface SocketOptions {
  path: string;
  auth: { token: string };
  transports: ('websocket' | 'polling')[];
  reconnection: boolean;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
  reconnectionAttempts: number;
}

/** Lo minimo del socket que usa este modulo. */
export interface RealtimeSocket {
  on(event: string, listener: (...args: never[]) => void): unknown;
  emit(event: string, payload?: unknown, ack?: (response: never) => void): unknown;
  removeAllListeners(): unknown;
  disconnect(): unknown;
}

/** Lo que devuelve `connectRealtime`. */
export interface RealtimeConnection {
  /** Cierra el socket. Idempotente. */
  close: () => void;
  /** Como va la conexion, sin pasar por el callback. Para tests y para el render. */
  status: () => RealtimeStatus;
}

/**
 * La URL del gateway.
 *
 * Sale de `VITE_API_URL` sin la parte de `/api/v1`: el prefijo global de Nest aplica a
 * las rutas HTTP y **no** a los sockets, que resuelven su path en el handshake. Por eso
 * el POS conecta a `/ws/kds` y no a `/api/v1/ws/kds`.
 */
function gatewayUrl(): string {
  const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
  // `/api/v1` al final es lo que el prefijo global agrega; se quita para que el path
  // del socket sea relativo a la raiz.
  return apiUrl.replace(/\/api\/v1\/?$/, '');
}

const KDS_PATH = '/ws/kds';

/**
 * Abre la suscripcion en vivo.
 *
 * Devuelve `null` sin sesion o sin token. Es un valor legitimo y no un error: antes del
 * login por PIN no hay nada a lo que suscribirse, y la cocina funciona igual con el
 * ciclo de sincronizacion de tanto en tanto.
 */
export function connectRealtime(params: {
  venueId: string | null;
  handlers?: RealtimeHandlers;
}): RealtimeConnection | null {
  const token = getAccessToken();
  if (!token || !params.venueId) return null;

  const socketOptions: SocketOptions = {
    path: KDS_PATH,
    auth: { token },
    transports: ['websocket', 'polling'],
    // Backoff exponencial: 500 ms, 1 s, 2 s, 4 s, hasta 10 s. El tope importa porque
    // en un local con el router intermitente, reconectar cada 500 ms durante una hora es
    // una bateria agotada y una impresora que no sale.
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
    // Sin tope: el POS queda abierto ocho horas, y reconectar para siempre es lo
    // correcto. El ciclo de sincronizacion de 20 s cubre mientras tanto.
    reconnectionAttempts: Infinity,
  };

  let status: RealtimeStatus = 'desconectado';
  const setStatus = (next: RealtimeStatus): void => {
    status = next;
    // El global se actualiza siempre, aunque nadie pase `onStatus`: la pantalla lo lee
    // en el render con `realtimeStatus()` y no depende de un handler.
    setGlobalStatus(next);
    params.handlers?.onStatus?.(next);
  };

  const factory =
    params.handlers?.socketFactory ??
    ((url: string, options: SocketOptions) =>
      io(url, options as never) as unknown as RealtimeSocket);

  const socket = factory(gatewayUrl(), socketOptions);

  socket.on('connect', () => {
    setStatus('conectado');
    // Suscribirse **despues** de conectar, no en el constructor: antes no hay socket del
    // que ser parte de la sala.
    //
    // El resultado llega por el **ack**, no por un evento. Sin el, el servidor responde
    // y el POS se queda sin saber si entro: se creeria en vivo con una sala a la que
    // nunca se sumo, y eso es la peor falla posible en un KDS (pantalla "en vivo" que
    // no muestra nada).
    socket.emit('subscribe', { channel: `venue:${params.venueId}:kds` }, (ack: unknown) => {
      if (!isSubscribeError(ack)) return;
      // Token vencido, local distinto o permiso: el POS sigue con el ciclo de
      // sincronizacion. Solo baja el estado, que es lo que la pantalla muestra.
      console.warn(
        `No se pudo suscribir al KDS de ${params.venueId}: ${subscribeErrorDetail(ack)}`,
      );
      setStatus('desconectado');
    });
  });

  socket.on('disconnect', () => {
    // No se limpia nada de la replica. Ver la nota de la clase: el KDS tiene que
    // seguir mostrando lo ultimo conocido.
    setStatus('desconectado');
  });

  socket.on('connect_error', () => {
    setStatus('desconectado');
  });

  // Un ticket cambio en la cocina: se avisa para que la pantalla relea la replica. El
  // socket **no** trae el ticket entero a proposito; el gateway emite el `ticketId` y el
  // POS va a su propia replica, que es la misma que lee el resto de la app.
  socket.on('kds:ticket', (payload: unknown) => {
    const event = toStatusEvent(payload);
    if (event) params.handlers?.onKdsEvent?.(event);
  });

  return {
    close: () => {
      // `removeAllListeners` antes de `disconnect`: sin esto, un `close` durante un
      // reconexion en vuelo deja el handler de `disconnect` vivo y el estado del POS
      // queda en "conectado" con el socket cerrado.
      socket.removeAllListeners();
      socket.disconnect();
      setStatus('desconectado');
    },
    status: () => status,
  };
}

/**
 * El servidor responde a `subscribe` con el canal, o con `{ error: ProblemDetails }`.
 *
 * La forma se mira con `in` y no comparando contra algo: el `error` viaja como problem+json
 * y sus campos (`status`, `code`) son los que hacen que la UI pueda distinguir "tu sesion
 * vencio" de "ese canal es de otro local".
 */
function isSubscribeError(ack: unknown): boolean {
  return typeof ack === 'object' && ack !== null && 'error' in ack;
}

/** El `detail` del problem+json, o un texto generico si la forma no se reconoce. */
function subscribeErrorDetail(ack: unknown): string {
  const error = (ack as { error?: { detail?: unknown } }).error;
  return typeof error?.detail === 'string' ? error.detail : 'el servidor no lo dijo';
}

/**
 * Normaliza lo que llega del socket a `KdsStatusEvent`.
 *
 * El socket es la red: lo que llega puede faltar o ser de otro tipo, y un `undefined`
 * en `stationId` termina en una exception del lado de la pantalla, no en "no hay
 * evento". Un `null` es un valor legitimo y no un error.
 */
function toStatusEvent(payload: unknown): KdsStatusEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const ticket = (payload as { ticket?: unknown }).ticket;
  if (!ticket || typeof ticket !== 'object') return null;

  const record = ticket as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.stationId !== 'string') return null;
  if (typeof record.status !== 'string') return null;

  return {
    ticketId: record.id,
    stationId: record.stationId,
    status: record.status as KdsStatusEvent['status'],
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Estado de la ultima conexion abierta en este modulo.
 *
 * Vive aca y no en `Kitchen.tsx` porque la pantalla lo consulta en el render
 * (`realtimeStatus()`) y no puede tener un `useState` para algo que el socket ya sabe.
 * Es una variable de modulo a proposito: hay **una** conexion por POS, y duplicarla por
 * pantalla es el bug que el comentario original de este archivo describia (un WebSocket
 * que se abre tres veces cuando la pantalla se remonta).
 */
let lastStatus: RealtimeStatus = 'desconectado';

/**
 * Como va la conexion en vivo, para mostrarla en la pantalla de cocina.
 *
 * Devuelve `desconectado` cuando no hay conexion: es el estado honesto. Decir
 * "disponible" sin estar conectado hace pensar que la pantalla esta al dia cuando en
 * realidad esta mostrando lo de hace medio minuto.
 */
export function realtimeStatus(): RealtimeStatus {
  return lastStatus;
}

/** Pone el estado global. Lo llama `connectRealtime`. */
function setGlobalStatus(next: RealtimeStatus): void {
  lastStatus = next;
}
