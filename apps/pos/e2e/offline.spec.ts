import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Criterio de aceptacion de la Fase 1: **la red se puede caer a mitad de una
 * comanda y no se pierde ni se duplica nada.**
 *
 * Es el E2E mas importante del POS y el unico que prueba algo que ningun test de
 * unidades puede: que el mozo, con el cable desconectado, siga vendiendo, y que al
 * reconectar el servidor converja con lo que el POS hizo.
 *
 * ## Que verifica, en orden
 *
 *  1. **Con red**: abrir mesa, agregar items (con y sin modificadores) y comprobar
 *     que la `outbox` se vacia, o sea que los eventos llegaron al servidor.
 *  2. **Sin red**: agregar mas items. La pantalla responde igual de rapido, el
 *     evento queda en la `outbox` de IndexedDB, y el servidor **no** los tiene.
 *  3. **Con red de vuelta**: los pendientes se suben solos y el servidor termina con
 *     los seis items, **una sola vez cada uno**. Ni se perdio lo agregado offline, ni
 *     se duplico lo que ya habia subido.
 *
 * El paso 3 mira el servidor y no la replica local a proposito: al POS le puede
 * gustar lo que muestra, lo que importa es que lo que **cobra** el sistema sea lo
 * que el mozo anotó.
 *
 * ## Por que `setOffline` y no apagar el servidor
 *
 * `page.context().setOffline(true)` corta la red del navegador entero, que es lo que
 * pasa en un local cuyo wifi se cae. Apagar el servidor probaria otra cosa: que el
 * POS aguante un backend lento.
 *
 * ## Requisitos
 *
 * API levantada y base sembrada (`pnpm db:seed`): el POS pide la carta y el plano al
 * entrar, y sin carta no hay nada que vender. `API_URL` y `POS_URL` permiten
 * apuntar a otros hosts.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';

/**
 * Nombres de las dos bases locales del POS.
 *
 * Van hardcodeados y no importados: el E2E corre en Node y no puede importar el
 * modulo de la app (arrastra Dexie y `import.meta.env`). Son los mismos numeros que
 * usan `data/db.ts` y `data/sync.ts`.
 *
 * Son **dos bases distintas y no una**:
 *
 *  - `REPLICA_DB`: carta, salon, comandas locales y cocina. Es la fuente de verdad
 *    durante el turno.
 *  - `OUTBOX_DB`: la cola de eventos del motor de sync. Nunca se sobreescribe con
 *    nada del servidor.
 *
 * Confundirlas seria la forma mas facil de perder una comanda, asi que el test las
 * nombra por separado en vez de tener una constante "la base del POS".
 */
const REPLICA_DB = 'comanda-replica';
const OUTBOX_DB = 'comanda';

/**
 * Huella del aparato de test y PIN del mozo de Cafe Luna, del seed.
 *
 * La huella, y no el id: el POS se anuncia con  antes de
 * tener sesion, asi que lo que llega al servidor es esto.
 */
const FINGERPRINT = process.env.POS_E2E_FINGERPRINT ?? 'e2e-pos-tablet';
const PIN = process.env.POS_E2E_PIN ?? '1357';

/** Producto sin modificadores: entra directo a la comanda, sin selector. */
const FACTURA = 'Factura de manteca';
/** Producto con modificadores: obliga a pasar por el selector. */
const CAPUCHINO = 'Capuchino';

test.describe.configure({ mode: 'serial' });

test('cortar la red a mitad de una comanda no pierde ni duplica items', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await entrarComo(page);

  // --- 1. Con red: abrir mesa y agregar items -------------------------------
  await page.getByRole('button', { name: 'Mesas' }).click();
  await page
    .getByRole('button', { name: /^Mesa \d+/ })
    .first()
    .click();

  await agregar(page, FACTURA);
  await agregar(page, FACTURA);

  // El que tiene modificadores: se elige "Entera" del grupo obligatorio. Si el
  // selector no respetara `minSelect`, el boton de confirmar estaria deshabilitado y
  // el test falla aca, que es justo lo que hay que probar.
  await page.getByRole('button', { name: 'Cafeteria', exact: true }).click();
  await page
    .getByRole('button', { name: new RegExp(escape(CAPUCHINO)) })
    .first()
    .click();
  await page.getByRole('button', { name: 'Entera', exact: true }).click();
  await page.getByRole('button', { name: /^Agregar/ }).click();

  await expect.poll(async () => await itemsActivosLocales(page), { timeout: 15_000 }).toBe(3);

  // Con red, la cola se vacia. Esto tambien comprueba que la sesion esta bien: sin
  // token el POS opera igual, pero nunca sube nada, y el resto del test pasaria sin
  // verificar nada.
  await esperarOutboxVacia(page, 30_000);

  const orderId = await orderIdActivo(page);
  expect(orderId).not.toBeNull();
  await esperarItemsEnServidor(request, orderId!, 3, 30_000);

  // --- 2. Sin red: agregar items sigue funcionando -------------------------
  await page.context().setOffline(true);

  const startedAt = Date.now();
  await agregar(page, 'Helado de dulce de leche', 'Postres');
  await agregar(page, 'Alfajor de chocolate');
  await agregar(page, 'Jugo de naranja', 'Bebidas frias');
  const elapsed = Date.now() - startedAt;

  // El PLAN pide < 100 ms de latencia percibida por accion. El limite del test es
  // tres veces eso porque el E2E corre en una maquina compartida con el servidor de
  // Vite: lo que se mide es que no haya espera de red, no que el navegador sea
  // rapido. Un POS que esperara al push por red no pasaria de aca.
  expect(elapsed).toBeLessThan(3_000);

  await expect.poll(async () => await itemsActivosLocales(page), { timeout: 15_000 }).toBe(6);

  // Los tres items nuevos estan en la `outbox` local...
  const pendientes = await leerOutbox(page);
  expect(pendientes).toHaveLength(3);
  expect(pendientes.every((evento) => evento.type === 'ORDER_ITEM_ADDED')).toBe(true);

  // ...y el servidor sigue teniendo tres. Si ya tuviera seis, el corte de red no
  // seria real y el resto del test probaria nada.
  expect(await itemsEnServidor(request, orderId!)).toHaveLength(3);

  // El POS dice que esta sin conexion, y lo dice en el spine: el mozo mira ahi.
  await expect(page.getByText(/Sin conexión|Sin conexion/)).toBeVisible();

  // --- 3. Con red de vuelta: sube solo, sin duplicados ---------------------
  await page.context().setOffline(false);

  await esperarOutboxVacia(page, 30_000);
  await esperarItemsEnServidor(request, orderId!, 6, 30_000);

  // Cada item aparece **una sola vez**. Este es el criterio de aceptacion.
  const enServidor = await itemsEnServidor(request, orderId!);
  expect(enServidor).toHaveLength(6);
  expect(enServidor.map((item) => item.name).sort()).toEqual(
    [
      FACTURA,
      FACTURA,
      CAPUCHINO,
      'Helado de dulce de leche',
      'Jugo de naranja',
      'Alfajor de chocolate',
    ].sort(),
  );
});

test('reconectar varias veces no duplica la comanda', async ({ page, request }) => {
  // La idempotencia del push es por `event_id`, que es la PK de `sync_events`. Sin
  // eso, "reintentamos hasta que funcione" duplica comandas. Este test corta y
  // reconecta dos veces sobre la misma orden y el servidor tiene que ver la misma
  // comanda, no tres.
  test.setTimeout(180_000);

  await page.goto('/');
  await entrarComo(page);

  await page.getByRole('button', { name: 'Mesas' }).click();
  await page
    .getByRole('button', { name: /^Mesa \d+/ })
    .nth(1)
    .click();

  // El id se lee una sola vez: la comanda no cambia de id entre rondas, y releerlo
  // en cada vueltaeria a leer otra mesa si el mozo abriera una en el medio.
  const orderId = await orderIdActivo(page);
  expect(orderId).not.toBeNull();

  for (const round of [1, 2]) {
    // Se corta la red **antes** de agregar y se restaura **despues** de que el item
    // este escrito en la replica local. Al reves el item se encolaria con la red
    // arriba y subiria en el primer ciclo, y el test no probaria el corte.
    await page.context().setOffline(true);
    await agregar(page, 'Medialunas (x6)');
    await esperarItemsLocales(page, round);
    await page.context().setOffline(false);

    // Recien aca se espera que el servidor lo tenga: es el ciclo de sincronizacion
    // despues de reconectar, que es lo que se quiere probar.
    await esperarItemsEnServidor(request, orderId!, round, 30_000);
    await esperarOutboxVacia(page, 30_000);
  }

  // Dos idem de corte y reconexion sobre la misma comanda, y el servidor tiene una
  // linea por item y no dos.
  await esperarItemsEnServidor(request, orderId!, 2, 30_000);
  expect(await itemsEnServidor(request, orderId!)).toHaveLength(2);
});

// -----------------------------------------------------------------------------
// Sesion
// -----------------------------------------------------------------------------

/**
 * Entra con PIN.
 *
 * El POS descubre su aparato al arrancar contra `POST /devices/resolve`, que es lo
 * unico que puede hacer sin credenciales (no hay sesion todavia, y `GET /devices`
 * la exige). Por eso lo que se siembra es la **huella** en `localStorage`, con la
 * misma llave que usa `data/device.ts`: sembrar el id en IndexedDB ya no alcanza,
 * porque la app resuelve por la red y sobrescribe lo que hubiera.
 *
 * La huella tiene que estar antes de que arranque la app. `addInitScript` corre en
 * cada navegacion y antes de cualquier script de la pagina, que es justo lo que
 * hace falta.
 */
async function entrarComo(page: Page): Promise<void> {
  await page.addInitScript(
    ([fingerprint]) => localStorage.setItem('comanda.fingerprint', fingerprint),
    [FINGERPRINT] as const,
  );
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'Tablet E2E' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Tablet E2E' }).click();
  for (const digit of PIN) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Entrar' }).click();

  // Con el PIN el login va contra la API. Si no entra, el resto del test estaria
  // corriendo sobre la pantalla de login y pasaria sin hacer nada.
  await expect(page.getByRole('button', { name: 'Mesas' })).toBeVisible({ timeout: 30_000 });
}

/**
 * Toca un producto de la carta.
 *
 * Cambia a la categoria del producto antes: la grilla muestra una sola categoria a
 * la vez, y tocar un producto que no esta en pantalla no falla con un error claro
 * sino con un timeout de 30 segundos que no dice que falto cambiar de categoria.
 */
async function agregar(page: Page, nombre: string, categoria = 'Panaderia'): Promise<void> {
  await page.getByRole('button', { name: categoria, exact: true }).click();
  await page
    .getByRole('button', { name: new RegExp(escape(nombre)) })
    .first()
    .click();
}

/** Escapa un nombre para usarlo dentro de una regex. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -----------------------------------------------------------------------------
// Lectura de la replica local
// -----------------------------------------------------------------------------

/**
 * Items activos de la comanda abierta, leidos de IndexedDB.
 *
 * Se lee la base y no el DOM a proposito: el DOM puede mostrar diez cosas distintas
 * segun como se repinte, y lo que hay que verificar es lo que quedo **escrito en
 * disco**. Si el mozo apaga la tablet en este instante, esto es lo que sobrevive.
 */
async function itemsActivosLocales(page: Page): Promise<number> {
  return page.evaluate(
    (dbName) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['orders', 'orderItems'], 'readonly');
          const orders = tx.objectStore('orders').getAll();
          const items = tx.objectStore('orderItems').getAll();
          tx.oncomplete = () => {
            db.close();
            const abierta = (orders.result as Array<{ id: string; status: string }>).find(
              (order) => order.status === 'OPEN' || order.status === 'PEDIDO_CUENTA',
            );
            if (!abierta) {
              resolve(0);
              return;
            }
            resolve(
              (items.result as Array<{ orderId: string; status: string }>).filter(
                (item) => item.orderId === abierta.id && item.status === 'ACTIVE',
              ).length,
            );
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    REPLICA_DB,
  );
}

/** Espera a que la replica local tenga la cantidad esperada de items activos. */
async function esperarItemsLocales(page: Page, expected: number, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => await itemsActivosLocales(page), { timeout, intervals: [200] })
    .toBe(expected);
}

/** Id de la comanda abierta en la replica local. */
async function orderIdActivo(page: Page): Promise<string | null> {
  return page.evaluate(
    (dbName) =>
      new Promise<string | null>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('orders', 'readonly');
          const orders = tx.objectStore('orders').getAll();
          tx.oncomplete = () => {
            db.close();
            const abierta = (orders.result as Array<{ id: string; status: string }>).find(
              (order) => order.status === 'OPEN' || order.status === 'PEDIDO_CUENTA',
            );
            resolve(abierta?.id ?? null);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    REPLICA_DB,
  );
}

/** Eventos esperando envio en la cola local. */
async function leerOutbox(page: Page): Promise<Array<{ type: string; seq: number }>> {
  return page.evaluate(
    (dbName) =>
      new Promise<Array<{ type: string; seq: number }>>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('outbox', 'readonly');
          const pending = tx.objectStore('outbox').index('status').getAll('pending');
          tx.oncomplete = () => {
            db.close();
            resolve(
              (pending.result as Array<{ type: string; seq: number }>).sort(
                (a, b) => a.seq - b.seq,
              ),
            );
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    OUTBOX_DB,
  );
}

/** Espera a que la outbox se vacie: el ciclo de sincronizacion subio todo. */
async function esperarOutboxVacia(page: Page, timeout: number): Promise<void> {
  await expect
    .poll(async () => (await leerOutbox(page)).length, { timeout, intervals: [500] })
    .toBe(0);
}

// -----------------------------------------------------------------------------
// Lectura del servidor
// -----------------------------------------------------------------------------

/** Access token propio del test, para consultar el servidor sin depender del POS. */
let tokenCache: string | null = null;

async function accessToken(request: APIRequestContext): Promise<string> {
  if (tokenCache) return tokenCache;

  // El login por PIN pide el **id** del dispositivo, no la huella: la huella la usa
  // el POS para descubrirse, y recien ahi el servidor devuelve el id con el que se
  // puede autenticar. Por eso el test resuelve primero y recien despues entra.
  const resolved = await request.post(`${API_URL}/devices/resolve`, {
    data: { fingerprint: FINGERPRINT },
  });
  expect(resolved.ok(), `el aparato de test no esta registrado: ${resolved.status()}`).toBe(true);

  const { device } = (await resolved.json()) as { device: { id: string } };

  const response = await request.post(`${API_URL}/auth/login`, {
    data: { method: 'pin', deviceId: device.id, pin: PIN },
  });
  expect(response.ok(), `el login del E2E fallo con ${response.status()}`).toBe(true);

  const body = (await response.json()) as { accessToken: string };
  tokenCache = body.accessToken;
  return tokenCache;
}

/**
 * Items de una comanda, del **servidor**.
 *
 * Se leen del `sync/pull` y no de un endpoint de orders porque el modulo de orders
 * de la API todavia no existe: lo que el servidor guardo son eventos, y un
 * `ORDER_ITEM_ADDED` es exactamente lo que se quiere contar. Ademas, contar eventos
 * duplica la prueba de idempotencia: si el `event_id` esta bien, hay un evento por
 * item, y si el servidor guardo dos filas con el mismo item, eso se ve como dos
 * eventos.
 */
async function itemsEnServidor(
  request: APIRequestContext,
  orderId: string,
): Promise<Array<{ name: string }>> {
  const token = await accessToken(request);
  const response = await request.get(`${API_URL}/sync/pull?since=0&limit=500`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok(), `el pull del E2E fallo con ${response.status()}`).toBe(true);

  const body = (await response.json()) as {
    events: Array<{ type: string; payload: Record<string, unknown> }>;
  };

  return body.events
    .filter((event) => event.type === 'ORDER_ITEM_ADDED' && event.payload.orderId === orderId)
    .map((event) => ({ name: String(event.payload.name ?? '') }));
}

/** Espera a que el servidor tenga la cantidad esperada de items de la comanda. */
async function esperarItemsEnServidor(
  request: APIRequestContext,
  orderId: string,
  expected: number,
  timeout: number,
): Promise<void> {
  await expect
    .poll(async () => (await itemsEnServidor(request, orderId)).length, {
      timeout,
      intervals: [500],
    })
    .toBe(expected);
}
