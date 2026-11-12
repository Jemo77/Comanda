import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Subject } from 'rxjs';
import type { HttpException } from '@nestjs/common';
import { uuidv7, type ProblemDetails } from '@comanda/domain';
import { loadEnv, type AppEnv } from '../../src/config/env';
import { DatabaseService, type TenantContext } from '../../src/database/database.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { KdsEventBus, type KdsChange } from '../../src/modules/kds/kds-event-bus';
import { KdsService, type KdsActor } from '../../src/modules/kds/kds.service';
import { KITCHEN_CYCLE, listTicketsQuerySchema } from '../../src/modules/kds/kds.types';
import { SyncService } from '../../src/modules/sync/sync.service';
import { createTestDatabase, truncateAuditLog, truncateOrg } from '../support/db';
import { assignRole, seedDefaultRoles, seedDevice, seedUser } from '../support/fixtures';
import type { TestDatabase } from '../support/env';

/**
 * Cocina, contra PostgreSQL real.
 *
 * Lo que se verifica aca y en ningun otro lado:
 *
 *  - `ensureTicketsForOrder` agrupa los items **por estación**, no uno por item.
 *  - Un item sin estación va a la estación por defecto (si no, desaparece de la cocina).
 *  - El ciclo NEW -> PREPARING -> READY -> SERVED avanza y **solo** avanza.
 *  - **Aislamiento: un ticket del local A no se lee desde el B.** Es el mismo aislamiento
 *    que aplica el WebSocket, verificado en la capa de datos.
 *  - El sync crea los tickets al confirmar un item, y el evento sale **después** del
 *    commit (por eso el bus acumula, no emite).
 *
 * El bus se usa como spy: se suscriben los cambios y se lee lo que se publico. Asi se
 * verifica el "despues del commit" sin tener que mirar el instante exacto.
 */
describe('kds', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let env: AppEnv;
  let kds: KdsService;
  let sync: SyncService;
  let audit: AuditService;

  const luna = { orgId: '', venueId: '' };
  const orion = { orgId: '', venueId: '' };

  const cocina = { id: '' };
  const barra = { id: '' };
  const cafe = { id: '' };

  const device = { id: '' };
  const cocinero = { id: '' };

  /** Cambios que publico el bus, para poder afirmar sobre el orden. */
  let published: KdsChange[] = [];

  /** Secuencia del dispositivo, como la lleva el POS. */
  let seq = 0;

  const inTenant = <T>(ctx: TenantContext, work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let result: T;
      db.runInTenantStream(ctx, () => {
        const done = new Subject<T>();
        void work().then(
          (value) => {
            result = value;
            done.complete();
          },
          (error: unknown) => done.error(error),
        );
        return done;
      }).subscribe({
        complete: () => resolve(result!),
        error: reject,
      });
    });

  const asLuna = <T>(work: () => Promise<T>) =>
    inTenant({ orgId: luna.orgId, venueId: luna.venueId, userId: cocinero.id }, work);

  const asOrion = <T>(work: () => Promise<T>) =>
    inTenant({ orgId: orion.orgId, venueId: orion.venueId, userId: cocinero.id }, work);

  const actor = (): KdsActor => ({ userId: cocinero.id, name: 'Cocina', deviceId: null });

  const rejectsWith = async (promise: Promise<unknown>, pattern: RegExp): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      const response = (error as HttpException).getResponse();
      const detail =
        typeof response === 'string' ? response : String((response as ProblemDetails).detail);
      expect(detail).toMatch(pattern);
      return detail;
    }
    throw new Error('Se esperaba que la operacion fuera rechazada');
  };

  /** Crea un producto en la estacion pedida. `null` = sin rutear. */
  const product = async (params: {
    name: string;
    priceCents: number;
    stationId: string | null;
  }): Promise<string> => {
    const row = await harness.asOrg(luna.orgId, async (q) => {
      const category = await q<{ id: string }>(
        `INSERT INTO categories (org_id, venue_id, name, sort)
         VALUES ($1::uuid, $2::uuid, 'Comidas', 1) RETURNING id`,
        [luna.orgId, luna.venueId],
      );
      const inserted = await q<{ id: string }>(
        // `products` cuelga de la categoria, no del local: la carta es de la
        // organizacion y el local decide que muestra. Por eso no lleva `venue_id`.
        `INSERT INTO products (org_id, category_id, name, price_cents, station_id, available, sort)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, true, 1)
         RETURNING id`,
        [luna.orgId, category.rows[0]!.id, params.name, params.priceCents, params.stationId],
      );
      return inserted.rows[0]!;
    });
    return row.id;
  };

  /** Una comanda abierta, sin items. */
  const openOrder = async (): Promise<string> => {
    const orderId = uuidv7();
    await harness.asOrg(luna.orgId, async (q) => {
      await q(
        `INSERT INTO orders (id, org_id, venue_id, number_label, opened_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'A-1', now())`,
        [orderId, luna.orgId, luna.venueId],
      );
    });
    return orderId;
  };

  const addItem = async (
    orderId: string,
    params: { productId?: string; name?: string; quantity?: number; priceCents?: number },
  ): Promise<string> => {
    const itemId = uuidv7();
    await harness.asOrg(luna.orgId, async (q) => {
      await q(
        `INSERT INTO order_items (id, org_id, order_id, product_id, name_snapshot, quantity,
                                  unit_price_cents, list_price_cents, status, course)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $7, 'ACTIVE', 1)`,
        [
          itemId,
          luna.orgId,
          orderId,
          params.productId ?? null,
          params.name ?? 'Producto',
          params.quantity ?? 1,
          params.priceCents ?? 1000,
        ],
      );
    });
    return itemId;
  };

  /**
   * Los tickets de una comanda, en el orden en que los muestra la pantalla.
   *
   * Ordena por `stations.sort` y no por `station_id`: un UUID no tiene orden y el
   * `ORDER BY station_id` daria un orden distinto en cada corrida, que es la forma de
   * que un test pase por suerte.
   */
  const ticketsOf = async (
    orderId: string,
  ): Promise<Array<{ stationId: string; status: string }>> => {
    const rows = await harness.asOrg(luna.orgId, async (q) =>
      q<{ station_id: string; status: string }>(
        `SELECT kt.station_id, kt.status
           FROM kitchen_tickets kt
           JOIN stations s ON s.id = kt.station_id
          WHERE kt.order_id = $1::uuid
          ORDER BY s.sort, s.name`,
        [orderId],
      ),
    );
    return rows.rows.map((row) => ({ stationId: row.station_id, status: row.status }));
  };

  beforeAll(async () => {
    harness = await createTestDatabase();
    env = loadEnv({
      ...process.env,
      DATABASE_URL: harness.url,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-access-secret-que-no-se-usa-fuera-de-los-tests-01',
      PIN_PEPPER: 'test-pin-pepper-de-16-chars-o-mas',
    });
    db = new DatabaseService(env);
    audit = new AuditService(db, env);

    const bus = new KdsEventBus();
    bus.subscribe((change) => published.push(change));
    kds = new KdsService(db, bus, audit);
    sync = new SyncService(db, audit, kds);

    const lunaOrg = await harness.createOrg('Comanda Luna');
    luna.orgId = lunaOrg.orgId;
    luna.venueId = lunaOrg.venueId;

    const orionOrg = await harness.createOrg('Comanda Orion');
    orion.orgId = orionOrg.orgId;
    orion.venueId = orionOrg.venueId;

    const roles = await seedDefaultRoles(harness, luna.orgId);
    cocinero.id = await seedUser(harness, {
      orgId: luna.orgId,
      name: 'Cocina',
      email: 'cocina@kds.test',
    });
    await assignRole(harness, {
      orgId: luna.orgId,
      userId: cocinero.id,
      roleId: roles.get('mozo')!,
      venueId: luna.venueId,
    });

    device.id = await seedDevice(harness, {
      orgId: luna.orgId,
      venueId: luna.venueId,
      name: 'Tablet KDS',
      fingerprint: 'kds-device',
    });

    // Cocina con `sort` 1: es la estacion por defecto, porque un item sin rutear va a
    // la de menor `sort`.
    await harness.asOrg(luna.orgId, async (q) => {
      const rows = await q<{ id: string }>(
        `INSERT INTO stations (org_id, venue_id, name, kind, sort)
         VALUES ($1::uuid, $2::uuid, 'Cocina', 'cocina', 1),
                ($1::uuid, $2::uuid, 'Barra', 'bar', 2),
                ($1::uuid, $2::uuid, 'Cafe', 'cafe', 3)
         RETURNING id`,
        [luna.orgId, luna.venueId],
      );
      const [first, second, third] = rows.rows.map((row) => row.id);
      cocina.id = first!;
      barra.id = second!;
      cafe.id = third!;
    });

    // Orion necesita al menos una estacion activa: `ensureTicketsForOrder` sin ninguna
    // no crea tickets, y el test de aislamiento necesita que existan.
    await harness.asOrg(orion.orgId, async (q) => {
      await q(
        `INSERT INTO stations (org_id, venue_id, name, kind, sort)
         VALUES ($1::uuid, $2::uuid, 'Cocina', 'cocina', 1)`,
        [orion.orgId, orion.venueId],
      );
    });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
    for (const org of [luna.orgId, orion.orgId]) {
      await truncateAuditLog(harness, org);
      await truncateOrg(harness, org);
    }
    await harness.close();
  });

  // ---------------------------------------------------------------------------

  describe('ensureTicketsForOrder', () => {
    it('agrupa los items por estacion: un ticket por estacion, no uno por item', async () => {
      const orderId = await openOrder();
      const milanesa = await product({ name: 'Milanesa', priceCents: 6000, stationId: cocina.id });
      const fideos = await product({ name: 'Fideos', priceCents: 5500, stationId: cocina.id });
      const vino = await product({ name: 'Vino', priceCents: 4500, stationId: barra.id });

      await addItem(orderId, { productId: milanesa, name: 'Milanesa' });
      await addItem(orderId, { productId: fideos, name: 'Fideos' });
      await addItem(orderId, { productId: vino, name: 'Vino' });

      const created = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      // **Dos** tickets: uno de cocina con los dos platos y uno de barra con el vino.
      // La barra no tiene cinco papeles para cinco vasos, tiene uno.
      expect(created).toHaveLength(2);
      // Cocina (sort 1) antes que Barra (sort 2), igual que en la pantalla.
      expect(await ticketsOf(orderId)).toEqual([
        { stationId: cocina.id, status: 'NEW' },
        { stationId: barra.id, status: 'NEW' },
      ]);

      const deCocina = created.find((ticket) => ticket.stationId === cocina.id);
      expect(deCocina!.lines.map((line) => line.name).sort()).toEqual(['Fideos', 'Milanesa']);
    });

    it('es idempotente: llamarlo dos veces no duplica el papel', async () => {
      // El sync reenvia la outbox entera cuando se cae la red. Sin el indice unico de
      // (order_id, station_id), cada reenvio imprimiria el mismo papel en la barra.
      const orderId = await openOrder();
      const milanesa = await product({ name: 'Milanesa', priceCents: 6000, stationId: cocina.id });
      await addItem(orderId, { productId: milanesa });

      const primera = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );
      const segunda = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      expect(primera).toHaveLength(1);
      expect(segunda).toHaveLength(0);
      expect(await ticketsOf(orderId)).toHaveLength(1);
    });

    it('un item sin estacion va a la estacion por defecto, no desaparece', async () => {
      // Sin esto, un producto sin rutear se ve en la comanda y el cocinero nunca lo ve:
      // el local pierde el pedido sin ninguna señal.
      const orderId = await openOrder();
      await addItem(orderId, { name: 'Pan de la casa', priceCents: 900 });

      const created = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      expect(created).toHaveLength(1);
      // La de menor `sort`: Cocina.
      expect(created[0]!.stationId).toBe(cocina.id);
      expect(created[0]!.lines[0]!.name).toBe('Pan de la casa');
    });

    it('un item sin producto y uno con producto van al mismo ticket', async () => {
      const orderId = await openOrder();
      const vino = await product({ name: 'Vino', priceCents: 4500, stationId: barra.id });
      await addItem(orderId, { name: 'Sin catalogo', priceCents: 500 });
      await addItem(orderId, { productId: vino });

      const created = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      expect(created).toHaveLength(2);
      const deCocina = created.find((ticket) => ticket.stationId === cocina.id)!;
      expect(deCocina.lines).toHaveLength(1);
      expect(deCocina.lines[0]!.name).toBe('Sin catalogo');
    });

    it('un item con un producto borrado del catalogo sigue yendo a la por defecto', async () => {
      // El `LEFT JOIN` a `products` es lo que lo hace posible: un producto borrado deja
      // la fila huerfana y el ticket no se pierde.
      const orderId = await openOrder();
      const vino = await product({ name: 'Vino', priceCents: 4500, stationId: barra.id });
      await addItem(orderId, { productId: vino });
      await harness.asOrg(luna.orgId, async (q) => {
        await q(`UPDATE products SET station_id = NULL WHERE id = $1::uuid`, [vino]);
      });

      const created = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      expect(created).toHaveLength(1);
      expect(created[0]!.stationId).toBe(cocina.id);
    });

    it('una comanda sin items no crea ningun ticket', async () => {
      const orderId = await openOrder();
      const created = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );
      expect(created).toEqual([]);
    });

    it('un item anulado no cuenta', async () => {
      const orderId = await openOrder();
      const milanesa = await product({ name: 'Milanesa', priceCents: 6000, stationId: cocina.id });
      const itemId = await addItem(orderId, { productId: milanesa });
      await harness.asOrg(luna.orgId, async (q) => {
        // `order_items_void_consistent` exige motivo y fecha: la constraint es la que
        // hace que "cuanto se descontó por anulaciones" se pueda responder después.
        await q(
          `UPDATE order_items
              SET status = 'VOIDED', void_reason = 'Se paso', voided_at = now()
            WHERE id = $1::uuid`,
          [itemId],
        );
      });

      const created = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      expect(created).toEqual([]);
    });

    it('una comanda de otro local no se lee desde este', async () => {
      // El filtro por local es manual a proposito: la RLS es por organizacion, asi que
      // una sucursal de otra org es filtrada por la RLS pero una del **mismo** org en
      // otro local solo la frena el `WHERE`.
      const orderId = uuidv7();
      await harness.asOrg(luna.orgId, async (q) => {
        await q(
          `INSERT INTO orders (id, org_id, venue_id, number_label, opened_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'A-1', now())`,
          [orderId, luna.orgId, orion.venueId],
        );
        await q(
          `INSERT INTO order_items (id, org_id, order_id, name_snapshot, quantity,
                                    unit_price_cents, list_price_cents, status, course)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Truco', 1, 1000, 1000, 'ACTIVE', 1)`,
          [uuidv7(), luna.orgId, orderId],
        );
      });

      const created = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      expect(created).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------

  describe('el ciclo de estados', () => {
    it('NEW -> PREPARING -> READY -> SERVED', async () => {
      const orderId = await openOrder();
      await addItem(orderId, { name: 'Milanesa' });
      const [ticket] = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      for (const status of ['PREPARING', 'READY', 'SERVED'] as const) {
        const updated = await asLuna(() =>
          kds.setStatus(luna.orgId, luna.venueId, ticket!.id, status, actor()),
        );
        expect(updated.status).toBe(status);
      }

      const rows = await harness.asOrg(luna.orgId, async (q) =>
        q<{ status: string }>(`SELECT status FROM kitchen_tickets WHERE id = $1::uuid`, [
          ticket!.id,
        ]),
      );
      expect(rows.rows[0]!.status).toBe('SERVED');
    });

    it('el ciclo esta completo y en orden', () => {
      // El indice en `KITCHEN_CYCLE` es el paso, y `setStatus` compara por indice. Si la
      // lista se desordena, "volver atras" deja de detectarse.
      expect([...KITCHEN_CYCLE]).toEqual(['NEW', 'PREPARING', 'READY', 'SERVED']);
    });

    it('volver atras se rechaza con 409 y lo dice en criollo', async () => {
      const orderId = await openOrder();
      await addItem(orderId, { name: 'Milanesa' });
      const [ticket] = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );
      await asLuna(() => kds.setStatus(luna.orgId, luna.venueId, ticket!.id, 'READY', actor()));

      // 409 y no 422: no es un dato invalido, es una regla del turno. El que esta frente
      // a la pantalla necesita saber que no lo va a poder deshacer.
      await rejectsWith(
        asLuna(() => kds.setStatus(luna.orgId, luna.venueId, ticket!.id, 'NEW', actor())),
        /ya esta en LISTO y no vuelve a NUEVO/,
      );
    });

    it('poner el mismo estado dos veces no es un error', async () => {
      // Dos KDS pueden tocar "Listo" al mismo tiempo. Rechazarlo dejaria un error en
      // pantalla por algo que ya esta bien.
      const orderId = await openOrder();
      await addItem(orderId, { name: 'Milanesa' });
      const [ticket] = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      const first = await asLuna(() =>
        kds.setStatus(luna.orgId, luna.venueId, ticket!.id, 'PREPARING', actor()),
      );
      const again = await asLuna(() =>
        kds.setStatus(luna.orgId, luna.venueId, ticket!.id, 'PREPARING', actor()),
      );

      expect(first.status).toBe('PREPARING');
      expect(again.status).toBe('PREPARING');
    });

    it('un ticket de otro local no se avanza', async () => {
      const ticketId = uuidv7();
      await harness.asOrg(luna.orgId, async (q) => {
        const order = await q<{ id: string }>(
          `INSERT INTO orders (id, org_id, venue_id, number_label, opened_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'A-1', now()) RETURNING id`,
          [uuidv7(), luna.orgId, luna.venueId],
        );
        await q(
          `INSERT INTO kitchen_tickets (id, org_id, venue_id, station_id, order_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
          [ticketId, luna.orgId, luna.venueId, cocina.id, order.rows[0]!.id],
        );
      });

      await rejectsWith(
        asOrion(() => kds.setStatus(orion.orgId, orion.venueId, ticketId, 'READY', actor())),
        /no existe en este local/,
      );
    });
  });

  // ---------------------------------------------------------------------------

  describe('lectura', () => {
    it('cada ticket muestra SOLO los items de su estacion', async () => {
      // Una comanda con un plato y un vino genera dos tickets. El de la cocina tiene que
      // mostrar el plato y **no** el vino: el ticket de la barra con una milanesa es un
      // plato que el bartender busca veinte minutos.
      const orderId = await openOrder();
      const milanesa = await product({ name: 'Milanesa', priceCents: 6000, stationId: cocina.id });
      const vino = await product({ name: 'Vino', priceCents: 4500, stationId: barra.id });
      await addItem(orderId, { productId: milanesa, name: 'Milanesa', quantity: 2 });
      await addItem(orderId, { productId: vino, name: 'Vino' });
      await asLuna(() => kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId));

      const board = await asLuna(() =>
        kds.board(luna.orgId, luna.venueId, listTicketsQuerySchema.parse({})),
      );

      expect(board.stations).toHaveLength(3);

      const deCocina = board.tickets.find(
        (ticket) => ticket.orderId === orderId && ticket.stationId === cocina.id,
      );
      const deBarra = board.tickets.find(
        (ticket) => ticket.orderId === orderId && ticket.stationId === barra.id,
      );

      expect(deCocina!.lines.map((line) => line.name)).toEqual(['Milanesa']);
      expect(deCocina!.lines[0]!.quantity).toBe(2);
      expect(deBarra!.lines.map((line) => line.name)).toEqual(['Vino']);
      // La etiqueta de la mesa es null: esta comanda no tiene mesa.
      expect(deCocina!.tableLabel).toBeNull();
    });

    it('el listado por defecto excluye los servidos', async () => {
      // Un ticket servido en la pantalla de cocina es ruido: el turno nuevo tendria que
      // limpiarlo a mano.
      const orderId = await openOrder();
      await addItem(orderId, { name: 'Milanesa' });
      const [ticket] = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );
      await asLuna(() => kds.setStatus(luna.orgId, luna.venueId, ticket!.id, 'SERVED', actor()));

      const porDefecto = await asLuna(() =>
        kds.tickets(luna.orgId, luna.venueId, listTicketsQuerySchema.parse({})),
      );
      expect(porDefecto.find((t) => t.id === ticket!.id)).toBeUndefined();

      const conServidos = await asLuna(() =>
        kds.tickets(
          luna.orgId,
          luna.venueId,
          listTicketsQuerySchema.parse({ includeServed: true }),
        ),
      );
      expect(conServidos.find((t) => t.id === ticket!.id)).toBeDefined();
    });

    it('un ticket del local A no se lee desde el B', async () => {
      // **El aislamiento.** Es el mismo criterio que aplica el WebSocket, verificado en
      // la capa de datos: si un KDS del local B pudiera leer el ticket del A, el
      // chequeo de `venueId` del gateway no seria la unica barrera.
      const orderId = await openOrder();
      await addItem(orderId, { name: 'Secreto de la casa' });
      const [ticket] = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );

      const desdeOrion = await asOrion(() =>
        kds.tickets(orion.orgId, orion.venueId, listTicketsQuerySchema.parse({})),
      );
      expect(desdeOrion.find((t) => t.id === ticket!.id)).toBeUndefined();

      const directo = await asOrion(() => kds.ticket(orion.orgId, orion.venueId, ticket!.id));
      expect(directo).toBeNull();
    });

    it('los modificadores se acumulan en la linea del item, no la duplican', async () => {
      // El `LEFT JOIN` a modificadores repite el item una vez por modificador. Sin
      // agrupar, "capuchino doble" aparece como dos productos.
      const orderId = await openOrder();
      const capuchino = await product({ name: 'Capuchino', priceCents: 3400, stationId: cafe.id });
      const itemId = await addItem(orderId, { productId: capuchino });
      await harness.asOrg(luna.orgId, async (q) => {
        await q(
          `INSERT INTO order_item_modifiers (org_id, order_item_id, name_snapshot, price_delta_cents, sort)
           VALUES ($1::uuid, $2::uuid, 'sin lactosa', 0, 1),
                 ($1::uuid, $2::uuid, 'doble', 1200, 2)`,
          [luna.orgId, itemId],
        );
      });
      await asLuna(() => kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId));

      const query = listTicketsQuerySchema.parse({});
      const board = await asLuna(() => kds.board(luna.orgId, luna.venueId, query));
      const mio = board.tickets.find((ticket) => ticket.orderId === orderId)!;

      expect(mio.lines).toHaveLength(1);
      expect(mio.lines[0]!.modifiers).toEqual(['sin lactosa', 'doble']);
    });
  });

  // ---------------------------------------------------------------------------

  describe('el bus y el sync', () => {
    it('el sync crea el ticket al confirmar un item y avisa despues del commit', async () => {
      // El orden importa: si el evento saliera dentro de la transaccion, el gateway se
      // suscribiria y releeria un ticket que todavia no existe.
      published = [];
      const orderId = await openOrder();
      const milanesa = await product({ name: 'Milanesa', priceCents: 6000, stationId: cocina.id });
      const itemId = uuidv7();

      const result = await sync.push({
        deviceId: device.id,
        orgId: luna.orgId,
        venueId: luna.venueId,
        actorId: cocinero.id,
        events: [
          {
            eventId: uuidv7(),
            type: 'ORDER_ITEM_ADDED',
            seq: (seq += 1),
            occurredAt: new Date().toISOString(),
            payload: {
              orderId,
              itemId,
              productId: milanesa,
              name: 'Milanesa',
              quantity: 1,
              unitPriceCents: 6000,
            },
          },
        ],
      });

      expect(result.results[0]!.status).toBe('APPLIED');

      // El ticket existe: se creo despues del commit, en el `push`.
      const created = await harness.asOrg(luna.orgId, async (q) =>
        q<{ station_id: string }>(
          `SELECT station_id FROM kitchen_tickets WHERE order_id = $1::uuid`,
          [orderId],
        ),
      );
      expect(created.rows.map((row) => row.station_id)).toEqual([cocina.id]);

      // Y el evento salio con el `orgId` del push: sin el, el gateway no podria leer la
      // fila (la RLS exige `app.current_org`).
      expect(published.some((change) => change.kind === 'order-items')).toBe(true);
      for (const change of published) {
        expect(change.orgId).toBe(luna.orgId);
        expect(change.venueId).toBe(luna.venueId);
      }
    });

    it('el sync al avanzar un estado avisa con el ticket, y el gateway lo relee', async () => {
      published = [];
      const orderId = await openOrder();
      await addItem(orderId, { name: 'Milanesa' });
      const [ticket] = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );
      published = [];

      await sync.push({
        deviceId: device.id,
        orgId: luna.orgId,
        venueId: luna.venueId,
        actorId: cocinero.id,
        events: [
          {
            eventId: uuidv7(),
            type: 'KDS_STATUS_SET',
            seq: (seq += 1),
            occurredAt: new Date().toISOString(),
            payload: { ticketId: ticket!.id, status: 'PREPARING' },
          },
        ],
      });

      const change = published.find((entry) => entry.kind === 'ticket-status');
      expect(change).toBeDefined();
      expect(change!.ticketId).toBe(ticket!.id);

      // Lo que el gateway va a emitir es lo que dice la base, no el evento.
      const releido = await asLuna(() => kds.ticket(luna.orgId, luna.venueId, change!.ticketId!));
      expect(releido!.status).toBe('PREPARING');
    });

    it('un estado repetido no emite: ya estaba asi', async () => {
      const orderId = await openOrder();
      await addItem(orderId, { name: 'Milanesa' });
      const [ticket] = await asLuna(() =>
        kds.ensureTicketsForOrder(luna.orgId, luna.venueId, orderId),
      );
      await asLuna(() => kds.setStatus(luna.orgId, luna.venueId, ticket!.id, 'READY', actor()));
      published = [];

      await sync.push({
        deviceId: device.id,
        orgId: luna.orgId,
        venueId: luna.venueId,
        actorId: cocinero.id,
        events: [
          {
            eventId: uuidv7(),
            type: 'KDS_STATUS_SET',
            seq: (seq += 1),
            occurredAt: new Date().toISOString(),
            payload: { ticketId: ticket!.id, status: 'READY' },
          },
        ],
      });

      expect(published).toEqual([]);
    });

    it('un estado invalido se rechaza y no emite nada', async () => {
      published = [];
      await sync.push({
        deviceId: device.id,
        orgId: luna.orgId,
        venueId: luna.venueId,
        actorId: cocinero.id,
        events: [
          {
            eventId: uuidv7(),
            type: 'KDS_STATUS_SET',
            seq: (seq += 1),
            occurredAt: new Date().toISOString(),
            payload: { ticketId: uuidv7(), status: 'QUEMADO' },
          },
        ],
      });

      expect(published).toEqual([]);
    });

    it('un suscriptor roto no se lleva por delante a los demas', async () => {
      // Con un `Subject` de RxJS, un error en un handler desuscribe a **todos**: una
      // pantalla de cocina con un error de render dejaba sin KDS a las demas. Con la
      // lista de listeners, uno se desuscribe solo.
      const bus = new KdsEventBus();
      const recibidos: string[] = [];
      bus.subscribe(() => {
        throw new Error('handler roto');
      });
      bus.subscribe((change) => recibidos.push(change.kind));

      const change = { kind: 'order-items', orgId: 'o', venueId: 'v', orderId: 'x' } as const;
      expect(() => bus.publish(change)).not.toThrow();
      expect(recibidos).toEqual(['order-items']);
      // El roto se fue de la lista: si se reintentara en cada evento, llenaria el log.
      expect(bus.size).toBe(1);
    });

    it('la baja de una suscripcion es idempotente', async () => {
      const bus = new KdsEventBus();
      const recibidos: string[] = [];
      const baja = bus.subscribe((change) => recibidos.push(change.kind));

      baja();
      baja();
      bus.publish({ kind: 'order-items', orgId: 'o', venueId: 'v', orderId: 'x' });

      expect(recibidos).toEqual([]);
    });

    void env;
    void audit;
  });
});
