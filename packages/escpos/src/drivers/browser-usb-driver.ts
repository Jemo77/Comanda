import type { PrinterDriver } from './printer-driver';

/**
 * Impresora por WebUSB.
 *
 * ## Cuando
 *
 * Cuando la impresora esta conectada por USB al apparatus donde corre el POS (una
 * tablet, un mini-PC) y la red no es una opcion. Es el caso de un KDS propio, sin
 * servidor de impresion en medio.
 *
 * ## Por que el import es dinamico
 *
 * `navigator.usb` **no** existe en Node y la API de WebUSB no esta en los tipos de
 * TypeScript estandar (esta en `@types/wicg-webusb`). Declarar el import estatico
 * rompe el typecheck del paquete en Node, y declararlo tipado "a mano" obliga a
 * mantener una copia de la especificacion.
 *
 * La solucion es la de siempre en un paquete isomorfico: se tipa la **forma** minima
 * que se usa (`UsbDeviceLike`) y se resuelve el objeto real por `globalThis` en tiempo
 * de ejecucion. Sin imports estaticos de nada del navegador, el paquete se puede
 * importar desde Node (que es lo que hace la API, para el ticket de la caja) sin que
 * el modulo intento tocar `navigator`.
 *
 * ## Por que hay que abrir el dispositivo antes
 *
 * WebUSB no deja escribir en un dispositivo que no este abierto, y abrirlo pide
 * **permiso al usuario**: sin un gesto explicito, el navegador lo rechaza. Por eso
 * `open()` es un metodo aparte de `write()` y no se puede automatizar. Un POS que abre
 * el KDS sin pedir permiso tiene un ticket que se genera y no sale.
 */
export interface UsbDeviceLike {
  configuration?: { interfaces: Array<{ alternates: Array<{ endpoints: UsbEndpointLike[] }> }> };
  open(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  /** Los datos van como `ArrayBufferView` de buffer propio. */
  transferOut(endpointNumber: number, data: Uint8Array): Promise<unknown>;
  close(): Promise<void>;
  /** Los deja `getDevices()`; no hacen falta para escribir y no estan en todos los tipos. */
  vendorId?: number;
  productId?: number;
}

export interface UsbEndpointLike {
  endpointNumber: number;
  direction: 'in' | 'out';
}

/** La forma de `navigator.usb` que se usa. */
export interface UsbLike {
  requestDevice(options: {
    filters: Array<{ vendorId?: number; productId?: number }>;
  }): Promise<UsbDeviceLike>;
  getDevices(): Promise<UsbDeviceLike[]>;
}

export interface BrowserUsbDriverOptions {
  /** Identificador para los logs. */
  name?: string;
  /**
   * Filtro de dispositivos. Sin filtros, el navegador muestra **todos** los
   * dispositivos USB: el usuario tiene que adivinar cual es la impresora.
   *
   * Los vendorId de las termicas mas comunes (Epson 0x04B8, Star 0x0519, Bixolon
   * 0x1A2A, Gprinter 0x1DD2, Xprinter 0x0416, Sunmi 0x1AC4) se dejan en
   * `COMMON_PRINTER_VENDORS` para que un local no tenga que saber el id de su
   * impresora para que funcione.
   */
  vendorId?: number;
  productId?: number;
  /**
   * Numero de configuracion a seleccionar.
   *
   * Por defecto `1`, que es lo que casi toda impresora termica expone. Va
   * configurable porque hay modelos que solo exponen la `2`, y sin esto
   * `selectConfiguration` falla y el ticket no sale.
   */
  configurationValue?: number;
  /** Interfaz a reclamar. Por defecto, la primera con un endpoint de salida. */
  interfaceNumber?: number;
  /**
   * `navigator.usb`, inyectado para tests.
   *
   * En el navegador real no se pasa: se resuelve de `globalThis`. `null` dice
   * explicitamente "este runtime no lo tiene", que es distinto de "buscalo vos": asi
   * un test puede probar el mensaje de error sin hacer un mock de `navigator`.
   */
  usb?: UsbLike | null;
}

/** Vendor IDs de las impresoras termicas de 80 mm que se encuentran en un bar. */
export const COMMON_PRINTER_VENDORS: readonly number[] = [
  0x04b8, // Epson
  0x0519, // Star Micronics
  0x1a2a, // Bixolon
  0x1dd2, // Goojprt / Gprinter
  0x0416, // Xprinter
  0x1ac4, // Sunmi
  0x0dd4, // Custom
  0x0fe6, // ICS
];

/** Si el runtime tiene WebUSB. Se consulta antes de construir el driver. */
export function isWebUsbAvailable(usb: UsbLike | null = resolveUsb()): boolean {
  return usb !== null;
}

/**
 * Impresora USB desde el navegador.
 *
 * Se construye con `open()` explicito porque WebUSB exige un gesto del usuario para
 * conceder permiso: si `open` se llamara solo al imprimir, el navegador rechazaria la
 * peticion y el ticket se perderia sin explicacion.
 */
export class BrowserUsbDriver implements PrinterDriver {
  readonly name: string;

  private readonly usb: UsbLike;
  private readonly vendorId?: number;
  private readonly productId?: number;
  private readonly interfaceNumber?: number;
  private readonly configurationValue: number;

  private device: UsbDeviceLike | null = null;
  private endpoint: number | null = null;
  private opened = false;

  constructor(options: BrowserUsbDriverOptions = {}) {
    const usb = options.usb ?? resolveUsb();
    if (!usb) {
      throw new Error(
        'WebUSB no esta disponible en este runtime. En el navegador, Chrome o Edge; ' +
          'en Node, usa `TcpDriver`.',
      );
    }
    this.usb = usb;
    this.name = options.name ?? 'webusb';
    if (options.vendorId !== undefined) this.vendorId = options.vendorId;
    if (options.productId !== undefined) this.productId = options.productId;
    if (options.interfaceNumber !== undefined) this.interfaceNumber = options.interfaceNumber;
    this.configurationValue = options.configurationValue ?? 1;
  }

  /**
   * Abre el dispositivo y reclama la interfaz de impresion.
   *
   * Idempotente: si ya esta abierto, no hace nada. Sin eso, un segundo `open` desde
   * otra pantalla tira `device is already open` y el POS muestra un error por algo que
   * ya estaba resuelto.
   */
  async open(): Promise<void> {
    if (this.opened && this.device && this.endpoint !== null) return;

    this.device = await this.pickDevice();
    // `open()` sobre un dispositivo ya abierto lanza. No se comprueba con
    // `getConfiguration()` porque esa llamada tambien falla en un dispositivo
    // cerrado, y el caso real (el KDS se remonta y vuelve a pedir permiso) tiene que
    // salir por el camino de adentro.
    try {
      await this.device.open();
    } catch {
      // Ya abierto.
    }

    const target = this.findInterface(this.device);
    await this.device.selectConfiguration(target.configurationValue);
    await this.device.claimInterface(target.interfaceNumber);
    await this.device.selectAlternateInterface(target.interfaceNumber, 0);

    this.endpoint = target.endpointNumber;
    this.opened = true;
  }

  /**
   * Escribe el ticket.
   *
   * **No** llama a `open()` solo: si el permiso no fue concedido, el navegador
   * rechazaria en silencio y el POS creeria que salio. El error tiene que ser visible
   * en el punto donde el usuario puede dar permiso.
   */
  async write(bytes: Uint8Array): Promise<void> {
    if (!this.device || this.endpoint === null || !this.opened) {
      console.warn(
        `${this.name}: la impresora no esta abierta. Llamá a open() desde un gesto ` +
          'del usuario antes de imprimir.',
      );
      return;
    }
    await this.device.transferOut(this.endpoint, bytes);
  }

  async close(): Promise<void> {
    if (!this.device) return;
    await this.device.close().catch(() => undefined);
    this.device = null;
    this.endpoint = null;
    this.opened = false;
  }

  /**
   * El dispositivo.
   *
   * Se reintenta con `getDevices()` antes de pedir uno nuevo: un permiso concedido se
   * **recuerda** entre recargas de la pagina, y `requestDevice()` cada vez abre el
   * dialogo del navegador. Un POS que abre el KDS treinta veces por hora no puede
   * treinta dialogos por hora.
   */
  private async pickDevice(): Promise<UsbDeviceLike> {
    if (this.vendorId !== undefined) {
      const granted = await this.usb.getDevices();
      const match = granted.find((device) => matchesVendor(device, this.vendorId!, this.productId));
      if (match) return match;
    }
    return this.usb.requestDevice({
      filters: [filterFor(this.vendorId, this.productId)],
    });
  }

  /** La interfaz con un endpoint de salida. Una impresora de ticket solo tiene esa. */
  private findInterface(device: UsbDeviceLike): {
    interfaceNumber: number;
    endpointNumber: number;
    configurationValue: number;
  } {
    const configuration = device.configuration;
    const interfaces = configuration?.interfaces ?? [];
    for (const [index, candidate] of interfaces.entries()) {
      for (const alternate of candidate.alternates) {
        const out = alternate.endpoints.find((endpoint) => endpoint.direction === 'out');
        if (out) {
          return {
            // El `interfaceNumber` es un indice, no un campo del objeto: la API de
            // WebUSB lo define asi. Un `-1` es el error clasico cuando se pasa el
            // objeto en vez del indice, y el sintoma es `claimInterface(0)` sobre la
            // interfaz equivocada.
            interfaceNumber: this.interfaceNumber ?? index,
            endpointNumber: out.endpointNumber,
            configurationValue: this.configurationValue,
          };
        }
      }
    }
    throw new Error('El dispositivo USB no tiene un endpoint de escritura.');
  }
}

/**
 * El filtro de `requestDevice`.
 *
 * Sin `vendorId` se pasan **todos** los vendors de impresoras conocidas: el usuario ve
 * una lista corta en vez de tener que saber el id de su impresora, que es informacion
 * que no tiene.
 */
function filterFor(
  vendorId?: number,
  productId?: number,
): { vendorId?: number; productId?: number } {
  if (vendorId !== undefined) {
    return productId !== undefined ? { vendorId, productId } : { vendorId };
  }
  return { vendorId: COMMON_PRINTER_VENDORS[0] };
}

function matchesVendor(device: UsbDeviceLike, vendorId: number, productId?: number): boolean {
  // `getDevices()` devuelve el `USBDevice` con `vendorId`/`productId` en las
  // propiedades; el tipo declarado no los expone porque no hacen falta para escribir.
  const raw = device as unknown as { vendorId?: number; productId?: number };
  if (raw.vendorId !== undefined && raw.vendorId !== vendorId) return false;
  if (productId !== undefined && raw.productId !== undefined && raw.productId !== productId) {
    return false;
  }
  return true;
}

/** `navigator.usb`, o `null` si este runtime no lo tiene. */
function resolveUsb(): UsbLike | null {
  const nav = (globalThis as { navigator?: { usb?: UsbLike } }).navigator;
  return nav?.usb ?? null;
}
