import { defineConfig } from 'vitest/config';

/**
 * El storefront no tiene tests de unidad propios a propósito: la lógica
 * que importa (menú, carrito, cuenta, pagos, slots) vive en la API y se
 * prueba en el E2E HTTP de `apps/api/test/e2e/storefront-flow.e2e.test.ts`,
 * que levanta la API compilada y pega por HTTP. Esta app es un cliente
 * delgado: sin precios ni reglas en el código, no hay nada que testear
 * acá que no sea ya un contrato probado del otro lado.
 *
 * `passWithNoTests` evita que `pnpm test` (turbo) falle por no haber
 * archivos: el verde del producto lo da el e2e, no este paquete.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
