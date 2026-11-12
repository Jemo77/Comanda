import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Subject } from 'rxjs';
import { uuidv7 } from '@comanda/domain';
import { loadEnv } from '../../src/config/env';
import { DatabaseService, type TenantContext } from '../../src/database/database.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CashService } from '../../src/modules/cash/cash.service';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { openOrderSchema, addItemSchema } from '../../src/modules/orders/orders.types';
import { paySchema } from '../../src/modules/payments/payments.types';
import { createTestDatabase, truncateAuditLog, truncateOrg } from '../support/db';
import type { TestDatabase } from '../support/env';

describe('reports · ventas agregadas', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let reports: ReportsService;
  let orders: OrdersService;
  let payments: PaymentsService;
  let cash: CashService;

  const luna = { orgId: '', venueId: '' };
  const orion = { orgId: '', venueId: '' };
  let catComidas = '';
  let catBebidas = '';
  let milanesaId = '';
  let vinoId = '';
  let tablaId = '';
  let cajeroId = '';

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
    reports = new ReportsService(db);
    const audit = new AuditService(db, env);
    orders = new OrdersService(db, audit);
    payments = new PaymentsService(db, audit);
    cash = new CashService(db, audit);

    const lunaOrg = await harness.createOrg('Reporte Luna');
    luna.orgId = lunaOrg.orgId;
    luna.venueId = lunaOrg.venueId;
    const orionOrg = await harness.createOrg('Reporte Orion');
    orion.orgId = orionOrg.orgId;
    orion.venueId = orionOrg.venueId;

    await harness.asOrg(luna.orgId, async (q) => {
      const user = await q<{ id: string }>(
        `INSERT INTO users (org_id, name, email) VALUES ($1::uuid, 'Cajero', 'cajero@rep.test') RETURNING id`,
        [luna.orgId],
      );
      cajeroId = user.rows[0]!.id;

      const cats = await q<{ id: string; name: string }>(
        `INSERT INTO categories (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Comidas'), ($1::uuid, $2::uuid, 'Bebidas') RETURNING id, name`,
        [luna.orgId, luna.venueId],
      );
      catComidas = cats.rows.find((c) => c.name === 'Comidas')!.id;
      catBebidas = cats.rows.find((c) => c.name === 'Bebidas')!.id;

      const products = await q<{ id: string; name: string }>(
        `INSERT INTO products (org_id, category_id, name, price_cents)
         VALUES ($1::uuid, $2::uuid, 'Milanesa', 12000), ($1::uuid, $3::uuid, 'Vino', 6000)
         RETURNING id, name`,
        [luna.orgId, catComidas, catBebidas],
      );
      milanesaId = products.rows.find((p) => p.name === 'Milanesa')!.id;
      vinoId = products.rows.find((p) => p.name === 'Vino')!.id;

      const floor = await q<{ id: string }>(
        `INSERT INTO floors (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Salon') RETURNING id`,
        [luna.orgId, luna.venueId],
      );
      const table = await q<{ id: string }>(
        `INSERT INTO tables (org_id, venue_id, floor_id, label, seats) VALUES ($1::uuid, $2::uuid, $3::uuid, 'R1', 4) RETURNING id`,
        [luna.orgId, luna.venueId, floor.rows[0]!.id],
      );
      tablaId = table.rows[0]!.id;
    });

    await db.withTenant({ orgId: luna.orgId, venueId: luna.venueId, userId: cajeroId }, async () => {
      await cash.openShift(luna.orgId, luna.venueId, { openingFloatCents: 5000 }, { userId: cajeroId, name: 'Cajero', deviceId: null });
    });
  }, 60_000);

  afterAll(async () => {
    for (const org of [luna, orion]) {
      if (org.orgId) {
        await truncateAuditLog(harness, org.orgId);
        await truncateOrg(harness, org.orgId);
      }
    }
    await db.onModuleDestroy();
    await harness.close();
  });

  const asLuna = <T>(work: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      let result: T;
      db.runInTenantStream({ orgId: luna.orgId, venueId: luna.venueId, userId: cajeroId }, () => {
        const done = new Subject<T>();
        void work().then((v) => { result = v; done.complete(); }, (e: unknown) => done.error(e));
        return done;
      }).subscribe({ complete: () => resolve(result!), error: reject });
    });

  const comprar = async (items: Array<{ productId: string; quantity: number }>, totalCents: number) => {
    const order = await asLuna(() =>
      orders.openOrder(luna.orgId, luna.venueId, openOrderSchema.parse({ tableId: tablaId, guests: 2 }), { userId: cajeroId, name: 'Cajero', deviceId: null }, uuidv7()),
    );
    for (const item of items) {
      await asLuna(() =>
        orders.addItem(luna.orgId, luna.venueId, order.order.id, addItemSchema.parse(item), { userId: cajeroId, name: 'Cajero', deviceId: null }),
      );
    }
    await asLuna(() =>
      payments.pay(luna.orgId, luna.venueId, order.order.id, paySchema.parse({ lines: [{ method: 'CASH', amountCents: totalCents }] }), { userId: cajeroId, name: 'Cajero', deviceId: null }, uuidv7()),
    );
    return order.order.id;
  };

  it('ventas por producto suman en centavos', async () => {
    await comprar([{ productId: milanesaId, quantity: 1 }], 12000);
    await comprar([{ productId: vinoId, quantity: 2 }], 12000);

    const report = await reports.sales(luna.orgId, luna.venueId, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
      groupBy: 'product',
    });

    expect(report.ordersCount).toBe(2);
    expect(report.totalCents).toBe(24000);
    const milanesa = report.rows.find((r) => r.group === 'Milanesa');
    const vino = report.rows.find((r) => r.group === 'Vino');
    expect(milanesa?.totalCents).toBe(12000);
    expect(vino?.units).toBe(2);
    expect(vino?.totalCents).toBe(12000);
  });

  it('ventas por categoria', async () => {
    const report = await reports.sales(luna.orgId, luna.venueId, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
      groupBy: 'category',
    });
    const comidas = report.rows.find((r) => r.group === 'Comidas');
    const bebidas = report.rows.find((r) => r.group === 'Bebidas');
    expect(comidas?.totalCents).toBe(12000);
    expect(bebidas?.totalCents).toBe(12000);
  });

  it('otro local no ve las ventas (RLS)', async () => {
    const report = await reports.sales(orion.orgId, orion.venueId, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
      groupBy: 'day',
    });
    expect(report.totalCents).toBe(0);
    expect(report.rows).toHaveLength(0);
  });
});
