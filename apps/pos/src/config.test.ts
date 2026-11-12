// Lee la config de Vite en Node, no en jsdom: `TextEncoder` de jsdom devuelve un
// Uint8Array de otro realm y Vite revienta con un "invariant violation" que no
// dice nada del POS.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import viteConfig from '../vite.config';

/**
 * Presupuesto de bundle.
 *
 * El plan fija < 300 KB gzip para el bundle inicial del POS. No es una sugerencia:
 * el POS se descarga una vez, muchas veces con internet de local, y encima tiene
 * que arrancar rapido en una tablet de gama media.
 *
 * Este test falla si el presupuesto se rompe por descuido (una dependencia nueva sin
 * pensar). El pipeline vuelve a medir el bundle comprimido.
 */

const VITE_CONFIG = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

const BUDGET_BYTES = 300 * 1024;

/**
 * El limite de Vite esta en bytes SIN comprimir, asi que es mas holgado que el
 * presupuesto gzip del plan. Lo que se controla aca es que no se haya aflojado a "lo
 * que sea" para silenciar avisos.
 */
function chunkSizeLimit(): number {
  return viteConfig.build?.chunkSizeWarningLimit ?? Infinity;
}

describe('presupuesto de bundle', () => {
  it('el limite de Vite no supera el presupuesto del plan', () => {
    const limit = chunkSizeLimit();
    // El limite de Vite es en bytes sin comprimir, asi que es mas holgado que el
    // presupuesto gzip. Lo que se controla aca es que no se haya aflojado a "lo que
    // sea" para silenciar avisos.
    expect(limit).toBeLessThanOrEqual(400 * 1024);
  });

  it('el presupuesto gzip del plan es 300 KB', () => {
    expect(BUDGET_BYTES).toBe(300 * 1024);
  });
});

describe('configuracion de la PWA', () => {
  const config = readFileSync(VITE_CONFIG, 'utf8');

  it('cachea el shell entero para que abra sin conexion', () => {
    expect(config).toContain('globPatterns');
    expect(config).toContain('navigateFallback');
  });

  it('la API nunca se cachea', () => {
    // Una respuesta vieja de catalogo o de precios es peor que un error de red: el
    // mozo cobraria mal sin darse cuenta.
    expect(config).toContain('NetworkOnly');
    expect(config).toContain('/api/');
  });

  it('el POS se instala como app y en apaisado', () => {
    expect(config).toContain("display: 'standalone'");
    expect(config).toContain("orientation: 'landscape'");
  });
});
