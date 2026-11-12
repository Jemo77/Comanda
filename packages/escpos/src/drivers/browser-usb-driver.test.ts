import { describe, expect, it } from 'vitest';
import {
  BrowserUsbDriver,
  COMMON_PRINTER_VENDORS,
  type UsbDeviceLike,
  type UsbLike,
} from './browser-usb-driver';

/**
 * El driver de WebUSB, con un dispositivo de mentira.
 *
 * En Node no hay `navigator.usb`, asi que `usb` se inyecta siempre. Es justamente lo
 * que hay que probar: que el driver no dependa de nada del navegador mas alla del
 * objeto que recibe, para que el POS lo pueda cargar sin romper el bundle.
 */
function fakeDevice(
  overrides: Partial<UsbDeviceLike> = {},
): UsbDeviceLike & { written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  let opened = false;
  return {
    written,
    vendorId: 0x04b8,
    configuration: {
      interfaces: [
        { alternates: [{ endpoints: [{ endpointNumber: 1, direction: 'out' as const }] }] },
      ],
    },
    async open() {
      if (opened) throw new Error('device is already open');
      opened = true;
    },
    async selectConfiguration() {},
    async claimInterface() {},
    async selectAlternateInterface() {},
    async transferOut(_endpoint, data) {
      written.push(data as Uint8Array);
      return {};
    },
    async close() {
      opened = false;
    },
    ...overrides,
  } as UsbDeviceLike & { written: Uint8Array[] };
}

function fakeUsb(devices: UsbDeviceLike[] = []): UsbLike & { asked: number } {
  const usb = {
    asked: 0,
    async requestDevice() {
      usb.asked += 1;
      return devices[0]!;
    },
    async getDevices() {
      return devices;
    },
  };
  return usb as UsbLike & { asked: number };
}

describe('BrowserUsbDriver', () => {
  it('falla claro cuando el runtime no tiene WebUSB', () => {
    // En Node el error tiene que decir que use `TcpDriver`: "Cannot read properties of
    // undefined" no le dice nada a nadie.
    expect(() => new BrowserUsbDriver({ usb: null })).toThrow(/TcpDriver/);
  });

  it('reclama la interfaz y escribe por el endpoint de salida', async () => {
    const device = fakeDevice();
    const driver = new BrowserUsbDriver({ usb: fakeUsb([device]), vendorId: 0x04b8 });

    await driver.open();
    await driver.write(Uint8Array.from([0x1b, 0x40]));

    expect(device.written).toHaveLength(1);
    expect(Array.from(device.written[0]!)).toEqual([0x1b, 0x40]);
  });

  it('es idempotente: un `open` de mas no rompe', async () => {
    // El KDS se remonta y vuelve a pedir permiso: sin idempotencia, `device is already
    // open` aparece en pantalla por algo que ya estaba resuelto.
    const device = fakeDevice();
    const driver = new BrowserUsbDriver({ usb: fakeUsb([device]), vendorId: 0x04b8 });

    await driver.open();
    await driver.open();

    expect(device.written).toHaveLength(0);
  });

  it('reusa el permiso concedido en vez de abrir el dialogo del navegador', async () => {
    // Un permiso concedido se recuerda entre recargas. Un POS que abre el KDS treinta
    // veces por hora no puede abrir treinta dialogos por hora.
    const device = fakeDevice();
    const usb = fakeUsb([device]);
    const driver = new BrowserUsbDriver({ usb, vendorId: 0x04b8 });

    await driver.open();

    expect(usb.asked).toBe(0);
  });

  it('pide permiso si no hay ninguno concedido', async () => {
    const device = fakeDevice();
    const usb = fakeUsb([device]);
    const driver = new BrowserUsbDriver({ usb, vendorId: 0x1234 });

    await driver.open();

    expect(usb.asked).toBe(1);
  });

  it('no escribe si el permiso no fue concedido', async () => {
    // `write` NO llama a `open` solo: el navegador rechazaria en silencio y el POS
    // creeria que el papel salio. El aviso tiene que estar en el `open`.
    const device = fakeDevice();
    const warn = console.warn;
    let warned = '';
    console.warn = (message?: unknown) => {
      warned = String(message);
    };
    try {
      const driver = new BrowserUsbDriver({ usb: fakeUsb([device]), vendorId: 0x04b8 });
      await driver.write(Uint8Array.from([0x1b]));
    } finally {
      console.warn = warn;
    }

    expect(device.written).toHaveLength(0);
    expect(warned).toMatch(/no esta abierta/);
  });

  it('elige el numero de configuracion que se le pide', async () => {
    const selected: number[] = [];
    const device = fakeDevice({
      selectConfiguration: async (value: number) => {
        selected.push(value);
      },
    });
    const driver = new BrowserUsbDriver({
      usb: fakeUsb([device]),
      vendorId: 0x04b8,
      configurationValue: 2,
    });

    await driver.open();

    expect(selected).toEqual([2]);
  });

  it('avisa si el dispositivo no tiene endpoint de escritura', async () => {
    // Es un USB que no es impresora: sin endpoint de salida no hay a donde escribir, y
    // un error de permisos no explicaria eso.
    const device = fakeDevice({
      configuration: {
        interfaces: [
          { alternates: [{ endpoints: [{ endpointNumber: 0x81, direction: 'in' as const }] }] },
        ],
      },
    });
    const driver = new BrowserUsbDriver({ usb: fakeUsb([device]), vendorId: 0x04b8 });

    await expect(driver.open()).rejects.toThrow(/endpoint de escritura/);
  });

  it('cierra y forgets el dispositivo', async () => {
    const device = fakeDevice();
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const driver = new BrowserUsbDriver({ usb: fakeUsb([device]), vendorId: 0x04b8 });
      await driver.open();
      await driver.close();
      await driver.write(Uint8Array.from([0x1b]));
    } finally {
      console.warn = warn;
    }

    expect(device.written).toHaveLength(0);
  });
});

describe('los vendors de impresoras conocidas', () => {
  it('incluye las Epson, Star y Bixolon', () => {
    // Un local no tiene que saber el id de su impresora para que funcione.
    expect(COMMON_PRINTER_VENDORS).toContain(0x04b8);
    expect(COMMON_PRINTER_VENDORS).toContain(0x0519);
    expect(COMMON_PRINTER_VENDORS).toContain(0x1a2a);
    expect(new Set(COMMON_PRINTER_VENDORS).size).toBe(COMMON_PRINTER_VENDORS.length);
  });
});
