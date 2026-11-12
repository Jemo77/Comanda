import type { PrinterDriver } from './printer-driver';

/**
 * Imprime a `stdout`/log.
 *
 * ## Cuando
 *
 * En desarrollo y en los tests. Es el driver por defecto: un POS recien instalado no
 * tiene ninguna impresora configurada, y sin un destino por defecto la pantalla de
 * cocina no tiene a donde mandar el papel **ni siquiera para ver que se genero**.
 *
 * ## Por que importa mas de lo que parece
 *
 * Es el driver que hace posible probar el generador de tickets entero contra algo
 * real sin tener una impresora enchufada. Los tests de `ticket.test.ts` comparan bytes
 * con `toEqual`, pero un error de integracion (un byte de mas que rompe el corte, un
 * `ESC E 1` que se queda puesto) se ve mejor en un volcado hexadecimal que en un
 * array de numeros.
 *
 * ## Por que el `write` es injectable
 *
 * Los tests necesitan capturar lo que se escribe. Escribir a `process.stdout` y
 * espiarlo funciona, pero acopla el test al global de Node y dos tests en paralelo se
 * pisan la salida. Con un `sink` inyectado, cada test tiene el suyo.
 */
export type ByteSink = (text: string) => void;

export interface ConsoleDriverOptions {
  /** Nombre del destino, para los logs. */
  name?: string;
  /**
   * Donde se escribe. Por defecto, `console.log` (el logger de Nest cuando hay uno).
   *
   * Es un `string`, no bytes: el proposito es que un humano lo lea. Un volcado
   * hexadecimal de 400 bytes en una terminal es ilegible; lo util es el texto que se
   * decodifica de vuelta, con los comandos marcados.
   */
  sink?: ByteSink;
  /**
   * Decodifica los bytes a texto legible.
   *
   * Por defecto, `formatEscPos`: separa los comandos ESC/POS del texto para que se
   * vea donde cambia el estado de la impresora. Sin esto, un volcado hexadecimal es la
   * unica forma de ver que el corte no esta.
   */
  format?: (bytes: Uint8Array) => string;
}

export class ConsoleDriver implements PrinterDriver {
  readonly name: string;

  private readonly sink: ByteSink;
  private readonly format: (bytes: Uint8Array) => string;

  constructor(options: ConsoleDriverOptions = {}) {
    this.name = options.name ?? 'consola';
    this.sink = options.sink ?? ((text) => console.log(text));
    this.format = options.format ?? formatEscPos;
  }

  /**
   * Escribe el volcado.
   *
   * Captura el error del `sink` a proposito: el contrato de `PrinterDriver` dice que
   * `write` no tira (ver el README de `drivers/`), y un `console.log` que falla
   * (stdout cerrado en un proceso sin terminal, que es como corre un POS en un
   * servicio) no puede dejar al POS sin poder imprimir.
   */
  async write(bytes: Uint8Array): Promise<void> {
    try {
      this.sink(this.format(bytes));
    } catch (error) {
      console.warn(
        `${this.name}: no se pudo escribir el volcado (${
          error instanceof Error ? error.message : String(error)
        }).`,
      );
    }
  }
}

/**
 * Decodifica un buffer ESC/POS a texto legible.
 *
 * Los comandos se marcan con su nombre entre corchetes (`<ESC @>`) y el texto se
 * muestra literal. El objetivo es que un humano pueda leer el ticket **sin**
 * impresora: es como se revisa que la guia de puntos quedo bien y que el corte esta
 * al final.
 *
 * No es un decodificador completo del protocolo: los comandos que no importan para
 * leer (los de codepage, los de tamano) se muestran crudos. Un decodificador completo
 * seria mas largo que el generador, y lo que se necesita es poder leer el papel.
 */
export function formatEscPos(bytes: Uint8Array): string {
  const out: string[] = [];
  let index = 0;
  // La pagina de codigos **vigente**: el buffer empieza con `ESC t n` y el texto de
  // despues se interpreta con esa. Sin seguirla, un ticket en CP858 muestra `ı` donde
  // deberia ir el euro, y el volcado miente sobre lo que se imprime.
  let page = CP850_REVERSE;

  while (index < bytes.length) {
    const byte = bytes[index]!;

    if (byte === 0x1b && index + 1 < bytes.length) {
      const next = bytes[index + 1]!;
      const name = ESC_COMMANDS[next] ?? `0x${next.toString(16)}`;
      // Los comandos de dos bytes (ESC @) y los de tres (ESC a n) se agrupan por
      // familia: el nombre alcanza para leerlo, y los parametros se muestran en hex
      // cuando no son imprimibles (los del cortador son `19 FA`).
      const consumed = ESC_PARAM_COUNT[next] !== undefined ? ESC_PARAM_COUNT[next]! + 2 : 2;
      const params = Array.from(bytes.slice(index + 2, index + consumed)).map(hexIfNotPrintable);
      if (next === 0x74) {
        page = codepageHigh(bytes[index + 2] ?? 2);
      }
      out.push(`<ESC ${name}${params.length > 0 ? ` ${params.join(' ')}` : ''}>`);
      index += consumed;
      continue;
    }

    if (byte === 0x1d && index + 1 < bytes.length) {
      const next = bytes[index + 1]!;
      const name = GS_COMMANDS[next] ?? `0x${next.toString(16)}`;
      // GS ! y GS t son de tres bytes; GS k y GS v llevan datos y son de largo
      // variable, asi que se muestran solo como comando.
      const consumed = GS_PARAM_COUNT[next] !== undefined ? GS_PARAM_COUNT[next]! + 2 : 2;
      const params = Array.from(bytes.slice(index + 2, index + consumed)).map(hexIfNotPrintable);
      out.push(`<GS ${name}${params.length > 0 ? ` ${params.join(' ')}` : ''}>`);
      index += consumed;
      continue;
    }

    if (byte === 0x0a) {
      out.push('\n');
      index += 1;
      continue;
    }

    if (byte === 0x0d) {
      index += 1;
      continue;
    }

    out.push(bytesToChar(byte, page));
    index += 1;
  }

  return out.join('');
}

const ESC_COMMANDS: Record<number, string> = {
  0x40: '@',
  0x45: 'E',
  0x61: 'a',
  0x64: 'd',
  0x70: 'p',
  0x74: 't',
};

/** Cuantos parametros lleva cada comando de `ESC`, para poder mostrarlo entero. */
const ESC_PARAM_COUNT: Record<number, number> = {
  0x45: 1, // E n
  0x61: 1, // a n
  0x64: 1, // d n
  0x70: 3, // p m t1 t2
  0x74: 1, // t n
};

const GS_COMMANDS: Record<number, string> = {
  0x21: '!',
  0x56: 'V',
  0x6b: 'k',
  0x74: 't',
  0x76: 'v',
};

const GS_PARAM_COUNT: Record<number, number> = {
  0x21: 1, // ! n
  0x74: 1, // t n
};

/** Los parametros que no son imprimibles se muestran en hex. */
function hexIfNotPrintable(byte: number): string {
  if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
  return `0x${byte.toString(16).padStart(2, '0')}`;
}

/** Un byte de la pagina de codigos, al caracter que muestra. */
function bytesToChar(byte: number, page: string): string {
  if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
  return page[byte - 0x80] ?? String.fromCharCode(0x3f);
}

/**
 * La mitad alta de la pagina que indica `ESC t n`.
 *
 * Las tres paginas del paquete se resuelven por su numero de protocolo. Una pagina
 * desconocida cae en CP850, que es lo mismo que hace el generador: el volcado y el
 * ticket tienen que contar la misma historia.
 */
function codepageHigh(escT: number): string {
  if (escT === 0) return CP437_REVERSE;
  if (escT === 19) return CP858_REVERSE;
  return CP850_REVERSE;
}

/**
 * Las tres mitades altas, en el orden de los bytes `0x80..0xFF`.
 *
 * Son copias de las tablas de `text.ts`, y estan duplicadas a proposito: el decodificador
 * tiene que ser synchronous y no puede construirlas en cada llamada sin pagar el costo
 * de 384 caracteres por volcado. Si se agrega una pagina, se agrega en los dos lados.
 */
const CP850_REVERSE =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' +
  'áíóúñÑªº¿®¬½¼¡«»' +
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' +
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' +
  '­±‗¾¶§÷¸°¨·¹³²■ ';

const CP437_REVERSE =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const CP858_REVERSE = CP850_REVERSE.replace('ı', '€');
