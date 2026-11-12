import { describe, expect, it, vi } from 'vitest';
import { ConsoleDriver, formatEscPos } from './console-driver';
import * as cmd from '../commands';
import { toBytes } from '../text';

/**
 * El driver de consola.
 *
 * Es el driver por defecto del POS recien instalado: sin impresora configurada, la
 * pantalla de cocina tiene que tener a donde mandar el papel **para poder verlo**. Por
 * eso hay que probarlo de verdad, y no solo compilarlo.
 */
describe('ConsoleDriver', () => {
  it('escribe y captura stdout', async () => {
    // El `sink` se inyecta en vez de espiar `console.log`: espiar el global acopla el
    // test al runtime de Node y dos tests en paralelo se pisan la salida.
    const sink = vi.fn();
    const driver = new ConsoleDriver({ name: 'cocina', sink });

    await driver.write(Uint8Array.from([0x1b, 0x40]));

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toBe('<ESC @>');
  });

  it('escribe un ticket entero y se puede leer', async () => {
    const sink = vi.fn();
    const driver = new ConsoleDriver({ sink });

    await driver.write(
      Uint8Array.from([
        ...cmd.init(),
        ...cmd.align(cmd.ALIGN.CENTER),
        ...toBytes('Bar Ñandú', 'CP850'),
        ...cmd.CRLF,
        ...cmd.cut(),
      ]),
    );

    const salida = sink.mock.calls[0]![0] as string;
    expect(salida).toContain('Bar Ñandú');
    // El corte tiene que verse: es lo que se revisa para saber que el papel se corta.
    expect(salida).toContain('<GS V>B');
  });

  it('un write por ticket, no uno por linea', async () => {
    // Cada `write` es un envio a la impresora. Mandar lineas sueltas es recibir papel
    // a medias cuando se corta la conexion.
    const sink = vi.fn();
    const driver = new ConsoleDriver({ sink });

    await driver.write(Uint8Array.from(toBytes('una', 'CP850')));
    await driver.write(Uint8Array.from(toBytes('dos', 'CP850')));

    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('no tira cuando el sink falla', async () => {
    // El contrato de `PrinterDriver` dice que `write` no tira: una impresora sin papel
    // no puede dejar al POS con una pantalla en blanco.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const driver = new ConsoleDriver({
      sink: () => {
        throw new Error('stdout cerrado');
      },
    });

    await expect(driver.write(Uint8Array.from([0x1b, 0x40]))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('acepta un formateo propio', async () => {
    const sink = vi.fn();
    const driver = new ConsoleDriver({ sink, format: () => 'FORMATEADO' });

    await driver.write(Uint8Array.from([0x1b, 0x40]));

    expect(sink).toHaveBeenCalledWith('FORMATEADO');
  });

  it('el nombre del driver es el que se pasó', () => {
    expect(new ConsoleDriver({ name: 'barra' }).name).toBe('barra');
    expect(new ConsoleDriver().name).toBe('consola');
  });
});

describe('formatEscPos', () => {
  it('marca los comandos y deja el texto legible', () => {
    const salida = formatEscPos(
      Uint8Array.from([...cmd.init(), ...cmd.align(cmd.ALIGN.RIGHT), ...toBytes('$ 100', 'CP850')]),
    );
    expect(salida).toBe('<ESC @><ESC a 0x02>$ 100');
  });

  it('convierte CR LF en un solo salto', () => {
    const salida = formatEscPos(Uint8Array.from(cmd.CRLF));
    expect(salida).toBe('\n');
  });

  it('decodifica los acentos con la pagina que esta vigente', () => {
    // El buffer arranca con `ESC t 2` (CP850): si el decodificador no lo sigiera,
    // mostraria `?` donde deberia ir la `ñ`.
    const salida = formatEscPos(Uint8Array.from([...cmd.codepage(2), ...toBytes('ñ¿¡', 'CP850')]));
    expect(salida).toBe('<ESC t 0x02>ñ¿¡');
  });

  it('en CP858 el euro se ve como euro', () => {
    const salida = formatEscPos(Uint8Array.from([...cmd.codepage(19), ...toBytes('€', 'CP858')]));
    expect(salida).toBe('<ESC t 0x13>€');
  });

  it('muestra los parametros que no son imprimibles en hex', () => {
    // Los bytes del cortador (`19 FA`) en crudo romperian el volcado.
    const salida = formatEscPos(Uint8Array.from(cmd.enableCutting()));
    expect(salida).toBe('<ESC p 0x01 0x19 0xfa>');
  });

  it('un byte suelto que no es texto no rompe el volcado', () => {
    // Los comandos con datos (GS v) no se decodifican enteros: se muestran como
    // comando y el resto se lee como texto.
    const salida = formatEscPos(
      Uint8Array.from([
        ...cmd.drawBitmap({ data: [0xff], widthBytes: 1, heightBytes: 1 }),
        ...toBytes('x', 'CP850'),
      ]),
    );
    expect(salida).toContain('<GS v>');
    expect(salida).toContain('x');
  });
});
