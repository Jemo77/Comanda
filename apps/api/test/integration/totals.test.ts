import { beforeAll, describe, expect, it } from 'vitest';
import { orderTotals, uuidv7 } from '@comanda/domain';
import { DatabaseService } from '../../src/database/database.service';
import { SyncService } from '../../src/modules/sync/sync.service';
import { loadEnv } from '../../src/config/env';
import { createTestDatabase } from '../support/db';
import { assignRole, seedDefaultRoles, seedDevice, seedUser } from '../support/fixtures';
import type { TestDatabase } from '../support/env';
import type { SyncEventInput, SyncEventType } from '../../src/modules/sync/sync.types';

/**
 * El total se calcula una sola vez.
 *
 * Este archivo existe por un bug concreto: `orderTotals()` vive en el dominio y la
 * corre el POS sobre su replica local, pero el servidor lo recalculaba con un `SUM`
 * propio que solo cubria los items. Con descuento o servicio, el numero que veia el
 * mozo y el que cobraba el sistema eran distintos.
 *
 * La garantia que hay que probar es una sola y es fuerte: **para cualquier comanda,
 * los dos caminos dan exactamente el mismo total**. Por eso cada test corre el
 * calculo del dominio a mano (como haria el POS) y compara contra lo que quedo
 * guardado por el servidor.
 */
describe('totales: el POS y el servidor coinciden', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let sync: SyncService;

  const venue = { id: '', orgId: '' };
  const device = { id: '' };
  const cashier = { id: '' };
  const table = { id: '' };

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

    const org = await harness.createOrg('Totales Cafe');
    venue.orgId = org.orgId;
    venue.id = org.venueId;

    const roles = await seedDefaultRoles(harness, venue.orgId);
    cashier.id = await seedUser(harness, {
      orgId: venue.orgId,
      name: 'Cajero',
      email: 'cajero@totales.test',
      pin: { plain: '3333', hasher: { hashPin: async (v: string) => `stub:${v}` } as never },
    });
    await assignRole(harness, {
      orgId: venue.orgId,
      userId: cashier.id,
      roleId: roles.get('cajero')!,
      venueId: venue.id,
    });

    await harness.asOrg(venue.orgId, async (q) => {
      const floor = await q<{ id: string }>(
        `INSERT INTO floors (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Salon') RETURNING id`,
        [venue.orgId, venue.id],
      );
      const t = await q<{ id: string }>(
        `INSERT INTO tables (org_id, venue_id, floor_id, label, seats)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'T1', 4) RETURNING id`,
        [venue.orgId, venue.id, floor.rows[0]!.id],
      );
      table.id = t.rows[0]!.id;
    });

    device.id = await seedDevice(harness, {
      orgId: venue.orgId,
      venueId: venue.id,
      name: 'Tablet Totales',
      fingerprint: 'totales-fingerprint',
      status: 'active',
    });
  }, 60_000);

  /** Lee el total que quedo guardado en el servidor. */
  async function storedTotal(orderId: string): Promise<{
    total_cents: number;
    discount_cents: number;
    service_bps: number;
    tip_cents: number;
  }> {
    return harness.asOrg(venue.orgId, async (q) => {
      const found = await q<{
        total_cents: number;
        discount_cents: number;
        service_bps: number;
        tip_cents: number;
      }>(
        `SELECT total_cents, discount_cents, service_bps, tip_cents
         FROM orders WHERE id = $1::uuid`,
        [orderId],
      );
      return found.rows[0]!;
    });
  }

  /** Como el POS: arma una comanda y la manda por el push. */
  async function buildOrder(
    items: Array<{
      name: string;
      unitPriceCents: number;
      quantity: number;
      modifiers?: Array<{ name: string; priceDeltaCents: number }>;
    }>,
    opts: { discountCents?: number; serviceBps?: number; tipCents?: number } = {},
  ): Promise<{ orderId: string; itemIds: string[] }> {
    const orderId = uuidv7();
    const itemIds: string[] = [];

    const result = await push([
      event('ORDER_OPENED', { orderId, numberLabel: `X-${orderId.slice(0, 4)}`, guests: 2 }),
    ]);
    expect(result.results[0]!.status).toBe('APPLIED');

    for (const item of items) {
      const itemId = uuidv7();
      itemIds.push(itemId);
      const added = await push([
        event('ORDER_ITEM_ADDED', {
          orderId,
          itemId,
          name: item.name,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          modifiers: item.modifiers ?? [],
        }),
      ]);
      expect(added.results[0]!.status).toBe('APPLIED');
    }

    if (opts.discountCents || opts.serviceBps) {
      const charges = await push([
        event('ORDER_CHARGES_SET', {
          orderId,
          discountCents: opts.discountCents ?? 0,
          serviceBps: opts.serviceBps ?? 0,
          reason: opts.discountCents ? 'Cortesia de la casa' : undefined,
        }),
      ]);
      expect(charges.results[0]!.status).toBe('APPLIED');
    }

    if (opts.tipCents) {
      const tip = await push([event('TIP_ADDED', { orderId, tipCents: opts.tipCents })]);
      expect(tip.results[0]!.status).toBe('APPLIED');
    }

    return { orderId, itemIds };
  }

  /** El calculo del POS, hecho con la misma funcion del dominio. */
  function posTotal(
    items: Array<{
      unitPriceCents: number;
      quantity: number;
      modifiers?: Array<{ priceDeltaCents: number }>;
    }>,
    opts: { discountCents?: number; serviceBps?: number; tipCents?: number } = {},
  ): number {
    return orderTotals({
      items: items.map((item) => ({ ...item, status: 'ACTIVE' as const })),
      currency: 'XXX',
      discountCents: opts.discountCents ?? 0,
      serviceBps: opts.serviceBps ?? 0,
      tipCents: opts.tipCents ?? 0,
    }).totalCents;
  }

  it('comanda simple: los dos caminos coinciden', async () => {
    const items = [
      { name: 'Cerveza', unitPriceCents: 1500, quantity: 2 },
      { name: 'Empanada', unitPriceCents: 2200, quantity: 1 },
    ];
    const { orderId } = await buildOrder(items);

    expect((await storedTotal(orderId)).total_cents).toBe(posTotal(items));
    expect((await storedTotal(orderId)).total_cents).toBe(5200);
  });

  it('con modificadores: el delta entra en el precio unitario', async () => {
    const items = [
      // 2 capuchinos con shot: 2 x (3000 + 500) = 7000. Si el delta se sumara una
      // vez por item en vez de por unidad, daria 6500.
      {
        name: 'Capuchino',
        unitPriceCents: 3000,
        quantity: 2,
        modifiers: [{ name: 'Shot', priceDeltaCents: 500 }],
      },
    ];
    const { orderId } = await buildOrder(items);

    expect((await storedTotal(orderId)).total_cents).toBe(posTotal(items));
    expect((await storedTotal(orderId)).total_cents).toBe(7000);
  });

  it('con servicio: se calcula sobre el neto, no sobre la lista', async () => {
    const items = [{ name: 'Pizza', unitPriceCents: 10000, quantity: 1 }];
    const opts = { discountCents: 2000, serviceBps: 1000 };
    const { orderId } = await buildOrder(items, opts);

    const stored = await storedTotal(orderId);
    // 10.000 - 2.000 de descuento, y el 10% se aplica sobre los 8.000: 8.800.
    // Aplicarlo sobre la lista daria 9.000, que es el reclamo clasico del bar.
    expect(stored.total_cents).toBe(8800);
    expect(stored.total_cents).toBe(posTotal(items, opts));
  });

  it('con propina: la propina entra despues del servicio', async () => {
    const items = [{ name: 'Vino', unitPriceCents: 5000, quantity: 1 }];
    const opts = { serviceBps: 1000, tipCents: 1000 };
    const { orderId } = await buildOrder(items, opts);

    const stored = await storedTotal(orderId);
    // 5.000 del vino + 500 de servicio (10% de 5.000) + 1.000 de propina.
    expect(stored.total_cents).toBe(6500);
    expect(stored.total_cents).toBe(posTotal(items, opts));
    expect(stored.tip_cents).toBe(1000);
  });

  it('descuento mayor que la cuenta deja el total en cero, no negativo', async () => {
    const items = [{ name: 'Agua', unitPriceCents: 1000, quantity: 1 }];
    const opts = { discountCents: 5000 };
    const { orderId } = await buildOrder(items, opts);

    const stored = await storedTotal(orderId);
    expect(stored.total_cents).toBe(0);
    expect(stored.total_cents).toBe(posTotal(items, opts));
  });

  it('un item anulado sale del total en los dos caminos', async () => {
    const items = [
      { name: 'Cerveza', unitPriceCents: 1500, quantity: 2 },
      { name: 'Milanesa', unitPriceCents: 6000, quantity: 1 },
    ];
    const { orderId, itemIds } = await buildOrder(items);
    expect((await storedTotal(orderId)).total_cents).toBe(9000);

    const voided = await push([
      event('ORDER_ITEM_VOIDED', { orderId, itemId: itemIds[1]!, reason: 'Se Equipo mal.' }),
    ]);
    expect(voided.results[0]!.status).toBe('APPLIED');

    const stored = await storedTotal(orderId);
    expect(stored.total_cents).toBe(3000);
    expect(stored.total_cents).toBe(posTotal([items[0]!]));
  });

  it('cambiar el descuento recalcula sobre los mismos items', async () => {
    // El descuento es estado de la orden, no una operacion sobre el total: por eso
    // dos recalculos seguidos tienen que dar el mismo numero y no acumular.
    const items = [{ name: 'Pizza', unitPriceCents: 10000, quantity: 1 }];
    const { orderId } = await buildOrder(items, { discountCents: 1000 });

    expect((await storedTotal(orderId)).total_cents).toBe(9000);

    const again = await push([
      event('ORDER_CHARGES_SET', { orderId, discountCents: 1000, reason: 'Cortesia de la casa' }),
    ]);
    expect(again.results[0]!.status).toBe('APPLIED');

    // 9000 otra vez, no 8000: el descuento se reescribe, no se suma.
    expect((await storedTotal(orderId)).total_cents).toBe(9000);
  });

  it('un descuento sin motivo se rechaza', async () => {
    const items = [{ name: 'Vino', unitPriceCents: 5000, quantity: 1 }];
    const { orderId } = await buildOrder(items);

    const result = await push([
      event('ORDER_CHARGES_SET', { orderId, discountCents: 1000, reason: '' }),
    ]);

    expect(result.results[0]!.status).toBe('REJECTED');
    expect(result.results[0]!.message).toContain('motivo');
    // Y el total no se toco.
    expect((await storedTotal(orderId)).total_cents).toBe(5000);
  });

  it('un pago NO suma al total: el total es lo que se debe', async () => {
    // Si el pago sumara al total, "lo que se debe" y "lo que se pagó" estarian
    // mezclados y el arqueo del turno no cerraria nunca.
    const items = [{ name: 'Cerveza', unitPriceCents: 3000, quantity: 2 }];
    const { orderId } = await buildOrder(items);
    expect((await storedTotal(orderId)).total_cents).toBe(6000);

    const paid = await push([
      event('PAYMENT_RECORDED', {
        paymentId: uuidv7(),
        orderId,
        method: 'CASH',
        amountCents: 6000,
      }),
    ]);
    expect(paid.results[0]!.status).toBe('APPLIED');

    // El total sigue siendo 6000: lo que se debe, no lo cobrado.
    expect((await storedTotal(orderId)).total_cents).toBe(6000);
  });

  it('el total es siempre un entero de centavos', async () => {
    const items = [
      {
        name: 'Cafe',
        unitPriceCents: 333,
        quantity: 3,
        modifiers: [{ name: 'Shot', priceDeltaCents: 111 }],
      },
    ];
    const opts = { serviceBps: 3333 };
    const { orderId } = await buildOrder(items, opts);

    const stored = await storedTotal(orderId);
    expect(Number.isInteger(stored.total_cents)).toBe(true);
    expect(stored.total_cents).toBe(posTotal(items, opts));
  });
});
