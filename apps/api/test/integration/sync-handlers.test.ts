import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@comanda/domain';
import { DatabaseService } from '../../src/database/database.service';
import { SyncService } from '../../src/modules/sync/sync.service';
import { loadEnv } from '../../src/config/env';
import { createTestDatabase } from '../support/db';
import { assignRole, seedDefaultRoles, seedDevice, seedUser } from '../support/fixtures';
import type { TestDatabase } from '../support/env';
import type { SyncEventInput, SyncEventType } from '../../src/modules/sync/sync.types';

/**
 * Los handlers de evento que se agregaron en la Fase 1, contra PostgreSQL real.
 *
 * Antes de estos tests, 14 de los 20 tipos del catalogo caian en el `default` con
 * "tipo de evento sin handler". Eso significa que nunca se ejecutaron contra una
 * base: el codigo era plausible y no verificado. Cada test de aqui ejercita un
 * handler con el SQL real, las constraints reales y la RLS real.
 *
 * Los casos que mas importan son los de los bugs que se encontraron al escribirlos:
 * cerrar sin turno, y el signo del movimiento de efectivo.
 */
describe('sync: handlers de comanda, cobro, caja y cocina', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let sync: SyncService;

  const venue = { id: '', orgId: '' };
  const device = { id: '' };
  const cashier = { id: '' };
  const station = { id: '' };
  const table = { id: '' };

  /** Secuencia monotonica por dispositivo, como la lleva el POS. */
  let seq = 0;

  const event = (type: SyncEventType, payload: Record<string, unknown>): SyncEventInput => ({
    eventId: uuidv7(),
    type,
    seq: (seq += 1),
    occurredAt: new Date().toISOString(),
    payload,
  });

  const push = async (events: SyncEventInput[]) =>
    sync.push({
      deviceId: device.id,
      orgId: venue.orgId,
      venueId: venue.id,
      actorId: cashier.id,
      events,
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

    const org = await harness.createOrg('Handlers Cafe');
    venue.orgId = org.orgId;
    venue.id = org.venueId;

    const roles = await seedDefaultRoles(harness, venue.orgId);
    cashier.id = await seedUser(harness, {
      orgId: venue.orgId,
      name: 'Cajero',
      email: 'cajero@handlers.test',
      pin: { plain: '2222', hasher: { hashPin: async (v: string) => `stub:${v}` } as never },
    });
    await assignRole(harness, {
      orgId: venue.orgId,
      userId: cashier.id,
      roleId: roles.get('cajero')!,
      venueId: venue.id,
    });

    await harness.asOrg(venue.orgId, async (q) => {
      const stationRow = await q<{ id: string }>(
        `INSERT INTO stations (org_id, venue_id, name, kind) VALUES ($1::uuid, $2::uuid, 'Cocina', 'cocina') RETURNING id`,
        [venue.orgId, venue.id],
      );
      station.id = stationRow.rows[0]!.id;

      const floor = await q<{ id: string }>(
        `INSERT INTO floors (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Salon') RETURNING id`,
        [venue.orgId, venue.id],
      );
      const tableRow = await q<{ id: string }>(
        `INSERT INTO tables (org_id, venue_id, floor_id, label, seats)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'H1', 4) RETURNING id`,
        [venue.orgId, venue.id, floor.rows[0]!.id],
      );
      table.id = tableRow.rows[0]!.id;
    });

    device.id = await seedDevice(harness, {
      orgId: venue.orgId,
      venueId: venue.id,
      name: 'Tablet Handlers',
      fingerprint: 'handlers-fingerprint',
      status: 'active',
    });
  }, 60_000);

  /** Abre una comanda real y devuelve su id. */
  async function openOrder(tableId: string | null = null): Promise<string> {
    const orderId = uuidv7();
    const result = await push([
      event('ORDER_OPENED', {
        orderId,
        tableId,
        numberLabel: `H-${orderId.slice(0, 4)}`,
        guests: 2,
      }),
    ]);
    expect(result.results[0]!.status).toBe('APPLIED');
    return orderId;
  }

  describe('curso y asiento', () => {
    it('asigna items a un curso', async () => {
      const orderId = await openOrder();
      const itemId = uuidv7();
      await push([
        event('ORDER_ITEM_ADDED', {
          orderId,
          itemId,
          name: 'Empanada',
          quantity: 2,
          unitPriceCents: 1500,
          course: 1,
        }),
      ]);

      const result = await push([
        event('ORDER_ITEM_COURSE_SET', { orderId, itemIds: [itemId], course: 2 }),
      ]);
      expect(result.results[0]!.status).toBe('APPLIED');

      const row = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ course: number }>(
          `SELECT course FROM order_items WHERE id = $1::uuid`,
          [itemId],
        );
        return found.rows[0]!;
      });
      expect(row.course).toBe(2);
    });

    it('rechaza un curso fuera de rango en vez de guardarlo', async () => {
      const orderId = await openOrder();
      const itemId = uuidv7();
      await push([
        event('ORDER_ITEM_ADDED', {
          orderId,
          itemId,
          name: 'Cafe',
          quantity: 1,
          unitPriceCents: 900,
        }),
      ]);

      // 0 y 10 estan fuera: un curso de 0 rompe el KDS, que ordena por curso.
      for (const course of [0, 10]) {
        const result = await push([
          event('ORDER_ITEM_COURSE_SET', { orderId, itemIds: [itemId], course }),
        ]);
        expect(result.results[0]!.status).toBe('REJECTED');
      }
    });

    it('asigna items a un comensal, que es lo que habilita dividir por asiento', async () => {
      const orderId = await openOrder();
      const itemId = uuidv7();
      await push([
        event('ORDER_ITEM_ADDED', {
          orderId,
          itemId,
          name: 'Cerveza',
          quantity: 2,
          unitPriceCents: 1500,
        }),
      ]);

      const result = await push([event('ORDER_SEAT_SET', { orderId, itemIds: [itemId], seat: 3 })]);
      expect(result.results[0]!.status).toBe('APPLIED');

      const row = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ seat: number }>(
          `SELECT seat FROM order_items WHERE id = $1::uuid`,
          [itemId],
        );
        return found.rows[0]!;
      });
      expect(row.seat).toBe(3);
    });
  });

  describe('propina', () => {
    it('suma la propina al total de la comanda', async () => {
      const orderId = await openOrder();
      await push([
        event('ORDER_ITEM_ADDED', {
          orderId,
          itemId: uuidv7(),
          name: 'Vino',
          quantity: 1,
          unitPriceCents: 5000,
        }),
      ]);

      const result = await push([event('TIP_ADDED', { orderId, tipCents: 1000 })]);
      expect(result.results[0]!.status).toBe('APPLIED');

      const row = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ tip_cents: number }>(
          `SELECT tip_cents FROM orders WHERE id = $1::uuid`,
          [orderId],
        );
        return found.rows[0]!;
      });
      expect(row.tip_cents).toBe(1000);
    });

    it('rechaza una propina con decimales', async () => {
      const orderId = await openOrder();
      const result = await push([event('TIP_ADDED', { orderId, tipCents: 10.5 })]);
      expect(result.results[0]!.status).toBe('REJECTED');
    });
  });

  describe('cierre y cancelacion', () => {
    it('cierra la comanda resolviendo el turno abierto del servidor', async () => {
      // Este es el bug que se encontro: la constraint `orders_closed_consistent`
      // exige turno al cerrar, y el POS cierra offline a veces sin mandarlo. Sin
      // resolverlo en el servidor, el UPDATE reventaba y **la mesa quedaba
      // ocupada para siempre**.
      await harness.asOrg(venue.orgId, async (q) => {
        await q(
          `INSERT INTO shifts (org_id, venue_id, opened_by, opening_float_cents)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 0)`,
          [venue.orgId, venue.id, cashier.id],
        );
      });

      const orderId = await openOrder(table.id);

      // Sin `shiftId` en el payload a proposito: el servidor tiene que resolverlo.
      const result = await push([event('ORDER_CLOSED', { orderId })]);
      expect(result.results[0]!.status).toBe('APPLIED');

      const state = await harness.asOrg(venue.orgId, async (q) => {
        const order = await q<{
          status: string;
          shift_id: string | null;
          source_device_id: string;
        }>(`SELECT status, shift_id, source_device_id FROM orders WHERE id = $1::uuid`, [orderId]);
        const mesa = await q<{ status: string; order_id: string | null }>(
          `SELECT status, order_id FROM tables WHERE id = $1::uuid`,
          [table.id],
        );
        return { order: order.rows[0]!, mesa: mesa.rows[0]! };
      });

      expect(state.order.status).toBe('CLOSED');
      expect(state.order.shift_id).not.toBeNull();
      // El dispositivo queda registrado: sin esto no se puede reconstruir
      // "quien cobro esto" cuando la comanda se abrio en otra tablet.
      expect(state.order.source_device_id).toBe(device.id);
      // Y la mesa se libera, que es el punto de todo el asunto.
      expect(state.mesa.status).toBe('LIBRE');
      expect(state.mesa.order_id).toBeNull();
    });

    it('rechaza el cierre con un mensaje que dice que abrir la caja', async () => {
      await harness.asOrg(venue.orgId, async (q) => {
        await q(
          `UPDATE shifts SET status = 'CLOSED', closed_at = now(), declared_cash_cents = 0,
                 expected_cash_cents = 0 WHERE venue_id = $1::uuid`,
          [venue.id],
        );
      });

      const orderId = await openOrder();
      const result = await push([event('ORDER_CLOSED', { orderId })]);

      // No un error de constraint, sino algo que el mozo puede resolver.
      expect(result.results[0]!.status).toBe('REJECTED');
      expect(result.results[0]!.message).toContain('caja');
      expect(result.results[0]!.action).toBe('NONE');

      // La comanda sigue abierta: un cierre fallido no puede perder la venta.
      const row = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ status: string }>(`SELECT status FROM orders WHERE id = $1::uuid`, [
          orderId,
        ]);
        return found.rows[0]!;
      });
      expect(row.status).toBe('OPEN');
    });

    it('cancelar exige motivo y libera la mesa', async () => {
      await harness.asOrg(venue.orgId, async (q) => {
        await q(
          `INSERT INTO shifts (org_id, venue_id, opened_by, opening_float_cents)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 0)`,
          [venue.orgId, venue.id, cashier.id],
        );
      });

      const orderId = await openOrder(table.id);

      const sinMotivo = await push([event('ORDER_CANCELED', { orderId })]);
      expect(sinMotivo.results[0]!.status).toBe('REJECTED');
      expect(sinMotivo.results[0]!.message).toContain('motivo');

      const conMotivo = await push([
        event('ORDER_CANCELED', { orderId, reason: 'El cliente se retiro sin pedir nada.' }),
      ]);
      expect(conMotivo.results[0]!.status).toBe('APPLIED');

      const mesa = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ status: string }>(`SELECT status FROM tables WHERE id = $1::uuid`, [
          table.id,
        ]);
        return found.rows[0]!;
      });
      expect(mesa.status).toBe('LIBRE');
    });
  });

  describe('reparto de cuenta', () => {
    it('guarda un reparto que cuadra con el total', async () => {
      const orderId = await openOrder();
      await push([
        event('ORDER_ITEM_ADDED', {
          orderId,
          itemId: uuidv7(),
          name: 'Pizza',
          quantity: 1,
          unitPriceCents: 10000,
        }),
      ]);

      const splitId = uuidv7();
      const result = await push([
        event('SPLIT_SAVED', {
          splitId,
          orderId,
          mode: 'EQUAL',
          allocations: [
            { label: 'Parte 1', amountCents: 3334, itemIds: [] },
            { label: 'Parte 2', amountCents: 3333, itemIds: [] },
            { label: 'Parte 3', amountCents: 3333, itemIds: [] },
          ],
        }),
      ]);

      expect(result.results[0]!.status).toBe('APPLIED');

      const row = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ mode: string; total_cents: number }>(
          `SELECT mode, total_cents FROM bill_splits WHERE id = $1::uuid`,
          [splitId],
        );
        return found.rows[0]!;
      });
      expect(row.mode).toBe('EQUAL');
      expect(row.total_cents).toBe(10000);
    });

    it('rechaza un reparto que no suma el total, diciendo la diferencia', async () => {
      const orderId = await openOrder();
      await push([
        event('ORDER_ITEM_ADDED', {
          orderId,
          itemId: uuidv7(),
          name: 'Cerveza',
          quantity: 1,
          unitPriceCents: 3000,
        }),
      ]);

      const result = await push([
        event('SPLIT_SAVED', {
          orderId,
          mode: 'EQUAL',
          allocations: [
            { label: 'Parte 1', amountCents: 1000, itemIds: [] },
            { label: 'Parte 2', amountCents: 1000, itemIds: [] },
          ],
        }),
      ]);

      // Un centavo de diferencia y el local no cierra el turno. El mensaje lleva
      // los dos numeros para que se vea cual sobra.
      expect(result.results[0]!.status).toBe('REJECTED');
      expect(result.results[0]!.message).toContain('2000');
      expect(result.results[0]!.message).toContain('3000');
    });

    it('el mismo reparto reenviado no se duplica', async () => {
      const orderId = await openOrder();
      await push([
        event('ORDER_ITEM_ADDED', {
          orderId,
          itemId: uuidv7(),
          name: 'Vino',
          quantity: 1,
          unitPriceCents: 5000,
        }),
      ]);

      const splitId = uuidv7();
      const split = event('SPLIT_SAVED', {
        splitId,
        orderId,
        mode: 'AMOUNT',
        allocations: [{ label: 'Ana', amountCents: 5000, itemIds: [] }],
      });

      const primero = await push([split]);
      expect(primero.results[0]!.status).toBe('APPLIED');

      // Mismo `eventId`: es un reenvio, no una segunda division.
      const segundo = await push([split]);
      expect(segundo.results[0]!.status).toBe('DUPLICATE');

      const count = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ count: number }>(
          `SELECT count(*)::int AS count FROM bill_splits WHERE order_id = $1::uuid`,
          [orderId],
        );
        return found.rows[0]!;
      });
      expect(count.count).toBe(1);
    });
  });

  describe('turno y caja', () => {
    it('abre el turno una sola vez por local', async () => {
      await harness.asOrg(venue.orgId, async (q) => {
        await q(
          `UPDATE shifts SET status = 'CLOSED', closed_at = now(), declared_cash_cents = 0,
                 expected_cash_cents = 0 WHERE venue_id = $1::uuid AND status = 'OPEN'`,
          [venue.id],
        );
      });

      const first = await push([
        event('SHIFT_OPENED', { shiftId: uuidv7(), openingFloatCents: 5000 }),
      ]);
      expect(first.results[0]!.status).toBe('APPLIED');

      // Dos tablets abren caja offline: la segunda tiene que ver que ya hay una.
      const second = await push([
        event('SHIFT_OPENED', { shiftId: uuidv7(), openingFloatCents: 5000 }),
      ]);
      expect(second.results[0]!.status).toBe('DUPLICATE');

      const count = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ count: number }>(
          `SELECT count(*)::int AS count FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN'`,
          [venue.id],
        );
        return found.rows[0]!;
      });
      expect(count.count).toBe(1);
    });

    it('el fondo de caja se guarda como entero', async () => {
      await harness.asOrg(venue.orgId, async (q) => {
        await q(
          `UPDATE shifts SET status = 'CLOSED', closed_at = now(), declared_cash_cents = 0,
                 expected_cash_cents = 0 WHERE venue_id = $1::uuid AND status = 'OPEN'`,
          [venue.id],
        );
      });

      await push([event('SHIFT_OPENED', { shiftId: uuidv7(), openingFloatCents: 20000 })]);

      const row = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ opening_float_cents: number }>(
          `SELECT opening_float_cents FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN'`,
          [venue.id],
        );
        return found.rows[0]!;
      });
      expect(row.opening_float_cents).toBe(20000);
    });

    it('un movimiento de efectivo exige motivo', async () => {
      const shiftRow = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ id: string }>(
          `SELECT id FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN'`,
          [venue.id],
        );
        return found.rows[0]!;
      });

      const sinMotivo = await push([
        event('SHIFT_CASH_MOVEMENT', {
          shiftId: shiftRow.id,
          type: 'OUT',
          amountCents: 5000,
        }),
      ]);
      expect(sinMotivo.results[0]!.status).toBe('REJECTED');
      expect(sinMotivo.results[0]!.message).toContain('motivo');
    });

    it('guarda el movimiento con el importe positivo y el tipodefine el signo', async () => {
      // El signo lo decide el tipo, no quien escribe: si el payload pudiera
      // mandar el signo, un retiro podria guardarse como ingreso y el arqueo del
      // turno quedaria desfasado para siempre.
      const shiftRow = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ id: string }>(
          `SELECT id FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN'`,
          [venue.id],
        );
        return found.rows[0]!;
      });

      const result = await push([
        event('SHIFT_CASH_MOVEMENT', {
          shiftId: shiftRow.id,
          type: 'RETIRO',
          amountCents: 3000,
          reason: 'Faltante para el cambio',
        }),
      ]);
      expect(result.results[0]!.status).toBe('APPLIED');

      const row = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ type: string; amount_cents: number }>(
          `SELECT type, amount_cents FROM cash_movements WHERE shift_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
          [shiftRow.id],
        );
        return found.rows[0]!;
      });
      // Positivo siempre: el signo se aplica al sumar, no al guardar.
      expect(row.type).toBe('RETIRO');
      expect(row.amount_cents).toBe(3000);
    });

    it('rechaza un importe negativo', async () => {
      const shiftRow = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ id: string }>(
          `SELECT id FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN'`,
          [venue.id],
        );
        return found.rows[0]!;
      });

      const result = await push([
        event('SHIFT_CASH_MOVEMENT', {
          shiftId: shiftRow.id,
          type: 'OUT',
          amountCents: -1000,
          reason: 'prueba',
        }),
      ]);
      expect(result.results[0]!.status).toBe('REJECTED');
    });
  });

  describe('cocina', () => {
    it('avanza el estado del ticket', async () => {
      const orderId = await openOrder();
      const itemId = uuidv7();
      await push([
        event('ORDER_ITEM_ADDED', {
          orderId,
          itemId,
          name: 'Milanesa',
          quantity: 1,
          unitPriceCents: 6000,
          note: 'sin sal',
        }),
      ]);

      const ticketId = uuidv7();
      await harness.asOrg(venue.orgId, async (q) => {
        await q(
          `INSERT INTO kitchen_tickets (id, org_id, venue_id, station_id, order_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
          [ticketId, venue.orgId, venue.id, station.id, orderId],
        );
      });

      for (const status of ['PREPARING', 'READY'] as const) {
        const result = await push([event('KDS_STATUS_SET', { ticketId, status })]);
        expect(result.results[0]!.status).toBe('APPLIED');
      }

      const row = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ status: string }>(
          `SELECT status FROM kitchen_tickets WHERE id = $1::uuid`,
          [ticketId],
        );
        return found.rows[0]!;
      });
      expect(row.status).toBe('READY');
    });

    it('un estado repetido responde DUPLICATE, no REJECTED', async () => {
      // Volver a poner el mismo estado viene de otra tablet que no se entero. Es un
      // evento legitimo: si se rechazara, quedaria clavado en la cola para siempre
      // reintentando.
      const orderId = await openOrder();
      const ticketId = uuidv7();
      await harness.asOrg(venue.orgId, async (q) => {
        await q(
          `INSERT INTO kitchen_tickets (id, org_id, venue_id, station_id, order_id, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'READY')`,
          [ticketId, venue.orgId, venue.id, station.id, orderId],
        );
      });

      const result = await push([event('KDS_STATUS_SET', { ticketId, status: 'READY' })]);
      expect(result.results[0]!.status).toBe('DUPLICATE');
    });

    it('rechaza un estado de cocina desconocido', async () => {
      const orderId = await openOrder();
      const ticketId = uuidv7();
      await harness.asOrg(venue.orgId, async (q) => {
        await q(
          `INSERT INTO kitchen_tickets (id, org_id, venue_id, station_id, order_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
          [ticketId, venue.orgId, venue.id, station.id, orderId],
        );
      });

      const result = await push([event('KDS_STATUS_SET', { ticketId, status: 'QUEMADO' })]);
      expect(result.results[0]!.status).toBe('REJECTED');
    });
  });

  describe('eventos TABLE_ como alias de ORDER_', () => {
    it('TABLE_ITEM_ADDED agrega el item igual que ORDER_ITEM_ADDED', async () => {
      const orderId = await openOrder();
      const itemId = uuidv7();

      const result = await push([
        event('TABLE_ITEM_ADDED', {
          orderId,
          itemId,
          name: 'Medialunas',
          quantity: 3,
          unitPriceCents: 1200,
        }),
      ]);
      expect(result.results[0]!.status).toBe('APPLIED');

      const row = await harness.asOrg(venue.orgId, async (q) => {
        const found = await q<{ name_snapshot: string; quantity: number }>(
          `SELECT name_snapshot, quantity FROM order_items WHERE id = $1::uuid`,
          [itemId],
        );
        return found.rows[0]!;
      });
      expect(row.name_snapshot).toBe('Medialunas');
      expect(row.quantity).toBe(3);
    });
  });
});
