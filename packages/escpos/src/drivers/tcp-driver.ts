import type { PrinterDriver, PrinterTarget } from './printer-driver';
import { parseTcpTarget } from './printer-driver';

/**
 * Impresora de red, por socket TCP crudo.
 *
 * ## Por que este es el driver de produccion
 *
 * Una impresora termica de 80 mm de barra o de cocina casi siempre esta en la red
 * local, con una IP fija, y habla **impresion cruda** en el puerto 9100: se abre un
 * socket, se escriben los bytes y se cierra. No hay protocolo, no hay handshake, no hay
 * acuse de recibo. Esa simplicidad es la que lo hace el destino por defecto cuando
 * `stations.printer_target` es una IP.
 *
 * ## Por que el socket se abre y se cierra en cada `write`
 *
 * Podria keeping-alive. No se hace a proposito: una impresora apagada hace que un
 * socket abierto quede colgado sin error visible (el `write` "tiene exito" porque el
 * sistema operativo metio los bytes en su buffer), y el ticket se pierde en silencio.
 * Abriendo por escrito, el fallo aparece en el momento del envio y el POS puede avisar.
 *
 * ## El timeout no es negociable
 *
 * Una impresora sin papel acepta el socket, acepta los bytes y no imprime nada. Sin
 * timeout, el `write` cuelga para siempre y el POS deja de procesar. Con el, el ticket
 * se pierde (que es preferible: se reimprime) y la app sigue.
 */
export interface TcpDriverOptions {
  /** `host:puerto` o `tcp://host:puerto`. Sin puerto, 9100. */
  target: PrinterTarget;
  /** Identificador para los logs. Por defecto, el target. */
  name?: string;
  /** Milisegundos para conectar y para escribir. Por defecto 5 s. */
  timeoutMs?: number;
  /**
   * `net.createConnection`, inyectado para tests.
   *
   * Es la misma razon que en `HttpSyncTransport`: abrir un socket de verdad en un test
   * es abrir un puerto, y una suite que abre puertos es una suite que falla en CI por
   * algo que no tiene que ver con lo que prueba.
   *
   * Si no se pasa, se resuelve `node:net` **dentro** de `write` (ver `realConnect`):
   * el paquete se importa en el navegador para usar WebUSB, y `node:net` no existe
   * ahi.
   */
  connect?: ConnectLike;
  /** Se llama cuando una escritura falla, para que la UI pueda avisar. */
  onError?: (message: string) => void;
}

/**
 * La forma minima de un socket que este driver necesita.
 *
 * Se declara aca y no se importa de `node:net` para que el archivo sea legible sin
 * conocer la API de Node, y para que el test pueda pasar un doble con cuatro metodos.
 */
export interface SocketLike {
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
  end(): void;
  destroy(error?: Error): unknown;
  setTimeout(ms: number): unknown;
  on(event: 'error' | 'timeout' | 'connect', listener: (payload?: unknown) => void): unknown;
}

export type ConnectLike = (
  options: { host: string; port: number },
  callback: () => void,
) => SocketLike;

export class TcpDriver implements PrinterDriver {
  readonly name: string;

  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly connect?: ConnectLike;
  private readonly onError?: (message: string) => void;

  constructor(options: TcpDriverOptions) {
    const { host, port } = parseTcpTarget(options.target);
    this.host = host;
    this.port = port;
    this.name = options.name ?? options.target;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (options.connect) this.connect = options.connect;
    if (options.onError) this.onError = options.onError;
  }

  /**
   * Escribe el ticket y cierra.
   *
   * No tira. Ver el contrato de `PrinterDriver`: una impresora sin papel es el estado
   * normal de un local, no una excepcion de programacion. Lo que no se puede es perder
   * el error en silencio, asi que se avisa por `onError` y por el logger.
   */
  async write(bytes: Uint8Array): Promise<void> {
    const connect = this.connect ?? (await realConnect());
    if (!connect) {
      this.fail(
        `No hay forma de abrir un socket en este runtime (${describeRuntime()}). ` +
          'En el navegador se usa `BrowserUsbDriver`.',
      );
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (message?: string): void => {
        if (settled) return;
        settled = true;
        if (message) this.fail(message);
        resolve();
      };

      let socket: SocketLike;
      try {
        socket = connect({ host: this.host, port: this.port }, () => {
          socket.write(bytes, (error) => {
            socket.end();
            done(error ? `No se pudo escribir en ${this.name}: ${error.message}` : undefined);
          });
        });
      } catch (error) {
        // `createConnection` lanza de forma sincronica si el host no resuelve o si no
        // hay permiso para el puerto.
        done(`No se pudo conectar a ${this.name}: ${describe(error)}`);
        return;
      }

      socket.setTimeout(this.timeoutMs);

      socket.on('error', (payload) => {
        const error = payload instanceof Error ? payload : new Error(String(payload));
        socket.destroy();
        done(`Error de socket en ${this.name}: ${error.message}`);
      });

      // `setTimeout` no lanza: emite `timeout`. Es el caso que mas duele, porque la
      // impresora acepto la conexion y el ticket y no imprime nada (sin papel, sin
      // tinta, cajon trabado). Sin esto el POS queda esperando para siempre.
      socket.on('timeout', () => {
        socket.destroy();
        done(`Timeout escribiendo en ${this.name} (${this.timeoutMs} ms). Revisa que tenga papel.`);
      });
    });
  }

  private fail(message: string): void {
    // `console.warn` y no el logger de Nest: este paquete corre tambien en el
    // navegador, donde `@nestjs/common` no existe y el import lo rompe el bundle.
    console.warn(message);
    this.onError?.(message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeRuntime(): string {
  return typeof process !== 'undefined' && process.versions?.node ? 'Node' : 'el navegador';
}

/**
 * `node:net` resuelto perezoso.
 *
 * El import es dinamico y vive dentro de `write`, no en el tope del archivo: el POS
 * importa este paquete entero para usar WebUSB, y un `import ... from 'node:net'` en
 * el tope hace fallar el bundle del navegador por un driver que ahi no se usa.
 */
async function realConnect(): Promise<ConnectLike | null> {
  try {
    const net = (await import('node:net')) as NetModule;
    return ((options, callback) =>
      net.createConnection(options, callback) as unknown as SocketLike) as ConnectLike;
  } catch {
    return null;
  }
}

/**
 * La forma de `node:net` que se usa.
 *
 * Se declara aca y no con `typeof import('node:net')` inline porque la regla
 * `consistent-type-imports` prohibe la anotacion inline. Es la unica mencion a
 * `node:net` en un import del archivo: el valor se resuelve adentro de `realConnect`.
 */
interface NetModule {
  createConnection(options: { host: string; port: number }, callback: () => void): unknown;
}
