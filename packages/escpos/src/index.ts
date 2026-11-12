/**
 * ESC/POS: generar el ticket y escribirlo en una impresora.
 *
 * El paquete tiene tres capas y cada una se puede testear sola:
 *
 *  1. `commands.ts` · los bytes del protocolo. Sin contexto de negocio.
 *  2. `text.ts` · texto a bytes en la pagina de codigos que la impresora entiende.
 *  3. `ticket.ts` · el ticket de cocina y el comprobante, armados con lo de arriba.
 *
 * Y los drivers (`./drivers`) son el unico lugar que toca hardware.
 *
 * ## Que no hace este paquete
 *
 * **No elige la impresora.** `stations.printer_target` dice a donde va cada ticket y
 * el driver lo resuelve: una IP, un puerto USB, un spooler. Esa separacion es la regla
 * 6 del plan (adaptadores para todo lo externo) aplicada a la impresion: agregar un
 * driver nuevo (Bluetooth, PrintBridge, una cola en la nube) es agregar un archivo, no
 * tocar el generador.
 *
 * ## Reutiliza `@comanda/domain`
 *
 * Los totales del comprobante salen de `orderTotals()` y el formato de `formatMoney()`.
 * No se reimplementan: el POS calcula el total sobre su replica con la misma funcion
 * pura, y si el ticket imprimiera su propia aritmetica un redondeo distinto entre
 * pantalla y papel es un reclamo en el mostrador.
 */

export * from './commands';
export * from './text';
export * from './ticket';
export type { PrinterDriver } from './drivers/printer-driver';
export { ConsoleDriver } from './drivers/console-driver';
export { TcpDriver } from './drivers/tcp-driver';
export { BrowserUsbDriver, isWebUsbAvailable } from './drivers/browser-usb-driver';
