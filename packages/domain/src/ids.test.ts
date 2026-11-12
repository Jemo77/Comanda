import { describe, expect, it } from 'vitest';
import {
  compareUuidV7,
  createUuidV7Generator,
  isUuid,
  isUuidV7,
  timestampFromUuidV7,
  uuidHashToUnitInterval,
  uuidv7,
} from './ids';

describe('uuidv7', () => {
  it('genera ids con version 7 y variant RFC 9562', () => {
    const id = uuidv7();
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('codifica el timestamp en los primeros 48 bits', () => {
    const now = 1_700_000_000_123;
    const gen = createUuidV7Generator({ now: () => now });
    const id = gen.generate();
    expect(timestampFromUuidV7(id)).toBe(now);
    // Los 48 bits de timestamp son los 12 hexadecimales iniciales.
    const expectedPrefix = Math.floor(now / 2 ** 16)
      .toString(16)
      .padStart(8, '0');
    expect(id.slice(0, 8)).toBe(expectedPrefix);
  });

  it('es monotono dentro del mismo milisegundo', () => {
    const gen = createUuidV7Generator({ now: () => 1_700_000_000_000 });
    const ids = Array.from({ length: 100 }, () => gen.generate());
    expect(new Set(ids).size).toBe(100);
    // El orden lexicografico coincide con el de generacion: es el motivo de usar v7.
    expect([...ids].sort(compareUuidV7)).toEqual(ids);
  });

  it('no rompe la monotonia si el reloj retrocede', () => {
    const times = [1000, 1000, 900, 900, 1000];
    let i = 0;
    const gen = createUuidV7Generator({ now: () => times[i++]! });
    const ids = times.map(() => gen.generate());
    expect(new Set(ids).size).toBe(times.length);
    expect([...ids].sort(compareUuidV7)).toEqual(ids);
  });

  it('dos generadores no comparten secuencia', () => {
    const a = createUuidV7Generator({ now: () => 5 });
    const b = createUuidV7Generator({ now: () => 5 });
    expect(a.generate()).not.toBe(b.generate());
  });

  it('toma prestado un milisegundo en vez de fallar cuando se agota el secuencia', () => {
    // Lanzar dejaria al POS sin poder crear ids ante un pico de trafico.
    const gen = createUuidV7Generator({ now: () => 42 });
    const ids = Array.from({ length: 10_000 }, () => gen.generate());

    expect(new Set(ids).size).toBe(10_000);
    expect([...ids].sort(compareUuidV7)).toEqual(ids);
    // El ultimo id quedo 2 milisegundos adelante del reloj inyectado.
    expect(timestampFromUuidV7(ids[10_000 - 1]!)).toBe(44);
  });

  it('reset() devuelve el generador al estado inicial', () => {
    const gen = createUuidV7Generator({ now: () => 77 });
    gen.generate();
    gen.generate();
    gen.reset();
    // Tras el reset vuelve a arrancar desde el reloj inyectado (77 ms = 0x4d).
    expect(gen.generate()).toMatch(/^00000000-004d-7000-[89ab]/);
  });

  it('acepta entropia inyectada para tests deterministas', () => {
    const gen = createUuidV7Generator({
      now: () => 1,
      random: (bytes) => bytes.fill(0xab),
    });
    const id = gen.generate();
    expect(id).toMatch(/^00000000-0001-7000-[89ab]/);
    expect(id.endsWith('abababababab')).toBe(true);
    expect(isUuid(id)).toBe(true);
  });

  it('genera miles de ids unicos con el generador compartido', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => uuidv7()));
    expect(ids.size).toBe(20_000);
  });
});

describe('timestampFromUuidV7', () => {
  it('rechaza un id invalido', () => {
    expect(() => timestampFromUuidV7('no-es-uuid')).toThrow(/invalido/);
  });
});

describe('isUuid', () => {
  it('distingue v7 de otras versiones', () => {
    expect(isUuidV7('01890a5d-ac96-774b-bcce-b302099a8057')).toBe(true);
    expect(isUuidV7('01890a5d-ac96-174b-bcce-b302099a8057')).toBe(false);
    expect(isUuid('01890a5d-ac96-474b-bcce-b302099a8057')).toBe(true);
    expect(isUuid('basura')).toBe(false);
  });
});

describe('uuidHashToUnitInterval', () => {
  it('devuelve siempre un valor en [0,1)', () => {
    for (let i = 0; i < 200; i++) {
      const v = uuidHashToUnitInterval(uuidv7());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('es deterministico y reparte de forma uniforme', () => {
    const id = uuidv7();
    expect(uuidHashToUnitInterval(id)).toBe(uuidHashToUnitInterval(id));

    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 5000; i++) {
      buckets[Math.floor(uuidHashToUnitInterval(uuidv7()) * 10)]! += 1;
    }
    // Uniformidad aproximada: ningun decil debe desviarse mas de un 50%.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(150);
      expect(count).toBeLessThan(850);
    }
  });
});
