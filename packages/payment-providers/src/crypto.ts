import { createHmac, timingSafeEqual } from 'node:crypto';

/** Comparación en tiempo constante: una firma mal comparada es un oráculo. */
export function hmacHex(
  secret: string,
  payload: string,
  algo: 'sha256' | 'sha512' = 'sha256',
): string {
  return createHmac(algo, secret).update(payload, 'utf8').digest('hex');
}

export function secureEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
