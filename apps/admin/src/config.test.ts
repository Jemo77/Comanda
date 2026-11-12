// Lee archivos del disco: necesita Node, no el `import.meta.url` de jsdom (que es
// una URL http y `fileURLToPath` la rechaza).
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERMISSION_KEYS } from '@comanda/domain';

/**
 * El admin no comparte el presupuesto de bundle del POS: no tiene que cargar con
 * internet de local ni arrancar en una tablet. Lo que si comparte es la regla de que
 * la API nunca se cachea.
 */
const CONFIG = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');

describe('configuracion del admin', () => {
  it('la API nunca se cachea', () => {
    expect(CONFIG).toContain('NetworkOnly');
  });

  it('no impone orientacion apaisada como el POS', () => {
    // El admin se mira un rato, en notebook o en el celular del dueño.
    expect(CONFIG).not.toContain("orientation: 'landscape'");
  });

  it('el design system entra como codigo fuente, no pre-empaquetado', () => {
    expect(CONFIG).toContain("exclude: ['@comanda/ui']");
  });
});

describe('superficie de permisos', () => {
  it('el catalogo es el mismo que el del backend', () => {
    // Si el admin mostrara un catalogo propio, la UI prometería permisos que el
    // servidor no tiene, y el botón aparecería habilitado sin funcionar.
    expect(PERMISSION_KEYS.length).toBeGreaterThan(50);
    expect(PERMISSION_KEYS).toContain('order.item.void');
    expect(PERMISSION_KEYS).toContain('bill.discount');
  });

  it('no duplica claves', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });
});
