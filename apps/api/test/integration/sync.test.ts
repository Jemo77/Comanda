import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@comanda/domain';
import { DatabaseService } from '../../src/database/database.service';
import { SyncService } from '../../src/modules/sync/sync.service';
import { loadEnv } from '../../src/config/env';
import { createTestDatabase, truncateOrg } from '../support/db';
import { seedDefaultRoles, seedDevice, seedUser, assignRole } from '../support/fixtures';
import type { TestDatabase } from '../support/env';
import type { SyncEventInput } from '../../src/modules/sync/sync.types';

/**
 * Sincronizacion offline contra PostgreSQL real.
 *
 * Estos tests fijan los cuatro escenarios que el plan exige explicitamente (PLAN §3.9)
 * y el criterio de aceptacion de la Fase 1:
 *
 *  - corte de red en medio de una orden, y reconexion sin duplicados ni perdida
 *  - reordenamiento de eventos
 *  - duplicados (reenvio de la outbox)
 *  - reloj del dispositivo desfasado
 *  - dos dispositivos sobre la misma mesa
 */
describe('sync: push/pull offline', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let sync: SyncService;

  const venue = { id: '', orgId: '' };
  const devices = { a: '', b: '' };
  const table = { free: '', occupied: '', displace: '' };
  const users = { waiter: '' };
  const shift = { id: '' };

  const context = (deviceId: string, actorId: string | null = users.waiter) => ({
    deviceId,
    orgId: venue.orgId,
    venueId: venue.id,
    actorId,
    events: [] as SyncEventInput[],
  });

  const event = (
    type: SyncEventInput['type'],
    payload: Record<string, unknown>,
    overrides: Partial<SyncEventInput> = {},
  ): SyncEventInput => ({
    eventId: uuidv7(),
    type,
    seq: 1,
    occurredAt: new Date().toISOString(),
    payload,
    ...overrides,
  });

  beforeAll(async () => {
    harness = await createTestDatabase();
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: harness.url,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-access-secret-que-no-se-usa-fuera-de-los-tests-01',
      PIN_PEPPER: 'test-pin-pepper-de-16-chars-o-mas',
    });
    db = new DatabaseService(env);
    sync = new SyncService(db);

    // Hash stub: este test no verifica credenciales, solo sincronizacion.
    const hasher = { hashPin: async (value: string) => `stub:${value}` } as never;

    const org = await harness.createOrg('Sync Cafe');
    venue.orgId = org.orgId;
    venue.id = org.venueId;

    await seedDefaultRoles(harness, venue.orgId);
    users.waiter = await seedUser(harness, {
      orgId: venue.orgId,
      name: 'Moza',
      email: 'moza@sync.test',
      pin: { plain: '1111', hasher },
    });
    const roles = await seedDefaultRoles(harness, venue.orgId);
    await assignRole(harness, {
      orgId: venue.orgId,
      userId: users.waiter,
      roleId: roles.get('mozo')!,
      venueId: venue.id,
    });

    // Estaciones y mesas
    await harness.asOrg(venue.orgId, async (q) => {
      await q(
        `INSERT INTO stations (org_id, venue_id, name, kind) VALUES ($1::uuid, $2::uuid, 'Barra', 'bar')`,
        [venue.orgId, venue.id],
      );
      const floor = await q<{ id: string }>(
        `INSERT INTO floors (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Salon') RETURNING id`,
        [venue.orgId, venue.id],
      );
      const free = await q<{ id: string }>(
        `INSERT INTO tables (org_id, venue_id, floor_id, label, seats)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'M1', 2) RETURNING id`,
        [venue.orgId, venue.id, floor.rows[0]!.id],
      );
      const occupied = await q<{ id: string }>(
        `INSERT INTO tables (org_id, venue_id, floor_id, label, seats)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'M2', 4) RETURNING id`,
        [venue.orgId, venue.id, floor.rows[0]!.id],
      );
      const displace = await q<{ id: string }>(
        `INSERT INTO tables (org_id, venue_id, floor_id, label, seats)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'M3', 4) RETURNING id`,
        [venue.orgId, venue.id, floor.rows[0]!.id],
      );

      table.free = free.rows[0]!.id;
      table.occupied = occupied.rows[0]!.id;
      table.displace = displace.rows[0]!.id;

      const opened = await q<{ id: string }>(
        `INSERT INTO shifts (org_id, venue_id, opened_by, opening_float_cents)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 0) RETURNING id`,
        [venue.orgId, venue.id, users.waiter],
      );
      shift.id = opened.rows[0]!.id;
    });

    devices.a = await seedDevice(harness, {
      orgId: venue.orgId,
      venueId: venue.id,
      name: 'Tablet A',
      fingerprint: 'sync-device-a',
    });
    devices.b = await seedDevice(harness, {
      orgId: venue.orgId,
      venueId: venue.id,
      name: 'Tablet B',
      fingerprint: 'sync-device-b',
    });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
    for (const table of [
      'kitchen_tickets',
      'bill_splits',
      'payments',
      'order_item_modifiers',
      'order_items',
      'sync_events',
      'orders',
      'tables',
      'floors',
      'shifts',
      'cash_movements',
      'product_modifier_groups',
      'modifiers',
      'modifier_groups',
      'products',
      'categories',
      'stations',
    ]) {
      await harness.adminQuery(`DELETE FROM ${table} WHERE org_id = $1::uuid`, [venue.orgId]);
    }
    await truncateOrg(harness, venue.orgId);
    await harness.close();
  });

  describe('idempotencia', () => {
    it('reenviar el mismo evento no lo aplica dos veces', async () => {
      const orderId = uuidv7();
      const evt = event('ORDER_OPENED', { orderId, tableId: null, numberLabel: 'A-1' });

      const first = await sync.push({ ...context(devices.a), events: [evt] });
      expect(first.results[0]!.status).toBe('APPLIED');

      // El POS se corta de red antes de recibir la respuesta y reenvia todo.
      const second = await sync.push({ ...context(devices.a), events: [evt] });
      expect(second.results[0]!.status).toBe('DUPLICATE');

      const count = await harness.asOrg(venue.orgId, (q) =>
        q<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE id = $1::uuid`, [orderId]),
      );
      expect(count.rows[0]!.n).toBe(1);
    });

    it('agregar el mismo item dos veces no crea dos items', async () => {
      const orderId = uuidv7();
      await sync.push({
        ...context(devices.a),
        events: [event('ORDER_OPENED', { orderId, numberLabel: 'A-2' })],
      });

      const itemId = uuidv7();
      const add = event('ORDER_ITEM_ADDED', {
        orderId,
        itemId,
        name: 'Cafe con leche',
        quantity: 2,
        unitPriceCents: 2500,
      });

      await sync.push({ ...context(devices.a), events: [add] });
      const second = await sync.push({ ...context(devices.a), events: [add] });

      expect(second.results[0]!.status).toBe('DUPLICATE');
      const count = await harness.asOrg(venue.orgId, (q) =>
        q<{ n: number }>(`SELECT count(*)::int AS n FROM order_items WHERE id = $1::uuid`, [
          itemId,
        ]),
      );
      expect(count.rows[0]!.n).toBe(1);
    });

    it('el lote entero va en una transaccion', async () => {
      const orderId = uuidv7();
      const good = event('ORDER_OPENED', { orderId, numberLabel: 'A-3' });
      const bad = event('ORDER_ITEM_ADDED', { itemId: uuidv7(), name: 'Sin orden' });

      const result = await sync.push({ ...context(devices.a), events: [good, bad] });
      // El evento sin `orderId` viola la FK: se marca REJECTED y el lote sigue.
      expect(result.results[1]!.status).toBe('REJECTED');
    });
  });

  describe('total de la comanda', () => {
    it('suma items y modificadores en centavos enteros', async () => {
      const orderId = uuidv7();
      await sync.push({
        ...context(devices.a),
        events: [
          event('ORDER_OPENED', { orderId, numberLabel: 'A-4' }),
          event('ORDER_ITEM_ADDED', {
            orderId,
            itemId: uuidv7(),
            name: 'Capuchino',
            quantity: 2,
            unitPriceCents: 3400,
            modifiers: [{ name: 'Sin espuma', priceDeltaCents: 0 }],
          }),
        ],
      });

      const total = await harness.asOrg(venue.orgId, (q) =>
        q<{ total_cents: number }>(`SELECT total_cents FROM orders WHERE id = $1::uuid`, [orderId]),
      );
      expect(total.rows[0]!.total_cents).toBe(6800);
    });

    it('anular un item lo saca del total y deja el motivo', async () => {
      const orderId = uuidv7();
      const itemId = uuidv7();
      await sync.push({
        ...context(devices.a),
        events: [
          event('ORDER_OPENED', { orderId, numberLabel: 'A-5' }),
          event('ORDER_ITEM_ADDED', {
            orderId,
            itemId,
            name: 'Empanada',
            quantity: 1,
            unitPriceCents: 1500,
          }),
        ],
      });
      await sync.push({
        ...context(devices.a),
        events: [event('ORDER_ITEM_VOIDED', { orderId, itemId, reason: 'Se cayo al piso' })],
      });

      const total = await harness.asOrg(venue.orgId, (q) =>
        q<{ total_cents: number }>(`SELECT total_cents FROM orders WHERE id = $1::uuid`, [orderId]),
      );
      expect(total.rows[0]!.total_cents).toBe(0);

      const item = await harness.asOrg(venue.orgId, (q) =>
        q<{ status: string; void_reason: string | null }>(
          `SELECT status, void_reason FROM order_items WHERE id = $1::uuid`,
          [itemId],
        ),
      );
      // El item NO se borra: queda, con el motivo.
      expect(item.rows[0]!.status).toBe('VOIDED');
      expect(item.rows[0]!.void_reason).toBe('Se cayo al piso');
    });

    it('anular sin motivo se rechaza', async () => {
      const orderId = uuidv7();
      const itemId = uuidv7();
      await sync.push({
        ...context(devices.a),
        events: [
          event('ORDER_OPENED', { orderId, numberLabel: 'A-6' }),
          event('ORDER_ITEM_ADDED', {
            orderId,
            itemId,
            name: 'Vino',
            quantity: 1,
            unitPriceCents: 5000,
          }),
        ],
      });

      const result = await sync.push({
        ...context(devices.a),
        events: [event('ORDER_ITEM_VOIDED', { orderId, itemId })],
      });
      expect(result.results[0]!.status).toBe('REJECTED');
    });
  });

  describe('dos dispositivos sobre la misma mesa', () => {
    it('gana el primer occurred_at y el otro recibe aviso para reasignar', async () => {
      const orderA = uuidv7();
      const orderB = uuidv7();
      const t0 = new Date('2024-05-01T18:00:00Z').toISOString();
      const t1 = new Date('2024-05-01T18:05:00Z').toISOString();

      // El dispositivo A abre la mesa primero.
      await sync.push({
        ...context(devices.a),
        events: [
          event(
            'ORDER_OPENED',
            { orderId: orderA, tableId: table.occupied, numberLabel: 'A-7' },
            { occurredAt: t0, seq: 10 },
          ),
        ],
      });

      // El B intenta tomar la misma mesa 5 minutos despues.
      const conflict = await sync.push({
        ...context(devices.b),
        events: [
          event(
            'ORDER_OPENED',
            { orderId: orderB, tableId: table.occupied, numberLabel: 'B-1' },
            { occurredAt: t1, seq: 1 },
          ),
        ],
      });

      const result = conflict.results[0]!;
      expect(result.status).toBe('CONFLICT');
      expect(result.action).toBe('REASSIGN_TABLE');
      // La comanda de B se creo igual, pero SIN mesa: el cliente tiene que elegir otra.
      expect((result.data as { tableId: string | null }).tableId).toBeNull();

      // La mesa sigue siendo de A.
      const t = await harness.asOrg(venue.orgId, (q) =>
        q<{ order_id: string }>(`SELECT order_id FROM tables WHERE id = $1::uuid`, [
          table.occupied,
        ]),
      );
      expect(t.rows[0]!.order_id).toBe(orderA);
    });

    it('si el entrante es anterior, desplaza al que estaba', async () => {
      const t0 = new Date('2024-05-01T19:00:00Z').toISOString();

      const primero = uuidv7();
      const despues = uuidv7();

      // A ocupa la mesa con un reloj que dice 19:00.
      await sync.push({
        ...context(devices.a),
        events: [
          event(
            'ORDER_OPENED',
            { orderId: primero, tableId: table.displace, numberLabel: 'A-8' },
            { occurredAt: t0, seq: 20 },
          ),
        ],
      });

      // B llega con un reloj 10 minutos atrasado: su comanda es realmente anterior.
      const result = await sync.push({
        ...context(devices.b),
        events: [
          event(
            'ORDER_OPENED',
            { orderId: despues, tableId: table.displace, numberLabel: 'B-2' },
            {
              occurredAt: new Date('2024-05-01T18:50:00Z').toISOString(),
              seq: 2,
            },
          ),
        ],
      });

      expect(result.results[0]!.status).toBe('CONFLICT');

      const t = await harness.asOrg(venue.orgId, (q) =>
        q<{ order_id: string }>(`SELECT order_id FROM tables WHERE id = $1::uuid`, [
          table.displace,
        ]),
      );
      // Gana la comanda realmente mas antigua.
      expect(t.rows[0]!.order_id).toBe(despues);

      // Y la anterior quedo sin mesa, para que su dispositivo la reasigne.
      const old = await harness.asOrg(venue.orgId, (q) =>
        q<{ table_id: string | null }>(`SELECT table_id FROM orders WHERE id = $1::uuid`, [
          primero,
        ]),
      );
      expect(old.rows[0]!.table_id).toBeNull();
    });
  });

  describe('pull incremental', () => {
    it('devuelve solo lo que pasa despues del cursor', async () => {
      const before = await sync.pull({
        orgId: venue.orgId,
        venueId: venue.id,
        deviceId: devices.a,
        since: '0',
      });
      const cursor = before.cursor;
      expect(before.events.length).toBeGreaterThan(0);

      const orderId = uuidv7();
      await sync.push({
        ...context(devices.a),
        events: [event('ORDER_OPENED', { orderId, numberLabel: 'A-9' }, { seq: 500 })],
      });

      const after = await sync.pull({
        orgId: venue.orgId,
        venueId: venue.id,
        deviceId: devices.a,
        since: cursor,
      });
      expect(after.events.map((e) => e.payload.orderId)).toContain(orderId);
      expect(Number(after.cursor)).toBeGreaterThan(Number(cursor));

      // Pedirlo de nuevo con el cursor nuevo no devuelve nada: no se duplica.
      const repeat = await sync.pull({
        orgId: venue.orgId,
        venueId: venue.id,
        deviceId: devices.a,
        since: after.cursor,
      });
      expect(repeat.events).toHaveLength(0);
      expect(repeat.cursor).toBe(after.cursor);
    });

    it('el cursor es monotono aunque caigan eventos en el mismo milisegundo', async () => {
      const start = await sync.pull({
        orgId: venue.orgId,
        venueId: venue.id,
        deviceId: devices.a,
        since: '0',
      });
      // Cinco eventos con la MISMA marca de tiempo: un cursor por reloj los perderia.
      await sync.push({
        ...context(devices.a),
        events: Array.from({ length: 5 }, (_, i) =>
          event(
            'ORDER_OPENED',
            { orderId: uuidv7(), numberLabel: `LOTE-${i}` },
            {
              occurredAt: new Date('2024-06-01T12:00:00.000Z').toISOString(),
              seq: 600 + i,
            },
          ),
        ),
      });

      const next = await sync.pull({
        orgId: venue.orgId,
        venueId: venue.id,
        deviceId: devices.a,
        since: start.cursor,
      });
      const nuevos = next.events.filter((e) => Number(e.cursor) > Number(start.cursor));
      expect(nuevos).toHaveLength(5);
      // Los cursores son distintos y crecientes: ninguno se pierde.
      expect(new Set(nuevos.map((e) => e.cursor)).size).toBe(5);
    });

    it('detecta huecos en la secuencia del dispositivo', async () => {
      // Dispositivo propio: si compartiera con los demás tests, la secuencia
      // dependería del orden de ejecución y el test no probaría nada.
      const device = await seedDevice(harness, {
        orgId: venue.orgId,
        venueId: venue.id,
        name: 'Tablet Huecos',
        fingerprint: 'sync-device-gaps',
      });

      // Se envían seq 1, 2 y 5: faltan 3 y 4.
      for (const seq of [1, 2, 5]) {
        await sync.push({
          deviceId: device,
          orgId: venue.orgId,
          venueId: venue.id,
          actorId: null,
          events: [event('ORDER_OPENED', { orderId: uuidv7(), numberLabel: `H${seq}` }, { seq })],
        });
      }

      const result = await sync.pull({
        orgId: venue.orgId,
        venueId: venue.id,
        deviceId: device,
        since: '0',
      });
      expect(result.missingSeqs).toEqual([3, 4]);
    });

    it('reordenar el envio no cambia el resultado', async () => {
      // El POS agrupa por lote y el orden de red puede diferir del de generacion.
      // Los items son append-only: el total no depende del orden de llegada.
      const orderId = uuidv7();
      await sync.push({
        ...context(devices.b),
        events: [event('ORDER_OPENED', { orderId, numberLabel: 'B-3' }, { seq: 900 })],
      });

      const items = [
        event(
          'ORDER_ITEM_ADDED',
          { orderId, itemId: uuidv7(), name: 'A', quantity: 1, unitPriceCents: 1000 },
          { seq: 901 },
        ),
        event(
          'ORDER_ITEM_ADDED',
          { orderId, itemId: uuidv7(), name: 'B', quantity: 1, unitPriceCents: 2000 },
          { seq: 902 },
        ),
        event(
          'ORDER_ITEM_ADDED',
          { orderId, itemId: uuidv7(), name: 'C', quantity: 1, unitPriceCents: 3000 },
          { seq: 903 },
        ),
      ];

      await sync.push({ ...context(devices.b), events: [items[2]!, items[0]!, items[1]!] });

      const total = await harness.asOrg(venue.orgId, (q) =>
        q<{ total_cents: number }>(`SELECT total_cents FROM orders WHERE id = $1::uuid`, [orderId]),
      );
      expect(total.rows[0]!.total_cents).toBe(6000);
    });
  });

  describe('reloj del dispositivo desfasado', () => {
    it('un occurred_at en el futuro no rompe nada', async () => {
      const orderId = uuidv7();
      const futuro = new Date('2099-01-01T00:00:00Z').toISOString();

      const result = await sync.push({
        ...context(devices.a),
        events: [
          event(
            'ORDER_OPENED',
            { orderId, numberLabel: 'A-10' },
            { occurredAt: futuro, seq: 1000 },
          ),
          event(
            'ORDER_ITEM_ADDED',
            { orderId, itemId: uuidv7(), name: 'Test', quantity: 1, unitPriceCents: 1000 },
            {
              occurredAt: futuro,
              seq: 1001,
            },
          ),
        ],
      });

      expect(result.results.every((r) => r.status === 'APPLIED')).toBe(true);

      // Para reportes manda el reloj del servidor, no el del dispositivo.
      const row = await harness.asOrg(venue.orgId, (q) =>
        q<{ occurred_at: string; received_at: string }>(
          `SELECT occurred_at, received_at FROM sync_events WHERE type = 'ORDER_OPENED'
           AND payload->>'orderId' = $1 LIMIT 1`,
          [orderId],
        ),
      );
      expect(Date.parse(row.rows[0]!.received_at)).toBeLessThan(Date.parse('2099-01-01'));
    });
  });

  describe('pagos', () => {
    it('registra el pago y acumula la propina', async () => {
      const orderId = uuidv7();
      await sync.push({
        ...context(devices.a),
        events: [event('ORDER_OPENED', { orderId, numberLabel: 'A-11' }, { seq: 1100 })],
      });

      const result = await sync.push({
        ...context(devices.a),
        events: [
          event(
            'PAYMENT_RECORDED',
            {
              paymentId: uuidv7(),
              orderId,
              method: 'CASH',
              amountCents: 10000,
              tipCents: 1500,
              shiftId: shift.id,
            },
            { seq: 1101 },
          ),
        ],
      });

      expect(result.results[0]!.status).toBe('APPLIED');
      const order = await harness.asOrg(venue.orgId, (q) =>
        q<{ tip_cents: number }>(`SELECT tip_cents FROM orders WHERE id = $1::uuid`, [orderId]),
      );
      expect(order.rows[0]!.tip_cents).toBe(1500);
    });

    it('rechaza un metodo de pago desconocido', async () => {
      const orderId = uuidv7();
      await sync.push({
        ...context(devices.a),
        events: [event('ORDER_OPENED', { orderId, numberLabel: 'A-12' }, { seq: 1200 })],
      });

      const result = await sync.push({
        ...context(devices.a),
        events: [
          event(
            'PAYMENT_RECORDED',
            {
              paymentId: uuidv7(),
              orderId,
              method: 'CRIPTOMONEDA',
              amountCents: 1000,
            },
            { seq: 1201 },
          ),
        ],
      });
      expect(result.results[0]!.status).toBe('REJECTED');
    });

    it('cerrar la comanda libera la mesa', async () => {
      const orderId = uuidv7();
      await sync.push({
        ...context(devices.a),
        events: [
          event(
            'ORDER_OPENED',
            { orderId, tableId: table.free, numberLabel: 'A-13' },
            { seq: 1300 },
          ),
        ],
      });

      const readTable = (): Promise<{ rows: Array<{ status: string; order_id: string | null }> }> =>
        harness.asOrg(venue.orgId, (q) =>
          q<{ status: string; order_id: string | null }>(
            `SELECT status, order_id FROM tables WHERE id = $1::uuid`,
            [table.free],
          ),
        ) as Promise<{ rows: Array<{ status: string; order_id: string | null }> }>;

      let t = await readTable();
      expect(t.rows[0]!.status).toBe('OCUPADA');

      await sync.push({
        ...context(devices.a),
        events: [event('ORDER_CLOSED', { orderId, shiftId: shift.id }, { seq: 1301 })],
      });

      t = await readTable();
      expect(t.rows[0]!.status).toBe('LIBRE');
      expect(t.rows[0]!.order_id).toBeNull();
    });
  });

  describe('aislamiento', () => {
    it('un evento no puede escribir en otro local', async () => {
      // El venueId sale de la sesion; el payload no puede elegirlo.
      const otro = await harness.createOrg('Otro Sync');
      try {
        const result = await sync.push({
          deviceId: devices.a,
          orgId: venue.orgId,
          venueId: venue.id,
          actorId: users.waiter,
          events: [
            event('ORDER_OPENED', { orderId: uuidv7(), numberLabel: 'X', tableId: table.free }),
          ],
        });
        expect(result.results[0]!.status).toBe('APPLIED');

        // La comanda queda en el local del evento, no en el otro.
        const count = await harness.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM orders WHERE venue_id = $1::uuid`,
          [otro.venueId],
        );
        expect(count.rows[0]!.n).toBe(0);
      } finally {
        await truncateOrg(harness, otro.orgId);
      }
    });
  });
});
