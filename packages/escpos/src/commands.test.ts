import { describe, expect, it } from 'vitest';
import * as cmd from './commands';

/**
 * Los bytes del protocolo, exactos.
 *
 * `toEqual` sobre el array de numeros, no sobre un snapshot legible. La razon es
 * concreta: un snapshot que muestra `"\u001b\u0040"` se puede reescribir sin que nadie
 * lo note (`--update`), y un byte cambiado de `1b 40` a `1b 41` es un `init` que no
 * reinicia la impresora y deja la fuente del ticket anterior puesta. El numero tiene
 * que estar a la vista.
 */
describe('comandos ESC/POS', () => {
  it('init es ESC @', () => {
    expect([...cmd.init()]).toEqual([0x1b, 0x40]);
  });

  it('align usa ESC a con el codigo del protocolo', () => {
    expect([...cmd.align(cmd.ALIGN.LEFT)]).toEqual([0x1b, 0x61, 0]);
    expect([...cmd.align(cmd.ALIGN.CENTER)]).toEqual([0x1b, 0x61, 1]);
    expect([...cmd.align(cmd.ALIGN.RIGHT)]).toEqual([0x1b, 0x61, 2]);
  });

  it('bold manda 1 o 0, no un booleano', () => {
    // Un `ESC E true` mandaria un byte distinto al que espera la impresora.
    expect([...cmd.bold(true)]).toEqual([0x1b, 0x45, 1]);
    expect([...cmd.bold(false)]).toEqual([0x1b, 0x45, 0]);
  });

  it('size combina los bits de ancho y alto por separado', () => {
    // 0x10 es doble ancho, 0x01 es doble alto. `DOUBLE` tiene ambos.
    expect([...cmd.size(cmd.SIZE.NORMAL)]).toEqual([0x1d, 0x21, 0x00]);
    expect([...cmd.size(cmd.SIZE.DOUBLE_HEIGHT)]).toEqual([0x1d, 0x21, 0x01]);
    expect([...cmd.size(cmd.SIZE.DOUBLE_WIDTH)]).toEqual([0x1d, 0x21, 0x10]);
    expect([...cmd.size(cmd.SIZE.DOUBLE)]).toEqual([0x1d, 0x21, 0x11]);
  });

  it('los atajos de tamaño coinciden con size()', () => {
    expect([...cmd.doubleWidth()]).toEqual([...cmd.size(cmd.SIZE.DOUBLE_WIDTH)]);
    expect([...cmd.doubleHeight()]).toEqual([...cmd.size(cmd.SIZE.DOUBLE_HEIGHT)]);
    expect([...cmd.doubleSize()]).toEqual([...cmd.size(cmd.SIZE.DOUBLE)]);
    expect([...cmd.normalSize()]).toEqual([...cmd.size(cmd.SIZE.NORMAL)]);
  });

  it('feed es ESC d con la cantidad de lineas', () => {
    expect([...cmd.feed(3)]).toEqual([0x1b, 0x64, 3]);
  });

  it('cut usa GS V 66: el unico modo que avanza y despues corta', () => {
    // 65 (0x41) corta sin avanzar y deja el ultimo renglon adentro del rollo.
    expect([...cmd.cut()]).toEqual([0x1d, 0x56, 66]);
    expect(cmd.CUT_PARTIAL).toBe(66);
  });

  it('codepage es ESC t con el numero del protocolo', () => {
    expect([...cmd.codepage(2)]).toEqual([0x1b, 0x74, 2]);
  });

  it('enableCutting arma el cortador con ESC p 1', () => {
    // Sin esto el corte funciona una vez y el segundo ticket se imprime entero.
    expect([...cmd.enableCutting()]).toEqual([0x1b, 0x70, 0x01, 0x19, 0xfa]);
  });

  it('drawerPulse usa ESC p 0: mismo comando, otra familia', () => {
    expect([...cmd.drawerPulse()]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  });

  it('drawBitmap manda el encabezado con los bytes en little endian', () => {
    const bytes = [...cmd.drawBitmap({ data: [0xff, 0x81], widthBytes: 2, heightBytes: 1 })];
    expect(bytes).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 1, 0, 0xff, 0x81]);
  });

  it('drawBitmapRows aplana en column-major, que es como lee la impresora', () => {
    // 2 columnas de ancho, 2 de alto. En column-major el orden es (0,0),(1,0),(0,1),(1,1).
    const rows = [
      [0b11000000, 0b10000000],
      [0b10100000, 0b10000010],
    ];
    const bytes = [...cmd.drawBitmapRows({ rows, widthBytes: 2 })];
    expect(bytes.slice(0, 8)).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]);
    expect(bytes.slice(8)).toEqual([0b11000000, 0b10100000, 0b10000000, 0b10000010]);
  });

  it('barcode termina en NUL', () => {
    // Sin el 0x00 final la impresora sigue leyendo bytes del comando siguiente.
    expect([...cmd.barcode('123')]).toEqual([0x1d, 0x6b, 73, 0x31, 0x32, 0x33, 0x00]);
  });

  it('concat aplana bytes sueltos y listas', () => {
    expect([...cmd.concat([0x01], [0x02, 0x03], [[0x04], [0x05, 0x06]])]).toEqual([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
    ]);
  });
});
