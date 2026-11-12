/**
 * Comandos ESC/POS como bytes.
 *
 * ESC/POS es un protocolo de bytes, no de strings: cada comando es una secuencia
 * exacta que la impresora interpreta. Un byte de mas cambia lo que hace, asi que
 * aca **no hay strings con caracteres de control**: los bytes van como numeros, y los
 * numeros magicos estan nombrados (`ESC`, `GS`, `LF`, ...).
 *
 * ## Por que `number[]` y no `Buffer`
 *
 * `Buffer` es de Node. Este paquete corre tambien en el navegador (el POS imprime
 * por WebUSB) y en el navegador `Buffer` no existe. `Uint8Array` seria el tipo
 * "correcto" pero obliga a castear en cada concatenacion, asi que el paquete trabaja
 * con `number[]` y convierte una sola vez, en el borde, cuando el driver escribe.
 * Ver `toUint8Array` en `text.ts`.
 *
 * ## Por que importar comandos y no escribirlos a mano en el ticket
 *
 * `GS V 66` (cortar) tiene que ser exactamente `1b 56 42`. Si aparece literal en el
 * generador de tickets, un cambio de rookie lo rompe y el sintoma es que la
 * impresora no corta el papel: un ticket que se sigue acumulando adentro del rollo.
 * Nombrado, se lee, se testea una vez y se usa en todos lados.
 */

/** Bytes de un comando ESC/POS. */
export type EscPosBytes = readonly number[];

/** `ESC` (0x1B): abre un comando de la familia ESC. */
export const ESC = 0x1b;
/** `GS` (0x1D): abre un comando de la familia GS (los que amplian el juego de ESC). */
export const GS = 0x1d;
/** Salto de linea. */
export const LF = 0x0a;
/** Salto de linea y carriages: en una impresora de ticket es "subir una linea". */
export const CRLF: EscPosBytes = [0x0d, LF];

/**
 * `ESC @` · Reset.
 *
 * Vuelve la impresora a su estado de fabrica:Fuente, margenes, corte, todo. Va
 * **primero** en cada ticket, y es la unica forma de garantizar que el ticket
 * anterior no dejo la fuente en negrita o el cutter armed.
 */
export function init(): EscPosBytes {
  return [ESC, 0x40];
}

/**
 * `ESC p 1 t1 t2` · Ariala el cortador (`m = 1`).
 *
 * Va **antes** del ticket. Sin esto, `GS V 66` corta el papel pero no arma el cortador
 * para el siguiente: el segundo ticket se imprime entero y el papel se acumula adentro
 * del rollo hasta que alguien lo saca a mano.
 */
export function enableCutting(): EscPosBytes {
  return [ESC, 0x70, 0x01, 0x19, 0xfa];
}

/**
 * `ESC p 0 t1 t2` · Pulso al cajon de dinero.
 *
 * Mismo comando base que el cortador, con `m = 0`. Comparten la familia por
 * proximidad en el protocolo, no por parecido de funcion.
 */
export function drawerPulse(t1 = 0x19, t2 = 0xfa): EscPosBytes {
  return [ESC, 0x70, 0x00, t1, t2];
}

/** Alineacion horizontal. */
export const ALIGN = {
  LEFT: 0,
  CENTER: 1,
  RIGHT: 2,
} as const;

export type Align = (typeof ALIGN)[keyof typeof ALIGN];

/**
 * `ESC a n` · Alineacion.
 *
 * Se devuelve en un estado explicito y no se acumula: cada ticket que se arma vuelve
 * a `LEFT` al final, porque el siguiente ticket se arma sobre el mismo estado y el
 * que se imprime sin alineacion a la izquierda se lee como un ticket roto.
 */
export function align(mode: Align): EscPosBytes {
  return [ESC, 0x61, mode];
}

/**
 * `ESC E n` · Negrita (fuente A).
 *
 * El parametro es `0` o `1` y no un booleano, porque el protocolo lo define asi y
 * un `ESC E true` mandaria un byte distinto al que espera la impresora.
 */
export function bold(on: boolean): EscPosBytes {
  return [ESC, 0x45, on ? 1 : 0];
}

/** Tamanos de caracter. */
export const SIZE = {
  NORMAL: 0,
  DOUBLE_HEIGHT: 1,
  DOUBLE_WIDTH: 2,
  DOUBLE: 3,
} as const;

export type Size = (typeof SIZE)[keyof typeof SIZE];

/**
 * `GS ! n` · Tamano de caracter.
 *
 * Los bits son independientes: `0x11` es doble alto **y** doble ancho. Por eso se
 * calculate en vez de usar una constante: el ticket usa "doble" para el total y
 * "doble alto" para los titulos, y confundirlos cambia la caja del papel.
 */
export function size(mode: Size): EscPosBytes {
  const height = mode === SIZE.DOUBLE_HEIGHT || mode === SIZE.DOUBLE ? 0x01 : 0x00;
  const width = mode === SIZE.DOUBLE_WIDTH || mode === SIZE.DOUBLE ? 0x10 : 0x00;
  return [GS, 0x21, height | width];
}

/** Atajos de `size`, porque "doble" se pide mucho y `size(SIZE.DOUBLE)` no se lee. */
export const doubleWidth = (): EscPosBytes => size(SIZE.DOUBLE_WIDTH);
export const doubleHeight = (): EscPosBytes => size(SIZE.DOUBLE_HEIGHT);
export const doubleSize = (): EscPosBytes => size(SIZE.DOUBLE);
export const normalSize = (): EscPosBytes => size(SIZE.NORMAL);

/**
 * `ESC d n` · Avanza el papel `n` lineas.
 *
 * Sirve para dejar aire entre tickets: dos papeles pegados son dos comandas que el
 * cocinero no puede separar, y el que no es de esta mesa se lo lleva.
 */
export function feed(lines: number): EscPosBytes {
  return [ESC, 0x64, lines];
}

/**
 * `GS V m` · Corte de papel.
 *
 * El modo 66 (0x42) es "avanza el papel y despues corta a la mitad". Es el unico que
 * se usa en un ticket de 80 mm: el 65 corta sin avanzar y deja el ultimo renglon
 * adentro del rollo, que es exactamente el ticket que se pierde.
 */
export const CUT_PARTIAL = 66;

/** Corta el papel. Va **siempre** al final del ticket. */
export function cut(mode: number = CUT_PARTIAL): EscPosBytes {
  return [GS, 0x56, mode];
}

/**
 * `ESC t n` · Pagina de codigos.
 *
 * Ver `text.ts`: el numero es el que la impresora usa para decidir como interpreta
 * los bytes siguientes, y es lo que hace que un acento salga como acento y no como un
 * simbolo raro.
 */
export function codepage(page: number): EscPosBytes {
  return [ESC, 0x74, page];
}

/**
 * `GS v 0 m xL xH yL yH data` · Imagen de mapa de bits.
 *
 * Sirve para el logo del local y para los codigos de barras. Los bytes van en
 * horizontal: cada byte son ocho pixels, del bit mas alto al mas bajo.
 *
 * @param data Un solo byte por columna de ocho pixels de alto.
 */
export function drawBitmap(params: {
  data: readonly number[];
  /** Bytes por linea: el ancho en pixels dividido por ocho. */
  widthBytes: number;
  /** Bytes de alto: la imagen completa son `widthBytes * heightBytes`. */
  heightBytes: number;
}): EscPosBytes {
  const { data, widthBytes, heightBytes } = params;
  return [
    GS,
    0x76,
    0x30,
    0x00, // m = modo normal (no escalado, no doble alto)
    widthBytes & 0xff,
    (widthBytes >> 8) & 0xff,
    heightBytes & 0xff,
    (heightBytes >> 8) & 0xff,
    ...data,
  ];
}

/**
 * `GS v 0` pero con la imagen ya en columnas.
 *
 * Es un convenience sobre `drawBitmap` para el caso comun (el logo), donde lo que
 * se tiene es un array de filas y hay que aplanarlo. Aplanar en Column-major es lo
 * que espera el protocolo: la impresora lee el papel de a ocho pixeles de alto por
 * columna, y mandarlo row-major produce una imagen con las franjas corridas.
 */
export function drawBitmapRows(params: {
  /** Cada elemento es una fila (un byte por ocho pixeles de ancho). */
  rows: readonly (readonly number[])[];
  widthBytes: number;
}): EscPosBytes {
  const heightBytes = params.rows.length;
  const data: number[] = [];
  for (let x = 0; x < params.widthBytes; x += 1) {
    for (let y = 0; y < heightBytes; y += 1) {
      data.push(params.rows[y]?.[x] ?? 0);
    }
  }
  return drawBitmap({ data, widthBytes: params.widthBytes, heightBytes });
}

/** `GS k` · Codigo de barras CODE128. */
export const BARCODE_CODE128 = 73;

/**
 * `GS k m d ... NUL` · Codigo de barras.
 *
 * El `0x00` final no es opcional: sin el, la impresora sigue leyendo bytes del
 * siguiente comando como si fueran parte del codigo de barras y el papel sale con
 * una barra larga atravesada.
 */
export function barcode(value: string, type: number = BARCODE_CODE128): EscPosBytes {
  return [GS, 0x6b, type, ...Array.from(value, (char) => char.charCodeAt(0)), 0x00];
}

/**
 * Concatena bytes y listas de bytes en un solo buffer.
 *
 * Acepta las dos formas porque el generador de tickets arma los comandos con
 * `cmd.concat(...)` y los renglones de texto con `toBytes(...)`, que son listas: sin
 * el aplanado, cada renglon tendria que ser `[...toBytes(line)]` y se veria el
 * espagueti en todos lados.
 */
export function concat(
  ...parts: readonly (number | readonly (number | readonly number[])[])[]
): number[] {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      out.push(part);
      continue;
    }
    for (const chunk of part) {
      if (typeof chunk === 'number') out.push(chunk);
      else out.push(...chunk);
    }
  }
  return out;
}
