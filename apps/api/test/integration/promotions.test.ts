import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { uuidv7 } from '@comanda/domain';
import { AuditService } from '../../src/modules/audit/audit.service';
import { PromotionsService, type PromotionActor } from '../../src/modules/promotions/promotions.service';
import { createRuleSchema, updateRuleSchema } from '../../src/modules/promotions/promotions.types';
import { OrdersService, type OrderActor } from '../../src/modules/orders/orders.service';
import { addItemSchema, openOrderSchema } from '../../src/modules/orders/orders.types';
import { Subject } from 'rxjs';
import { loadEnv } from '../../src/config/env';
import { DatabaseService } from '../../src/database/database.service';
import { createTestDatabase, truncateAuditLog, truncateOrg } from '../support/db';
import { assignRole, seedDefaultRoles, seedUser } from '../support/fixtures';
import type { TestDatabase } from '../support/env';

/**
 * Promociones: el CRUD, sus validaciones y el efecto en una comanda real.
 *
 * Lo que mas importaba que no pasara: que una promo creada en otro local (o de
 * baja) siga descontando, y que el precio cobrado quede explicado por el snapshot
 * `applied_rules`. Esas dos son las que definirian "cobrarle de mas a una mesa y
 * no saber por que".
 */

function detailOf(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null && 'detail' in response) {
      return String((response as { detail: string }).detail);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

describe('promotions · reglas de precio', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let promotions: PromotionsService;
  let orders: OrdersService;

  const luna = { orgId: '', venueId: '' };
  const orion = { orgId: '', venueId: '' };
  const lunaActor: PromotionActor & OrderActor = { userId: '', name: 'Dueña', deviceId: null };
  let fernetId = '';
  let tablaLibre = '';
  let tablaDos = '';

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
    promotions = new PromotionsService(db, new AuditService(db, env));
    orders = new OrdersService(db, new AuditService(db, env));

    const lunaOrg = await harness.createOrg('Promo Luna');
    luna.orgId = lunaOrg.orgId;
    luna.venueId = lunaOrg.venueId;
    const orionOrg = await harness.createOrg('Promo Orion');
    orion.orgId = orionOrg.orgId;
    orion.venueId = orionOrg.venueId;

    const roles = await seedDefaultRoles(harness, luna.orgId);
    const ownerId = await seedUser(harness, {
      orgId: luna.orgId,
      name: 'Dueña',
      email: 'duena@promo.test',
      pin: { plain: '1234', hasher: { hashPin: async (v: string) => `stub:${v}` } as never },
    });
    await assignRole(harness, { orgId: luna.orgId, userId: ownerId, roleId: roles.get('dueno')!, venueId: luna.venueId });
    lunaActor.userId = ownerId;

    await harness.asOrg(luna.orgId, async (q) => {
      const category = await q<{ id: string }>(
        `INSERT INTO categories (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Tragos') RETURNING id`,
        [luna.orgId, luna.venueId],
      );
      const product = await q<{ id: string }>(
        `INSERT INTO products (org_id, category_id, name, price_cents)
         VALUES ($1::uuid, $2::uuid, 'Fernet', 4000) RETURNING id`,
        [luna.orgId, category.rows[0]!.id],
      );
      fernetId = product.rows[0]!.id;

      const floor = await q<{ id: string }>(
        `INSERT INTO floors (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Salon') RETURNING id`,
        [luna.orgId, luna.venueId],
      );
      const table = await q<{ id: string; label: string }>(
        `INSERT INTO tables (org_id, venue_id, floor_id, label, seats)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'P1', 4), ($1::uuid, $2::uuid, $3::uuid, 'P2', 4)
         RETURNING id, label`,
        [luna.orgId, luna.venueId, floor.rows[0]!.id],
      );
      tablaLibre = table.rows.find((t) => t.label === 'P1')!.id;
      tablaDos = table.rows.find((t) => t.label === 'P2')!.id;
    });
    // El turno abierto es una precondicion del cierre de comanda; para addItem alcanza
    // con la orden, pero el interceptor exige contexto de tenant para todo.
  }, 60_000);

  afterAll(async () => {
    for (const org of [luna, orion]) {
      if (!org.orgId) continue;
      await truncateAuditLog(harness, org.orgId);
      await truncateOrg(harness, org.orgId);
    }
    await db.onModuleDestroy();
    await harness.close();
  });

  const inTenant = <T>(ctx: { orgId: string; venueId: string }, work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let result: T;
      db.runInTenantStream({ ...ctx, userId: lunaActor.userId }, () => {
        const done = new Subject<T>();
        void work().then(
          (value) => {
            result = value;
            done.complete();
          },
          (error: unknown) => done.error(error),
        );
        return done;
      }).subscribe({ complete: () => resolve(result!), error: reject });
    });

  it('rechaza un PERCENT sin bps', () => {
    expect(() =>
      createRuleSchema.parse({
        name: 'Rota',
        type: 'PERCENT',
        scope: 'PRODUCT',
        scopeId: fernetId,
        params: {},
      }),
    ).toThrowError(/bps/);
  });

  it('rechaza ORDER con scopeId, y PRODUCT sin scopeId', () => {
    expect(() =>
      createRuleSchema.parse({ name: 'X', type: 'BOGO', scope: 'ORDER', scopeId: fernetId, params: {} }),
    ).toThrowError(/ORDER/);
    expect(() =>
      createRuleSchema.parse({ name: 'X', type: 'BOGO', scope: 'PRODUCT', scopeId: null, params: {} }),
    ).toThrowError(/Falta/);
  });

  it('crea una promo y la cobra con snapshot', async () => {
    const created = await inTenant(luna, () =>
      promotions.create(
        luna.orgId,
        luna.venueId,
        createRuleSchema.parse({
          name: 'Fernet -20%',
          type: 'PERCENT',
          scope: 'PRODUCT',
          scopeId: fernetId,
          params: { bps: 2000 },
          priority: 10,
        }),
        lunaActor,
      ),
    );
    expect(created.rule.id).toBeTruthy();

    const order = await inTenant(luna, () =>
      orders.openOrder(luna.orgId, luna.venueId, openOrderSchema.parse({ tableId: tablaLibre, guests: 2 }), {
        ...lunaActor,
      }, uuidv7()),
    );
    const detail = await inTenant(luna, () =>
      orders.addItem(
        luna.orgId,
        luna.venueId,
        order.order.id,
        addItemSchema.parse({ productId: fernetId, quantity: 2 }),
        { ...lunaActor },
      ),
    );

    const item = detail.order.items[0]!;
    expect(item.unitPriceCents).toBe(3200); // 4000 - 20%
    // listPriceCents queda en base (order_items.list_price_cents) y no en el tipo OrderItem.
    expect((item.appliedRules as Array<{ type: string }>)[0]?.type).toBe('PERCENT');
  });

  it('un local no ve las promos del otro (RLS)', async () => {
    const { rules } = await inTenant(orion, () =>
      promotions.list(orion.orgId, orion.venueId),
    );
    expect(rules.filter((r) => r.name === 'Fernet -20%')).toHaveLength(0);
  });

  it('dar de baja corta el descuento', async () => {
    const { rules } = await inTenant(luna, () => promotions.list(luna.orgId, luna.venueId));
    const target = rules.find((r) => r.name === 'Fernet -20%')!;

    await inTenant(luna, () => promotions.remove(luna.orgId, luna.venueId, target.id, lunaActor));

    const order = await inTenant(luna, () =>
      orders.openOrder(luna.orgId, luna.venueId, openOrderSchema.parse({ tableId: tablaDos, guests: 1 }), {
        ...lunaActor,
      }, uuidv7()),
    );
    const detail = await inTenant(luna, () =>
      orders.addItem(
        luna.orgId,
        luna.venueId,
        order.order.id,
        addItemSchema.parse({ productId: fernetId, quantity: 1 }),
        { ...lunaActor },
      ),
    );
    expect(detail.order.items[0]!.unitPriceCents).toBe(4000);
    expect(detail.order.items[0]!.appliedRules).toEqual([]);
  });

  it('cambiar solo el type sin params da error de consistencia', async () => {
    const created = await inTenant(luna, () =>
      promotions.create(
        luna.orgId,
        luna.venueId,
        createRuleSchema.parse({
          name: '2x1 fernet',
          type: 'BOGO',
          scope: 'PRODUCT',
          scopeId: fernetId,
          params: {},
        }),
        lunaActor,
      ),
    );

    const rejection = await inTenant(luna, async () => {
      try {
        await promotions.update(
          luna.orgId,
          luna.venueId,
          created.rule.id,
          updateRuleSchema.parse({ type: 'PERCENT' }),
          lunaActor,
        );
        return null;
      } catch (error) {
        return detailOf(error);
      }
    });
    expect(rejection).toMatch(/params\.bps/);
  });
});
