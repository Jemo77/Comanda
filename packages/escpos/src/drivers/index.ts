/**
 * Drivers de impresion.
 *
 * Todos implementan `PrinterDriver`: reciben bytes y los escriben donde sea. Ninguno
 * sabe que es un ticket.
 *
 * Elegir uno es problema del **llamador**, no de este paquete: `stations.printer_target`
 * es un string arbitrario y el runtime decide. En el POS (navegador) va
 * `BrowserUsbDriver` o `ConsoleDriver`; en la API (Node) va `TcpDriver`.
 */

export type { PrinterDriver, PrinterTarget } from './printer-driver';
export { parseTcpTarget } from './printer-driver';
export {
  ConsoleDriver,
  formatEscPos,
  type ConsoleDriverOptions,
  type ByteSink,
} from './console-driver';
export { TcpDriver, type TcpDriverOptions, type SocketLike, type ConnectLike } from './tcp-driver';
export {
  BrowserUsbDriver,
  isWebUsbAvailable,
  COMMON_PRINTER_VENDORS,
  type BrowserUsbDriverOptions,
  type UsbLike,
  type UsbDeviceLike,
  type UsbEndpointLike,
} from './browser-usb-driver';
