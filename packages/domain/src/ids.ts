/**
 * UUIDv7: identificadores ordenados en el tiempo.
 *
 * Por que no un v4 aleatorio: la outbox offline del POS genera ids del lado del
 * cliente y el servidor los ordena por `received_at`. Con v7 el orden de insercion
 * en el indice coincide con el orden temporal, lo que mantiene el B-tree compacto
 * y hace que "traeme los cambios desde X" sea un range scan en vez de un filtro.
 *
 * Layout (RFC 9562):
 *   48 bits  unix_ts_ms
 *    4 bits  version (0111)
 *   12 bits  rand_a (sub-milisegundo, aqui contador monotono)
 *    2 bits  variant (10)
 *   62 bits  rand_b
 */

/**
 * Entropia por defecto: Web Crypto, disponible en Node 18+ y en todos los
 * navegadores. Se accede por `globalThis` para que el paquete siga siendo
 * isomorfico (el POS lo importa en el navegador).
 */
function defaultEntropy(bytes: Uint8Array): void {
  // Tipo estructural minimo a proposito: el paquete no depende de `lib.dom` ni de
  // `@types/node`, y asi sigue compilando igual en el POS (navegador) y en la API.
  const source = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
  ).crypto;
  const fill = source?.getRandomValues;
  if (!fill) {
    throw new Error('UUIDv7: este runtime no expone crypto.getRandomValues');
  }
  fill.call(source, bytes);
}

/** Mascara de 48 bits para los milisegundos Unix. */
const TIMESTAMP_MASK = 0xffffffffffffn;
const UNSIGNED_64 = 0xffffffffffffffffn;
const RANDOM_12_MASK = 0xfffn;

export type Uuid = string;

export interface UuidV7Options {
  /** Reloj inyectable para tests deterministas. */
  now?: () => number;
  /** Fuente de entropia inyectable para tests. */
  random?: (bytes: Uint8Array) => void;
}

export interface UuidV7Generator {
  generate(): Uuid;
  /** Reinicia el estado monotono. Solo para tests. */
  reset(): void;
}

/**
 * Generador con estado monotono propio.
 *
 * El estado vive en la instancia y no en el modulo a proposito: un reloj de test
 * fijo choca con el reloj real si comparten un unico contador global, y dos
 * generadores independientes (por ejemplo, uno por dispositivo en el POS) no
 * pueden compartir secuencia.
 */
export function createUuidV7Generator(options: UuidV7Options = {}): UuidV7Generator {
  const now = options.now ?? Date.now;
  const random = options.random ?? defaultEntropy;

  let lastMs = -1;
  let sequence = 0;

  function generate(): Uuid {
    let ms = now();
    let seq: number;

    if (ms === lastMs) {
      seq = ++sequence;
    } else if (ms < lastMs) {
      // El reloj retrocedio (NTP, cambio de zona, dispositivo sin bateria).
      // No se reinicia el contador: hacerlo permitiria que dos ids coincidan.
      seq = ++sequence;
      ms = lastMs;
    } else {
      lastMs = ms;
      seq = 0;
    }

    if (seq > Number(RANDOM_12_MASK)) {
      // Se agotaron los 4096 ids del milisegundo. En vez de fallar, se toma
      // prestado un milisegundo del reloj y se sigue contando desde ahi.
      //
      // Lanzar seria peor: un pico de trafico (una importacion masiva de
      // catalogo, o sincronizar una outbox de 10.000 eventos de golpe) dejaria al
      // POS sin poder crear ids. El timestamp queda hasta 4096 microsegundos
      // adelantado respecto del reloj real, irrelevante para eventos de segundos.
      //
      // La secuencia arranca en 1 y no en 0: si arrancara en 0, el siguiente
      // llamada veria el reloj atras, incrementaria a 1 y emitiria de nuevo el id
      // ya usado. En 1 el siguiente valor es 2, siempre por delante.
      lastMs = lastMs + 1;
      sequence = 1;
      seq = 1;
      // `ms` local tambien se corre: si se usara el valor viejo del reloj, el id
      // emitido llevaria el ms anterior con la secuencia nueva y colisionaria.
      ms = lastMs;
    }

    const bytes = new Uint8Array(16);
    random(bytes);

    // 48 bits de timestamp, big endian.
    const timestamp = BigInt(ms) & TIMESTAMP_MASK;
    for (let i = 0; i < 6; i++) {
      bytes[i] = Number((timestamp >> BigInt(8 * (5 - i))) & 0xffn);
    }

    // version 7 (0111) + 12 bits de rand_a.
    bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
    bytes[7] = seq & 0xff;

    // variant (10) en los dos bits altos del byte 8.
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    return formatBytes(bytes);
  }

  return {
    generate,
    reset() {
      lastMs = -1;
      sequence = 0;
    },
  };
}

const defaultGenerator = createUuidV7Generator();

/** UUIDv7 del generador compartido del proceso. */
export function uuidv7(): Uuid {
  return defaultGenerator.generate();
}

/** Convierte 16 bytes a la forma canonica (8-4-4-4-12, minusculas). */
function formatBytes(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Convierte un UUIDv7 a su timestamp Unix en milisegundos. */
export function timestampFromUuidV7(id: Uuid): number {
  const compact = id.replace(/-/g, '');
  const ms = Number.parseInt(compact.slice(0, 12), 16);
  if (Number.isNaN(ms)) {
    throw new Error(`UUIDv7 invalido: ${id}`);
  }
  return ms;
}

/** Ordena por timestamp del UUIDv7. Util para colas de eventos ordenadas. */
export function compareUuidV7(a: Uuid, b: Uuid): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Hash estable del UUID a un valor en [0,1).
 * Lo usa el motor de promociones para decidir cupones aleatorios: tiene que dar
 * el mismo resultado en el POS offline y en el servidor, asi que no puede usar
 * Math.random ni depender de crypto.
 */
export function uuidHashToUnitInterval(id: Uuid): number {
  let hash = 0n;
  for (let i = id.length - 1; i >= 0; i--) {
    hash = ((hash << 5n) - hash + BigInt(id.charCodeAt(i))) & UNSIGNED_64;
  }
  return Number(hash >> 11n) / Number(1n << 53n);
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verifica que un string sea un UUID con version 7. */
export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

/** Verifica que un string sea un UUID de cualquier version. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
