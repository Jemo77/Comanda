import { defineConfig } from 'vitest/config';

/**
 * Tests del paquete ESC/POS.
 *
 * Node, no jsdom: el paquete es isomorfico y los tests corre en la mitad que no es
 * navegador (los drivers de USB y de TCP usan APIs de Node). Los bytes que se
 * comparan son los mismos en los dos runtimes, asi que la cobertura del render
 * verificar el WebUSB la tiene que hacer el POS.
 *
 * Sin umbral de cobertura a proposito: los bytes exactos se prueban con `toEqual`
 * sobre fixtures, no con snapshots, asi que la cobertura de líneas no dice nada que
 * el test no diga ya. Ver la nota de `ticket.test.ts`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/drivers/index.ts', 'src/**/*.test.ts'],
    },
  },
});
