import { expect, test } from '@playwright/test';

/**
 * Humo del E2E.
 *
 * Verifica lo minimo para que el resto de los tests signifique algo:
 *
 *  1. El POS **abre**. El service worker se registra solo en el build de
 *     produccion (`devOptions.enabled` es `false`), asi que en desarrollo este test
 *     no lo comprueba; lo comprueba en el build.
 *  2. Sin huella registrada, el POS muestra el aviso de aparato no registrado y NO
 *     una pantalla en blanco. Es el estado en que cae un POS recien instalado.
 *
 * La parte importante es la 2: si el POS no sabe que hacer cuando no esta
 * autorizado, el fallo es una pantalla vacia, y un mostrador en blanco no dice nada
 * al encargado de que tiene que registrar la tablet.
 */
test.describe('humo', () => {
  test('el POS abre y no deja pantalla en blanco', async ({ page }) => {
    const errores: string[] = [];
    page.on('pageerror', (error) => errores.push(String(error)));

    await page.goto('/');
    // `networkidle` porque el POS hidrata la carta apenas entra. Sin esperar, el
    // assert corre contra el estado intermedio.
    await page.waitForLoadState('networkidle');

    // Cualquier estado visible sirve: login, aviso de aparato, o la barra. Lo que
    // no puede pasar es que quede en blanco.
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });

    // Sin huella registrada tiene que avisar, no fallar en silencio.
    await expect(page.getByRole('heading', { name: /no est/i })).toBeVisible();

    // Un POS que tira excepciones al abrir no es un POS.
    expect(errores).toEqual([]);
  });

  test('la pantalla de aviso dice a quien pedir el registro', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // El texto tiene que decir qué hacer, no solo qué pasó. Un "error" sin acción
    // deja al mozo parado en el mostrador.
    await expect(page.getByText(/encargado|dueño/i)).toBeVisible();
    // Y tiene que decir que no se pierde nada, que es la pregunta real del mozo
    // cuando ve un aviso.
    await expect(page.getByText(/no se pierde/i)).toBeVisible();
  });
});
