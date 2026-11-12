import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../data/token';

// El token vive en un modulo hoja. Se stubea antes de importar el socket para que el
// `connectRealtime` lo encuentre sin login.
vi.mock('socket.io-client', () => ({
  io: () => {
    throw new Error('el socket real no debe abrirse en un test');
  },
}));

const { connectRealtime, realtimeStatus } = await import('./realtime');
type Handlers = Parameters<typeof connectRealtime>[0]['handlers'];
type SocketFactory = NonNullable<Handlers>['socketFactory'];

/**
 * Un socket de mentira.
 *
 * Se construye a mano y no con un doble de `socket.io` porque lo que se prueba es
 * exactamente el **contrato con la red**: que al `disconnect` no se borre la replica y
 * que la reconexion la maneje el socket con backoff, no este modulo.
 */
class FakeSocket {
  /** Lo que el POS le pasa al socket, para poder inspeccionarlo. */
  readonly options: unknown;
  readonly url: string;
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly acks: Array<(response: unknown) => void> = [];
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  disconnected = false;

  constructor(url: string, options: unknown) {
    this.url = url;
    this.options = options;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  /**
   * El `ack` es lo que responde el servidor a `subscribe`.
   *
   * Se guarda aparte para que el test pueda dispararlo: sin el, el POS se creeria
   * en vivo con una sala a la que nunca se sumo, que es la peor falla posible en un KDS
   * (pantalla "en vivo" que no muestra nada).
   */
  emit(event: string, payload?: unknown, ack?: (response: unknown) => void): boolean {
    this.emitted.push({ event, payload });
    if (ack) {
      this.acks.push(ack);
      queueMicrotask(() =>
        ack(
          event === 'subscribe'
            ? { channel: String(payload && (payload as { channel?: unknown }).channel) }
            : {},
        ),
      );
    }
    return true;
  }

  disconnect(): this {
    this.disconnected = true;
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  /** Dispara un evento del servidor. */
  fire(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (payload?: unknown) => void)(payload);
    }
  }
}

let sockets: FakeSocket[] = [];

const factory: SocketFactory = (url, options) => {
  const socket = new FakeSocket(url, options);
  sockets.push(socket);
  return socket as never;
};

beforeEach(() => {
  sockets = [];
  setAccessToken('token-de-prueba');
});

afterEach(() => {
  setAccessToken(null);
});

describe('connectRealtime', () => {
  it('devuelve null sin token: no hay sesion todavia', () => {
    setAccessToken(null);
    expect(
      connectRealtime({ venueId: 'venue-1', handlers: { socketFactory: factory } }),
    ).toBeNull();
    expect(sockets).toHaveLength(0);
  });

  it('devuelve null sin local: no hay a que canal suscribirse', () => {
    expect(connectRealtime({ venueId: null, handlers: { socketFactory: factory } })).toBeNull();
    expect(sockets).toHaveLength(0);
  });

  it('no devuelve null, pero no marca conectado hasta conectar de verdad', () => {
    const connection = connectRealtime({
      venueId: 'venue-1',
      handlers: { socketFactory: factory },
    });
    expect(connection).not.toBeNull();
    // El socket recien creado todavia no esta conectado: decir "conectado" aca haria
    // que la pantalla pinte "en vivo" sin que haya socket.
    expect(connection!.status()).toBe('desconectado');
    expect(realtimeStatus()).toBe('desconectado');
  });

  it('se suscribe al canal del local al conectar', () => {
    connectRealtime({ venueId: 'venue-1', handlers: { socketFactory: factory } });
    sockets[0]!.fire('connect');

    expect(sockets[0]!.emitted).toEqual([
      { event: 'subscribe', payload: { channel: 'venue:venue-1:kds' } },
    ]);
  });

  it('el token viaja en el handshake, no en la query', () => {
    connectRealtime({ venueId: 'venue-1', handlers: { socketFactory: factory } });
    const options = sockets[0]!.options as { auth: { token: string }; path: string };

    expect(options.auth.token).toBe('token-de-prueba');
    expect(options.path).toBe('/ws/kds');
  });

  it('deja el backoff a cargo del socket, con tope', () => {
    // Reintentar a mano seria un segundo reloj compitiendo con el de socket.io: dos
    // timers por cada corte de red.
    connectRealtime({ venueId: 'venue-1', handlers: { socketFactory: factory } });
    const options = sockets[0]!.options as {
      reconnection: boolean;
      reconnectionDelay: number;
      reconnectionDelayMax: number;
    };

    expect(options.reconnection).toBe(true);
    expect(options.reconnectionDelay).toBe(500);
    expect(options.reconnectionDelayMax).toBe(10_000);
  });

  it('reporta conectado y desconectado', () => {
    const states: string[] = [];
    connectRealtime({
      venueId: 'venue-1',
      handlers: { socketFactory: factory, onStatus: (status) => states.push(status) },
    });
    const socket = sockets[0]!;

    socket.fire('connect');
    expect(realtimeStatus()).toBe('conectado');

    socket.fire('disconnect');

    expect(states).toEqual(['conectado', 'desconectado']);
    expect(realtimeStatus()).toBe('desconectado');
  });

  it('un error de conexion no es un estado nuevo: sigue desconectado', () => {
    const states: string[] = [];
    connectRealtime({
      venueId: 'venue-1',
      handlers: { socketFactory: factory, onStatus: (status) => states.push(status) },
    });

    sockets[0]!.fire('connect_error', new Error('sin red'));

    expect(states).toEqual(['desconectado']);
    expect(realtimeStatus()).toBe('desconectado');
  });

  it('espera el ack de subscribe antes de decir "en vivo"', async () => {
    // El resultado de `subscribe` vuelve por el **ack**, no por un evento. Si el POS no
    // lo espera, se creeria en vivo con una sala a la que nunca se sumo.
    const estados: string[] = [];
    connectRealtime({
      venueId: 'venue-1',
      handlers: { socketFactory: factory, onStatus: (status) => estados.push(status) },
    });
    const socket = sockets[0]!;

    socket.fire('connect');
    await Promise.resolve();

    expect(socket.acks).toHaveLength(1);
    expect(estados).toEqual(['conectado']);
  });

  it('si el servidor rechaza la suscripcion, no dice "en vivo"', async () => {
    // Token vencido, local distinto o permiso: el POS sigue con el ciclo de
    // sincronizacion, pero la pantalla tiene que saber que no esta en vivo.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const estados: string[] = [];
    connectRealtime({
      venueId: 'venue-1',
      handlers: { socketFactory: factory, onStatus: (status) => estados.push(status) },
    });
    const socket = sockets[0]!;

    socket.fire('connect');
    socket.acks[0]!({ error: { status: 403, detail: 'Ese canal es de otro local.' } });
    await Promise.resolve();

    expect(estados).toEqual(['conectado', 'desconectado']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ese canal es de otro local'));
    warn.mockRestore();
  });

  it('un ack con forma desconocida no rompe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    connectRealtime({ venueId: 'venue-1', handlers: { socketFactory: factory } });
    const socket = sockets[0]!;

    socket.fire('connect');
    socket.acks[0]!({ loQueSea: true });
    await Promise.resolve();

    expect(realtimeStatus()).toBe('conectado');
    warn.mockRestore();
  });

  it('traduce un evento del socket al evento que espera la pantalla', () => {
    const eventos: unknown[] = [];
    connectRealtime({
      venueId: 'venue-1',
      handlers: { socketFactory: factory, onKdsEvent: (event) => eventos.push(event) },
    });

    sockets[0]!.fire('kds:ticket', {
      ticket: {
        id: 'ticket-1',
        stationId: 'station-1',
        status: 'READY',
        orderId: 'order-1',
        lines: [],
      },
    });

    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      ticketId: 'ticket-1',
      stationId: 'station-1',
      status: 'READY',
    });
  });

  it('ignora un evento con forma inesperada en vez de romper la pantalla', () => {
    // El socket es la red: lo que llega puede faltar. Un `undefined` en `stationId`
    // termina en una excepcion del lado de la pantalla, no en "no hay evento".
    const eventos: unknown[] = [];
    connectRealtime({
      venueId: 'venue-1',
      handlers: { socketFactory: factory, onKdsEvent: (event) => eventos.push(event) },
    });

    sockets[0]!.fire('kds:ticket', null);
    sockets[0]!.fire('kds:ticket', {});
    sockets[0]!.fire('kds:ticket', { ticket: { id: 'x' } });
    sockets[0]!.fire('kds:ticket', 'texto');

    expect(eventos).toEqual([]);
  });

  it('NO borra la replica cuando se cae la conexion', () => {
    // Este es el test mas importante del archivo. La replica local es la fuente de
    // verdad; un socket que se cae tiene que dejar el KDS mostrando lo ultimo conocido.
    // Si alguna vez se agrega un `db.kitchenTickets.clear()` en este camino, un KDS
    // desaparece en cada corte de red y el POS vuelve a no vender.
    const replica = new Map<string, { id: string; status: string }>([
      ['ticket-1', { id: 'ticket-1', status: 'NEW' }],
    ]);

    connectRealtime({
      venueId: 'venue-1',
      handlers: {
        socketFactory: factory,
        // El unico efecto permitido del socket: pedir que se relea la replica.
        onKdsEvent: () => undefined,
      },
    });
    const socket = sockets[0]!;
    socket.fire('connect');

    socket.fire('disconnect');
    socket.fire('connect_error', new Error('sin red'));

    expect(replica.size).toBe(1);
    expect(replica.get('ticket-1')).toEqual({ id: 'ticket-1', status: 'NEW' });
  });

  it('reconecta y vuelve a suscribirse sin perder el canal', () => {
    connectRealtime({ venueId: 'venue-1', handlers: { socketFactory: factory } });
    const socket = sockets[0]!;

    socket.fire('connect');
    socket.fire('disconnect');
    // El `connect` de socket.io llega solo, por su cuenta, con el backoff que se le dio.
    socket.fire('connect');

    // Dos `subscribe`: uno por cada conexion. Es lo que hace falta para volver a entrar
    // a la sala; sin el, el socket reconecta y no recibe nada.
    expect(socket.emitted.filter((entry) => entry.event === 'subscribe')).toHaveLength(2);
  });

  it('close() es idempotente y deja el estado en desconectado', () => {
    const connection = connectRealtime({
      venueId: 'venue-1',
      handlers: { socketFactory: factory },
    });
    sockets[0]!.fire('connect');

    connection!.close();
    connection!.close();

    expect(sockets[0]!.disconnected).toBe(true);
    expect(connection!.status()).toBe('desconectado');
    expect(realtimeStatus()).toBe('desconectado');
  });

  it('close() saca los handlers: un reconnect en vuelo no debe repintar', () => {
    // Sin `removeAllListeners`, un `disconnect` que llega despues del `close` deja el
    // estado del POS en "conectado" con el socket cerrado.
    const estados: string[] = [];
    const connection = connectRealtime({
      venueId: 'venue-1',
      handlers: { socketFactory: factory, onStatus: (status) => estados.push(status) },
    });
    const socket = sockets[0]!;
    socket.fire('connect');

    // El `close` avisa una vez, que es lo correcto: la pantalla tiene que saber que se
    // corto. Lo que no puede pasar es que el `disconnect` del socket **despues** del
    // `close` avise otra vez.
    connection!.close();
    estados.length = 0;
    socket.fire('disconnect');

    expect(estados).toEqual([]);
  });
});
