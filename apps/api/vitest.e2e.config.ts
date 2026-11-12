import { defineConfig } from 'vitest/config';

/**
 * E2E HTTP de la API: levanta el `AppModule` de verdad (Nest completo, con
 * RLS, middleware y guards) contra un PostgreSQL real y pega con supertest.
 *
 * Es la única capa donde se prueba el contrato entero: ruta pública con token
 * QR → pedido → webhook de pago verificado e idempotente → cierre desde el POS
 * por sync → acreditación de puntos.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
