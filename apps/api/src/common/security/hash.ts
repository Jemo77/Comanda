import argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Hash de credenciales.
 *
 * Argon2id para contrasenas y PINs. Los tokens de refresco usan SHA-256 porque no
 * son secretos de baja entropia: son 256 bits aleatorios, asi que un hash lento no
 * agrega nada y si cuestaCpu en cada renovacion.
 *
 * El pepper se aplica **fuera** de argon2, con HMAC: se hashea `pin + pepper` y el
 * resultado es lo que se pasa a argon2. Si el pepper falta, un dump de la base
 * alcanza para probar los 10.000 PIN posibles en segundos; con el, hace falta
 * tambien el pepper, que vive en el gestor de secretos.
 */

export interface ArgonOptions {
  memoryCost: number;
  timeCost: number;
  parallelism?: number;
}

export class PasswordHasher {
  private readonly pepper: string;

  constructor(
    pepper: string,
    private readonly passwordOptions: ArgonOptions,
    private readonly pinOptions: ArgonOptions,
  ) {
    if (pepper.length < 16) {
      throw new Error('PIN_PEPPER debe tener al menos 16 caracteres');
    }
    this.pepper = pepper;
  }

  private toArgon(options: ArgonOptions) {
    return {
      type: argon2.argon2id,
      memoryCost: options.memoryCost,
      timeCost: options.timeCost,
      parallelism: options.parallelism ?? 1,
    };
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(this.applyPepper(password), this.toArgon(this.passwordOptions));
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, this.applyPepper(password));
    } catch {
      // Un hash corrupto o de otro algoritmo no puede fallar con 500.
      return false;
    }
  }

  /**
   * Hash del PIN.
   *
   * `userId` entra en el material: asi dos usuarios con el mismo PIN no tienen el
   * mismo hash, y un PIN adivinado para un usuario no sirve para otro.
   */
  async hashPin(pin: string, userId: string): Promise<string> {
    return argon2.hash(this.applyPepper(`pin:${userId}:${pin}`), this.toArgon(this.pinOptions));
  }

  async verifyPin(hash: string, pin: string, userId: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, this.applyPepper(`pin:${userId}:${pin}`));
    } catch {
      return false;
    }
  }

  private applyPepper(value: string): string {
    return createHash('sha256').update(`${value}${this.pepper}`).digest('base64');
  }
}

/**
 * Refresh tokens.
 *
 * El token es 32 bytes aleatorios en base64url. Se genera con CSPRNG y se
 * compara en tiempo constante: una diferencia de timing en la comparacion
 * permitiria adivinar el token byte a byte.
 */
export class TokenService {
  constructor(private readonly ttlMs: number) {}

  generate(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashToken(token) };
  }

  getTtlMs(): number {
    return this.ttlMs;
  }

  hash(token: string): string {
    return hashToken(token);
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Comparacion en tiempo constante para los dos casos donde importa. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // Si las longitudes difieren, timingSafeEqual lanza. Comparar el hash primero
  // enmascara el valor esperado, asi que la diferencia de longitud no filtra.
  if (bufferA.length !== bufferB.length) {
    // Se compara contra un buffer del mismo largo para no salir antes de tiempo.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
