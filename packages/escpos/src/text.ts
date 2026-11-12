/**
 * Texto a bytes, con la codificacion que la impresora espera.
 *
 * ## El problema
 *
 * La impresora no entiende UTF-8. `ñ` en UTF-8 son dos bytes (`C3 B1`) y el
 * protocolo ESC/POS de 80 mm no tiene idea de que eso es una letra: imprime dos
 * simbolos raros o un caracter de control. Lo mismo con `á`, `¿`, `¡`, `€`.
 *
 * La diferencia es entre un ticket legible y uno que hay que descifrar, asi que la
 * tabla va aca y no en el driver: el driver escribe bytes, no sabe de letras.
 *
 * ## La eleccion: CP850 (o CP858)
 *
 * Las impresoras termicas de 80 mm traen la familia IBM de paginas de codigo. Las
 * que sirven para espanol son:
 *
 * - **CP437**: la original. Tiene `ñ`, `¿`, `¡` y las vocales acentuadas, asi que
 *   alcanza para espanol. No tiene `€` ni `º`.
 * - **CP850**: la version "multilingual" de CP437. Todo lo de CP437 mas `º`, `ª`,
 *   `«»`, `€` en la 858, y mas acentos (Á, Ä...). Es la que traen de fabrica las
 *   Epson TM y la mayoria de las chinese.
 * - **CP858**: CP850 con `€` en lugar de `ı`. Es la misma tabla con una diferencia,
 *   y es la unica que imprime el simbolo de euro correctamente.
 *
 * **Se elige CP850 por default** y no CP437 porque los tickets de este producto
 * llevan `€` (el menu de un bar en Madrid) y `º`/`ª` ("1º cafe"), y CP437 los
 * pierde. CP858 esta disponible y es la que hay que elegir si el local factura en
 * euros.
 *
 * ## Por que la tabla esta escrita y no calculada
 *
 * Se podria calcular con una formula y sale mas corto, pero una tabla de 128
 * entradas que se lee es mas facil de verificar contra la documentacion de Epson que
 * una formula que hay que confiar. Ademas el costo es irrelevante: 128 entradas en un
 * bundle que el POS ya carga.
 *
 * ## Que pasa con lo que no existe en la pagina
 *
 * Un emoji o un caracter cirilico no tienen byte. Se sustituye por `?` en vez de
 * romper: un `?` es un ticket con un caracter mal, un byte fuera de rango es una
 * impresora que deja de responder y un ticket que no se imprime nunca. El conteo de
 * sustituciones se devuelve para que el llamador pueda avisar.
 */

/** Caracteres de la mitad alta de la pagina, en el orden de los bytes 0x80..0xFF. */
const CP850_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' +
  'áíóúñÑªº¿®¬½¼¡«»' +
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' +
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' +
  '­±‗¾¶§÷¸°¨·¹³²■ ';

const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** Sustitucion para lo que la pagina de codigos no tiene. */
export const REPLACEMENT = '?';

/**
 * Paginas de codigos soportadas, con su numero para `ESC t n`.
 *
 * El numero es el que la impresora interpreta: es parte del protocolo, no un indice
 * en esta tabla. Por eso la tabla y el numero estan juntos, para que no se mezclen al
 * agregar una.
 */
export const CODEPAGES = {
  /** `ESC t 0`: la original. Sin `€`, sin `º`. */
  CP437: { escT: 0, high: CP437_HIGH },
  /** `ESC t 2`: la de las Epson TM de fabrica. La mas completa para espanol. */
  CP850: { escT: 2, high: CP850_HIGH },
  /**
   * `ESC t 19`: CP850 con `€` en 0xD5 (donde CP850 tiene `ı`).
   *
   * Es la unica que imprime el simbolo de euro. Se agrega como tabla propia y no como
   * "CP850 con un parche" porque el parche es exactamente el tipo de detalle que se
   * pierde en una copia.
   */
  CP858: { escT: 19, high: CP850_HIGH.replace(/ı/, '€') },
} as const;

export type CodepageName = keyof typeof CODEPAGES;

/**
 * Bytes por caracter. Todas las paginas son de un byte: ESC/POS de 80 mm.
 *
 * Es `string` y no `CodepageName` a proposito: el generador de tickets recibe la
 * pagina como texto desde la configuracion (`stations` o el perfil del local), y
 * acotarlo a un union de literales haria que un valor de la base que no este en la
 * lista no compilara en el lugar donde se usa. El nombre desconocido cae en CP850,
 * que es el default y el mas completo.
 */
export type Codepage = string;

/** Resultado de codificar: los bytes y cuantos caracteres hubo que sustituir. */
export interface EncodeResult {
  bytes: number[];
  /** Caracteres que la pagina de codigos no tiene y se reemplazaron por `?`. */
  replaced: number;
}

/** De la pagina de codigos a texto plano: los bytes 0x00..0x7F son ASCII. */
function buildLookup(codepage: CodepageName): Map<string, number> {
  const { high } = CODEPAGES[codepage];
  const lookup = new Map<string, number>();
  for (let i = 0; i < high.length; i += 1) {
    // El ultimo es un espacio no separable (0xFF), que tambien esta en el juego de
    // caracteres: se registra igual, asi que un NBSP no se cuenta como sustitucion.
    lookup.set(high[i]!, 0x80 + i);
  }
  return lookup;
}

/** Las tablas ya construidas, una sola vez: construirlas por llamada seria caro. */
const LOOKUPS: Record<CodepageName, Map<string, number>> = {
  CP437: buildLookup('CP437'),
  CP850: buildLookup('CP850'),
  CP858: buildLookup('CP858'),
};

/**
 * La tabla de un nombre de pagina.
 *
 * Un nombre que no existe cae en **CP850**, no en una excepcion: el nombre viene de la
 * configuracion del local y una impresora con una pagina rara (CP860, PC3) tiene que
 * seguir imprimiendo en vez de dejar el ticket entero sin salir. Un `?` en vez de una
 * `ñ` se nota; un ticket que no se imprime, no.
 */
export function lookupFor(codepage: Codepage): Map<string, number> {
  return LOOKUPS[codepage as CodepageName] ?? LOOKUPS.CP850;
}

/**
 * Codifica texto a bytes de la pagina de codigos.
 *
 * Recorre **por punto de codigo** y no por indice UTF-16: si un caracter caiera
 * fuera del BMP (un emoji, un ideograma), `text[i]` y `text[i+1]` serian los dos
 * mitades del surrogate y se contarian como dos sustituciones en vez de una. Con
 * `for...of` un emoji es un caracter, se sustituye una vez y sale un `?`.
 */
export function encodeText(text: string, codepage: Codepage = 'CP850'): EncodeResult {
  const lookup = lookupFor(codepage);
  const bytes: number[] = [];
  let replaced = 0;

  for (const char of text) {
    // `for...of` recorre por punto de codigo, asi que un caracter fuera del BMP
    // (un emoji) es un solo `char` y no los dos surrogates sueltos.
    const code = char.codePointAt(0)!;

    if (code < 0x80) {
      bytes.push(code);
      continue;
    }

    const mapped = lookup.get(char);
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }

    bytes.push(REPLACEMENT.charCodeAt(0));
    replaced += 1;
  }

  return { bytes, replaced };
}

/** Solo los bytes, sin el conteo. Es lo que usa el generador de tickets. */
export function toBytes(text: string, codepage: Codepage = 'CP850'): number[] {
  return encodeText(text, codepage).bytes;
}

/**
 * Los bytes a un `Uint8Array`, que es lo que aceptan `net.Socket` y `USBOutTransfer`.
 *
 * Es la unica conversion del paquete. Todo lo demas trabaja con `number[]` porque en
 * el navegador concatenar `Uint8Array` obliga a castear en cada paso.
 */
export function toUint8Array(bytes: readonly number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

/**
 * Reemplaza lo que la impresora no puede mostrar.
 *
 * El caso real es el nombre del producto y la nota del mozo, que los escribe una
 * persona y pueden traer un emoji. Imprimir el emoji crudo produce bytes que la
 * impresora puede interpretar como **comandos**: un `0x1B` suelto en medio del texto
 * es el comienzo de un comando ESC/POS, y lo que sigue se ejecuta. Un producto
 * llamado "Café ☕" puede abrir el cajon de dinero.
 *
 * Por eso la sustitucion no es un `?` cualquiera: se hace **antes** de codificar, y
 * lo que se descarta es el caracter entero.
 */
export function sanitize(text: string, codepage: Codepage = 'CP850'): string {
  const lookup = lookupFor(codepage);
  let out = '';
  for (const char of text) {
    if (char.codePointAt(0)! < 0x80 || lookup.has(char)) out += char;
    else out += REPLACEMENT;
  }
  return out;
}
