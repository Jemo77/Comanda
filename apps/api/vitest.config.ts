import { defineConfig } from 'vitest/config';

/**
 * Tests de la API.
 *
 * Dos suites:
 *
 *  - unitarios: bajo `src` y `test/unit`, sin base de datos.
 *  - de integracion: bajo `test/integration`, contra un PostgreSQL real.
 *
 * La RLS es una funcion del motor; ningun mock la reproduce, asi que un doble de
 * test daria un falso verde.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // La suite de integracion comparte una base. Correr en paralelo haria que dos
    // tests compitan por el mismo contexto de tenant.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/**/*.module.ts', 'src/**/schema/**', 'src/openapi/**'],
    },
  },
});
