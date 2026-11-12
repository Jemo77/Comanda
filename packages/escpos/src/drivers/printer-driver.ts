/**
 * El contrato de una impresora.
 *
 * ## Por que `write(bytes)` y no "imprimir un ticket"
 *
 * El driver **no sabe que es un ticket**. Recibe bytes ya armados y los escribe donde
 * sea. Es lo que hace que:
 *
 *  - el generador de tickets se pueda probar entero sin impresora (comparando bytes),
 *  - un error de la impresora no pueda cambiar lo que el ticket dice,
 *  - agregar un driver sea agregar un archivo y no tocar el generador.
 *
 * Si el driver recibiera un `KitchenTicket`, cada driver tendria que decidir el formato
 * y habria cuatro formatos distintos para cuatro impresoras.
 *
 * ## `write` no tira
 *
 * Una impresora sin papel, un cable desenchufado o un socket caido son el estado normal
 * de un local, no una excepcion de programacion. La implementacion **loguea y
 * resuelve**: la interfaz es "escribi estos bytes", y un ticket perdido se vuelve a
 * imprimir. Un `throw` en un driver termina en un error no manejado en el POS, y en el
 * mostrador eso es una pantalla en blanco.
 */
export interface PrinterDriver {
  /** Nombre del destino. Aparece en los logs y en el error de la UI. */
  readonly name: string;

  /**
   * Escribe bytes crudos en la impresora.
   *
   * Resuelve cuando los bytes salieron. No tira: si no se pudo escribir, loguea.
   */
  write(bytes: Uint8Array): Promise<void>;

  /**
   * Cierra el destino.
   *
   * Opcional porque no todos los destinos tienen algo que cerrar (la consola no, el
   * USB del navegador tampoco). Va en la interfaz igual: el que llama tiene que poder
   * cerrar sin preguntar de que tipo es.
   */
  close?(): Promise<void>;
}

/**
 * El destino de impresion de una estacion.
 *
 * Es el contrato de `stations.printer_target`, que en la base es un `varchar(120)`
 * arbitrario a proposito: la base no conoce impresoras. Este tipo es donde se decide
 * que forma tiene ese string.
 *
 * `tcp://192.168.0.50:9100` es el caso real de una impresora de red, que es como son
 * casi todas las de 80 mm que se instalan en un bar. El `9100` es el puerto de
 * impresion cruda por defecto y no se negocia con la impresora: es un socket que
 * escribe y se olvida.
 */
export type PrinterTarget = string;

/** Parsea `tcp://host:puerto` (o `host:puerto`) y devuelve host y puerto. */
export function parseTcpTarget(target: PrinterTarget): { host: string; port: number } {
  const cleaned = target.replace(/^tcp:\/\//i, '').trim();
  // El ultimo `:` separa el puerto: un host IPv6 tiene varios y separarlos con el
  // primero rompe la direccion.
  const separator = cleaned.lastIndexOf(':');
  if (separator === -1) return { host: cleaned, port: 9100 };

  const host = cleaned.slice(0, separator);
  const port = Number(cleaned.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Destino de impresion invalido: "${target}"`);
  }
  return { host, port };
}
