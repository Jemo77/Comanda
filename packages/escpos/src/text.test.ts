import { describe, expect, it } from 'vitest';
import { CODEPAGES, encodeText, sanitize, toBytes, toUint8Array } from './text';

/**
 * La codificacion es lo que separa un ticket legible de uno roto.
 *
 * Un `ñ` en UTF-8 son dos bytes (`C3 B1`) y la impresora no sabe que es una letra:
 * imprime dos simbolos raros. Por eso los bytes se comparan uno por uno y no con el
 * string de entrada.
 */
describe('codificacion a bytes', () => {
  it('ASCII sale igual', () => {
    expect(toBytes('Hola', 'CP850')).toEqual([0x48, 0x6f, 0x6c, 0x61]);
  });

  it('la ñ y los acentos tienen su byte en CP850', () => {
    expect(toBytes('ñ', 'CP850')).toEqual([0xa4]);
    expect(toBytes('Ñ', 'CP850')).toEqual([0xa5]);
    expect(toBytes('áéíóú', 'CP850')).toEqual([0xa0, 0x82, 0xa1, 0xa2, 0xa3]);
    expect(toBytes('¿', 'CP850')).toEqual([0xa8]);
    expect(toBytes('¡', 'CP850')).toEqual([0xad]);
    expect(toBytes('«»', 'CP850')).toEqual([0xae, 0xaf]);
    expect(toBytes('üÜ', 'CP850')).toEqual([0x81, 0x9a]);
  });

  it('el euro sale distinto segun la pagina', () => {
    // CP850 no tiene euro (el byte 0xD5 es `ı`); CP858 lo tiene. Es exactamente la
    // razon por la que CP858 existe.
    expect(toBytes('€', 'CP858')).toEqual([0xd5]);
    expect(toBytes('€', 'CP850')).toEqual([0x3f]);
  });

  it('la misma letra puede estar en bytes distintos segun la pagina', () => {
    // `¢` esta en 0x9B en CP437 y en 0xBD en CP850. Es el caso real de una impresora
    // configurada con la pagina que no es: el simbolo sale, pero en la posicion
    // equivocada, y el ticket parece estar en otro idioma.
    expect(toBytes('¢', 'CP437')).toEqual([0x9b]);
    expect(toBytes('¢', 'CP850')).toEqual([0xbd]);
    expect(toBytes('©', 'CP437')).toEqual([0x3f]);
    expect(toBytes('©', 'CP850')).toEqual([0xb8]);
  });

  it('sustituye lo que la pagina no tiene y cuenta cuantas', () => {
    // Un emoji es UN caracter: si se recorriera por indice UTF-16 serian dos
    // surrogates y se contarian dos sustituciones.
    const result = encodeText('Café ☕', 'CP850');
    expect(result.replaced).toBe(1);
    expect(result.bytes).toEqual([0x43, 0x61, 0x66, 0x82, 0x20, 0x3f]);
  });

  it('un caracter cirilico tambien se sustituye', () => {
    expect(toBytes('М', 'CP850')).toEqual([0x3f]);
  });

  it('el NBSP no se cuenta como sustitucion', () => {
    // 0xFF en CP850 es el espacio no separable, que esta en la tabla.
    const result = encodeText('a b', 'CP850');
    expect(result.replaced).toBe(0);
    expect(result.bytes).toEqual([0x61, 0xff, 0x62]);
  });

  it('una pagina desconocida cae en CP850 en vez de romper', () => {
    // El nombre viene de la configuracion del local: una impresora con una pagina
    // rara tiene que seguir imprimiendo.
    expect(toBytes('ñ', 'CP860')).toEqual(toBytes('ñ', 'CP850'));
  });

  it('cada pagina tiene 128 bytes en la mitad alta', () => {
    for (const page of Object.values(CODEPAGES)) {
      expect([...page.high]).toHaveLength(128);
    }
  });
});

describe('sanitize', () => {
  it('reemplaza antes de codificar, no despues', () => {
    // La razon del sanitize es que un byte crudo fuera de la pagina puede ser el
    // comienzo de un comando: un 0x1B suelto abre un ESC y lo que sigue se ejecuta.
    expect(sanitize('Café ☕', 'CP850')).toBe('Café ?');
    expect(toBytes(sanitize('Café ☕', 'CP850'))).toEqual([0x43, 0x61, 0x66, 0x82, 0x20, 0x3f]);
  });

  it('deja intacto lo que la pagina tiene', () => {
    expect(sanitize('Ñandú ¿?', 'CP850')).toBe('Ñandú ¿?');
  });
});

describe('toUint8Array', () => {
  it('convierte una sola vez, en el borde', () => {
    const bytes = toUint8Array([0x1b, 0x40]);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([0x1b, 0x40]);
  });
});
