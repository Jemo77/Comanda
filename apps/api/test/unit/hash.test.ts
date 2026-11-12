import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { PasswordHasher, TokenService, hashToken, safeEqual } from '../../src/common/security/hash';

const PEPPER = 'pepper-de-prueba-de-16-chars';

/** Argon2 barato: los tests verifican correctitud, no costo. */
const fast = { memoryCost: 8_192, timeCost: 1, parallelism: 1 };

function hasher(pepper = PEPPER): PasswordHasher {
  return new PasswordHasher(pepper, fast, fast);
}

describe('PasswordHasher', () => {
  it('hashea y verifica una contrasena', async () => {
    const hash = await hasher().hashPassword('Comanda1234!');
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(hasher().verifyPassword(hash, 'Comanda1234!')).resolves.toBe(true);
    await expect(hasher().verifyPassword(hash, 'OtraCosa123!')).resolves.toBe(false);
  });

  it('el mismo texto produce hashes distintos (sal aleatoria)', async () => {
    const h = hasher();
    expect(await h.hashPassword('Comanda1234!')).not.toBe(await h.hashPassword('Comanda1234!'));
  });

  it('el pepper hace que el mismo PIN tenga hash distinto en otra instalacion', async () => {
    const hash = await hasher().hashPassword('Comanda1234!');
    // Sin pepper, un dump de la base alcanza para un ataque offline trivial.
    await expect(
      hasher('otro-pepper-de-16-chars').verifyPassword(hash, 'Comanda1234!'),
    ).resolves.toBe(false);
  });

  it('rechaza un pepper corto', () => {
    expect(() => new PasswordHasher('corto', fast, fast)).toThrow(/16 caracteres/);
  });
});

describe('PIN', () => {
  it('hashea y verifica', async () => {
    const h = hasher();
    const hash = await h.hashPin('4821', 'user-1');
    await expect(h.verifyPin(hash, '4821', 'user-1')).resolves.toBe(true);
    await expect(h.verifyPin(hash, '4822', 'user-1')).resolves.toBe(false);
  });

  it('el mismo PIN de dos usuarios NO produce el mismo hash', async () => {
    // El userId entra en el material: un PIN adivinado para un usuario no sirve
    // para otro, y dos usuarios con el mismo PIN no son iguales en la tabla.
    const h = hasher();
    const a = await h.hashPin('4821', 'user-1');
    const b = await h.hashPin('4821', 'user-2');
    expect(a).not.toBe(b);
    await expect(h.verifyPin(a, '4821', 'user-2')).resolves.toBe(false);
  });

  it('un hash corrupto devuelve false en vez de romper', async () => {
    const h = hasher();
    await expect(h.verifyPin('no-es-un-hash', '4821', 'u')).resolves.toBe(false);
    await expect(h.verifyPassword('', 'x')).resolves.toBe(false);
  });
});

describe('TokenService', () => {
  it('genera tokens aleatorios de 32 bytes en base64url', () => {
    const tokens = new TokenService(1000);
    const { token } = tokens.generate();
    // 32 bytes -> 43 caracteres en base64url (sin padding).
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('los tokens no se repiten', () => {
    const tokens = new TokenService(1000);
    const generated = new Set(Array.from({ length: 1000 }, () => tokens.generate().token));
    expect(generated.size).toBe(1000);
  });

  it('hashea el token de forma determinista', () => {
    const tokens = new TokenService(1000);
    const { token, hash } = tokens.generate();
    expect(tokens.hash(token)).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('el TTL viene de la configuracion', () => {
    expect(new TokenService(86_400_000).getTtlMs()).toBe(86_400_000);
  });
});

describe('hashToken', () => {
  it('produce el SHA-256 esperado', () => {
    expect(hashToken('token')).toBe(createHash('sha256').update('token').digest('hex'));
    expect(hashToken('token')).toHaveLength(64);
  });
});

describe('safeEqual', () => {
  it('devuelve true para iguales y false para distintos', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('argon2', () => {
  it('usa argon2id por defecto', async () => {
    const hash = await argon2.hash('x', { type: argon2.argon2id, memoryCost: 8192, timeCost: 1 });
    expect(hash).toContain('argon2id');
  });

  it('timingSafeEqual lanza con longitudes distintas', () => {
    expect(() => timingSafeEqual(randomBytes(4), randomBytes(8))).toThrow();
  });
});
