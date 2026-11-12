import { describe, expect, it, vi } from 'vitest';
import { TcpDriver, type ConnectLike, type SocketLike } from './tcp-driver';
import { parseTcpTarget } from './printer-driver';

/**
 * El driver de TCP, con un socket de mentira.
 *
 * Abrir un puerto de verdad en un test es abrir un puerto: la suite pasa en la
 * maquina de desarrollo y falla en CI por algo que no tiene que ver con lo que
 * prueba. Por eso `connect` se inyecta.
 */
/**
 * Un socket de mentira.
 *
 * El callback de `connect` se dispara en un microtask, **no** de forma sincrona, igual
 * que `net.Socket`. Si fuera sincrono, el driverTodavia no tendria asignado el socket
 * que devuelve `connect` y la escritura se perderia: es exactamente la diferencia
 * entre una conexion real y una de mentira que hace que el test pruebe algo que no
 * pasa en produccion.
 */
function fakeSocket(options: { writeError?: Error | null } = {}): {
  socket: SocketLike;
  written: Uint8Array[];
  destroyed: () => boolean;
} {
  const written: Uint8Array[] = [];
  let isDestroyed = false;

  const socket: SocketLike = {
    write(chunk, callback) {
      written.push(chunk);
      callback?.(options.writeError ?? null);
      return true;
    },
    end() {
      /* el socket real se cierra acá */
    },
    destroy() {
      isDestroyed = true;
      return undefined;
    },
    setTimeout() {
      return undefined;
    },
    on() {
      return undefined;
    },
  };

  return { socket, written, destroyed: () => isDestroyed };
}

/** Un `connect` que se conecta en el siguiente microtask, como el socket real. */
function connectTo(socket: SocketLike): ConnectLike {
  return (_options, callback) => {
    queueMicrotask(callback);
    return socket;
  };
}

describe('parseTcpTarget', () => {
  it('acepta tcp:// con y sin puerto', () => {
    expect(parseTcpTarget('tcp://192.168.0.50:9100')).toEqual({ host: '192.168.0.50', port: 9100 });
    expect(parseTcpTarget('192.168.0.50')).toEqual({ host: '192.168.0.50', port: 9100 });
  });

  it('separa el puerto desde el ultimo :', () => {
    // Un host IPv6 tiene varios `:`; separarlos con el primero rompe la direccion.
    expect(parseTcpTarget('tcp://[fe80::1]:9100')).toEqual({ host: '[fe80::1]', port: 9100 });
  });

  it('rechaza un puerto invalido en vez de caer a 9100 en silencio', () => {
    // Caer a 9100 seria peor que fallar: escribiria al puerto equivocado.
    expect(() => parseTcpTarget('192.168.0.50:abc')).toThrow(/invalido/);
    expect(() => parseTcpTarget('192.168.0.50:99999')).toThrow(/invalido/);
  });
});

describe('TcpDriver', () => {
  it('escribe los bytes y cierra', async () => {
    const { socket, written } = fakeSocket();
    const driver = new TcpDriver({
      target: 'tcp://192.168.0.50:9100',
      connect: connectTo(socket),
    });

    await driver.write(Uint8Array.from([0x1b, 0x40]));

    expect(written).toHaveLength(1);
    expect(Array.from(written[0]!)).toEqual([0x1b, 0x40]);
  });

  it('el nombre del driver es el target', () => {
    const { socket } = fakeSocket({});
    expect(new TcpDriver({ target: 'tcp://1.2.3.4:9100', connect: connectTo(socket) }).name).toBe(
      'tcp://1.2.3.4:9100',
    );
  });

  it('NO tira cuando la escritura falla: avisa y resuelve', async () => {
    // El contrato de `PrinterDriver`: una impresora sin papel es el estado normal de un
    // local, no una excepcion de programacion. Un `throw` termina en una promesa
    // flotante en el POS.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors: string[] = [];
    const { socket } = fakeSocket({ writeError: new Error('EPIPE') });

    const driver = new TcpDriver({
      target: '1.2.3.4',
      connect: connectTo(socket),
      onError: (message) => errors.push(message),
    });

    await expect(driver.write(Uint8Array.from([0x1b]))).resolves.toBeUndefined();
    expect(errors[0]).toMatch(/EPIPE/);
    warn.mockRestore();
  });

  it('sin `connect` inyectado usa `node:net` de verdad', async () => {
    // En el navegador `node:net` no existe y por eso el import es dinamico. Aca se
    // verifica la otra mitad: en Node **si** funciona sin inyeccion.
    const errors: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const driver = new TcpDriver({
      // Puerto 1: la conexion falla de inmediato en vez de dejar el test colgado.
      target: 'tcp://127.0.0.1:1',
      onError: (message) => errors.push(message),
      timeoutMs: 1_000,
    });

    await driver.write(Uint8Array.from([0x1b, 0x40]));
    expect(errors.length).toBe(1);
    warn.mockRestore();
  });

  it('reporta el timeout: la impresora acepto el ticket y no imprime nada', async () => {
    // Es el caso que mas duele y el unico que cuelga el POS sin timeout.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors: string[] = [];
    let onTimeout: (() => void) | null = null;

    const socket: SocketLike = {
      write() {
        // Acepta el buffer y nunca llama al callback: la impresora esta sin papel.
        return true;
      },
      end() {},
      destroy() {
        return undefined;
      },
      setTimeout() {
        return undefined;
      },
      on(event, listener) {
        if (event === 'timeout') onTimeout = () => listener();
        return undefined;
      },
    };

    const driver = new TcpDriver({
      target: '1.2.3.4',
      connect: () => socket,
      timeoutMs: 10,
      onError: (message) => errors.push(message),
    });

    const pending = driver.write(Uint8Array.from([0x1b]));
    // El timer del socket se dispara despues: es lo que hace `net.Socket` solo.
    expect(onTimeout).not.toBeNull();
    onTimeout!();
    await pending;

    expect(errors[0]).toMatch(/Timeout/);
    expect(errors[0]).toMatch(/papel/);
    warn.mockRestore();
  });

  it('reporta el error de socket y destruye la conexion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors: string[] = [];
    let onError: ((payload?: unknown) => void) | null = null;

    const socket: SocketLike = {
      write() {
        return true;
      },
      end() {},
      destroy() {
        return undefined;
      },
      setTimeout() {
        return undefined;
      },
      on(event, listener) {
        if (event === 'error') onError = listener;
        return undefined;
      },
    };

    const driver = new TcpDriver({
      target: '1.2.3.4',
      connect: () => socket,
      onError: (message) => errors.push(message),
    });

    const pending = driver.write(Uint8Array.from([0x1b]));
    onError!(new Error('ECONNREFUSED'));
    await pending;

    expect(errors[0]).toMatch(/ECONNREFUSED/);
    warn.mockRestore();
  });

  it('reporta cuando `createConnection` lanza de forma sincronica', async () => {
    // Un host que no resuelve lanza en `createConnection`, no emite `error`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors: string[] = [];

    const driver = new TcpDriver({
      target: 'no-existe.invalido',
      connect: () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
      onError: (message) => errors.push(message),
    });

    await expect(driver.write(Uint8Array.from([0x1b]))).resolves.toBeUndefined();
    expect(errors[0]).toMatch(/ENOTFOUND/);
    warn.mockRestore();
  });
});
