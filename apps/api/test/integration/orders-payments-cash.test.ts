import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { uuidv7, orderTotals, type ProblemDetails } from '@comanda/domain';
import { loadEnv, type AppEnv } from '../../src/config/env';
import { DatabaseService, type TenantContext } from '../../src/database/database.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { OrdersService, type OrderActor } from '../../src/modules/orders/orders.service';
import { PaymentsService, type PaymentActor } from '../../src/modules/payments/payments.service';
import { CashService, type CashActor } from '../../src/modules/cash/cash.service';
import {
  addItemSchema,
  openOrderSchema,
  voidItemSchema,
} from '../../src/modules/orders/orders.types';
import { paySchema, splitBillSchema } from '../../src/modules/payments/payments.types';
import { cashMovementSchema, closeShiftSchema } from '../../src/modules/cash/cash.types';
import { createTestDatabase, truncateAuditLog, truncateOrg } from '../support/db';
import { assignRole, seedDefaultRoles, seedUser } from '../support/fixtures';
import type { TestDatabase } from '../support/env';

/**
 * Comandas, cobro y caja, contra PostgreSQL real.
 *
 * Los tres modulos juntos en un archivo porque comparten el mismo estado: una comanda se
 * abre, se carga, se cobra y se arquea. Repartirlos en tres archivos obligaria a repetir el
 * `beforeAll` tres veces y a coordinating el turno abierto entre ellos, que es
 * precisamente la parte que hay que probar junta.
 *
 * Lo que se verifica aca y en ningun otro lado:
 *
 *  - El precio lo recalcula el servidor (el contrato no tiene donde mandar un importe).
 *  - Un pago con la misma `Idempotency-Key` no cobra dos veces.
 *  - El arqueo ciego **no** le devuelve el esperado al cajero.
 *  - El signo del movimiento de efectivo lo decide el tipo.
 *  - Una comanda de la org A no se lee desde la org B.
 */
describe('orders · payments · cash', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let env: AppEnv;
  let orders: OrdersService;
  let payments: PaymentsService;
  let cash: CashService;

  /** Organizacion de las pruebas. */
  const luna = { orgId: '', venueId: '' };
  /** Organizacion ajena, para el aislamiento. */
  const orion = { orgId: '', venueId: '' };

  const cajero = { userId: '' };
  const encargado = { userId: '' };

  const mesa = { id: '' };
  const mesaLibre = { id: '' };
  const mesaExtra = { id: '' };
  const categoria = { id: '' };
  const producto = { id: '', priceCents: 0 };
  const productoBarato = { id: '', priceCents: 0 };
  const grupo = { id: '' };
  const modificador = { id: '', priceDeltaCents: 0 };

  /** Turno de la primera tanda. Lo abre `beforeAll` y lo cierra el test de arqueo. */
  let turnoInicial = '';
  /** Id del turno que el test de arqueo ciego cierra, para consultarlo despues. */
  let turnoArqueado = '';

  /**
   * Corre un bloque dentro de una transaccion con el contexto de tenant puesto, igual que
   * el `TenantContextInterceptor` en produccion.
   *
   * No alcanza con `db.withTenant`: ese metodo abre su propia conexion, y `db.query()` solo
   * ve el contexto si esta en la transaccion **ambiental** que arma el interceptor. Sin
   * esto las lecturas darian vacias (la RLS responde con cero filas, no con un error) y los
   * INSERT darian error de policy: dos fallos que parecen bugs del servicio y son falta de
   * contexto.
   *
   * El trabajo se arranca dentro de la `factory`: es lo unico que corre con el contexto en
   * el `AsyncLocalStorage`, porque la suscripcion al Observable ocurre despues y ya esta
   * afuera. El `Subject` es el puente para que el fin del trabajo cierre la transaccion, y
   * se resuelve en `complete`, que el interceptor emite DESPUES del COMMIT.
   */
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
    inTenant({ orgId: luna.orgId, venueId: luna.venueId, userId: cajero.userId }, work);
  const asOrion = <T>(work: () => Promise<T>) =>
    inTenant({ orgId: orion.orgId, venueId: orion.venueId, userId: cajero.userId }, work);

  /** Actor ficticio con permisos de cajero: el `actorId` real va en la sesion HTTP. */
  const actorCajero = (): OrderActor & PaymentActor & CashActor => ({
    userId: cajero.userId,
    name: 'Cajero',
    deviceId: null,
  });

  const actorEncargado = (): OrderActor & PaymentActor & CashActor => ({
    userId: encargado.userId,
    name: 'Encargado',
    deviceId: null,
  });

  /** Compara el `detail` del problem+json, que es lo que ve el operador. */
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

  /**
   * Comanda abierta en una mesa, con items cargados y lista para cobrar.
   *
   * La mesa se pasa porque hay tests que necesitan dos comandas vivas a la vez (la union) y
   * `orders_one_open_per_table` no deja dos sobre la misma.
   */
  const comandaCon = async (
    items: Array<{ productId: string; quantity: number }>,
    tableId: string = mesaLibre.id,
  ) => {
    const order = await asLuna(() =>
      orders.openOrder(
        luna.orgId,
        luna.venueId,
        openOrderSchema.parse({ tableId, guests: 2 }),
        actorCajero(),
        uuidv7(),
      ),
    );
    const orderId = order.order.id;

    for (const item of items) {
      await asLuna(() =>
        orders.addItem(luna.orgId, luna.venueId, orderId, addItemSchema.parse(item), actorCajero()),
      );
    }

    return orderId;
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
    orders = new OrdersService(db, new AuditService(db, env));
    payments = new PaymentsService(db, new AuditService(db, env));
    cash = new CashService(db, new AuditService(db, env));

    const lunaOrg = await harness.createOrg('Comanda Luna');
    luna.orgId = lunaOrg.orgId;
    luna.venueId = lunaOrg.venueId;
    const orionOrg = await harness.createOrg('Comanda Orion');
    orion.orgId = orionOrg.orgId;
    orion.venueId = orionOrg.venueId;

    const roles = await seedDefaultRoles(harness, luna.orgId);
    cajero.userId = await seedUser(harness, {
      orgId: luna.orgId,
      name: 'Cajero',
      email: 'cajero@luna.test',
      pin: { plain: '2222', hasher: { hashPin: async (v: string) => `stub:${v}` } as never },
    });
    await assignRole(harness, {
      orgId: luna.orgId,
      userId: cajero.userId,
      roleId: roles.get('cajero')!,
      venueId: luna.venueId,
    });

    // El Encargado existe solo para los permisos: `cash.viewExpected` es lo que separa su
    // pantalla de la del cajero, y esa separacion se prueba aca.
    encargado.userId = await seedUser(harness, {
      orgId: luna.orgId,
      name: 'Encargado',
      email: 'encargado@luna.test',
      pin: { plain: '3333', hasher: { hashPin: async (v: string) => `stub:${v}` } as never },
    });
    await assignRole(harness, {
      orgId: luna.orgId,
      userId: encargado.userId,
      roleId: roles.get('encargado')!,
      venueId: luna.venueId,
    });

    await asLuna(async () => {
      const category = await harness.asOrg(luna.orgId, async (q) => {
        const inserted = await q<{ id: string }>(
          `INSERT INTO categories (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Comidas')
           RETURNING id`,
          [luna.orgId, luna.venueId],
        );
        const found = await q<{ id: string; price_cents: number; name: string }>(
          `INSERT INTO products (org_id, category_id, name, price_cents)
           VALUES ($1::uuid, $2::uuid, 'Milanesa', 6000), ($1::uuid, $2::uuid, 'Vino', 5000)
           RETURNING id, price_cents, name`,
          [luna.orgId, inserted.rows[0]!.id],
        );
        return found.rows;
      });

      categoria.id = category[0]!.id;
      producto.id = category.find((p) => p.name === 'Milanesa')!.id;
      producto.priceCents = 6000;
      productoBarato.id = category.find((p) => p.name === 'Vino')!.id;
      productoBarato.priceCents = 5000;

      const modifierGroup = await harness.asOrg(luna.orgId, async (q) => {
        const inserted = await q<{ id: string }>(
          `INSERT INTO modifier_groups (org_id, name, min_select, max_select)
           VALUES ($1::uuid, 'Extras', 0, 3) RETURNING id`,
          [luna.orgId],
        );
        return inserted.rows[0]!.id;
      });
      grupo.id = modifierGroup;

      const mods = await harness.asOrg(luna.orgId, async (q) => {
        const inserted = await q<{ id: string; price_delta_cents: number; name: string }>(
          `INSERT INTO modifiers (org_id, group_id, name, price_delta_cents)
           VALUES ($1::uuid, $2::uuid, 'Extra queso', 900), ($1::uuid, $2::uuid, 'Sin sal', 0)
           RETURNING id, price_delta_cents, name`,
          [luna.orgId, modifierGroup],
        );
        return inserted.rows;
      });
      modificador.id = mods.find((m) => m.name === 'Extra queso')!.id;
      modificador.priceDeltaCents = 900;

      const floor = await harness.asOrg(luna.orgId, async (q) => {
        const inserted = await q<{ id: string }>(
          `INSERT INTO floors (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Salon')
           RETURNING id`,
          [luna.orgId, luna.venueId],
        );
        return inserted.rows[0]!.id;
      });

      const tables = await harness.asOrg(luna.orgId, async (q) => {
        const inserted = await q<{ id: string; label: string }>(
          `INSERT INTO tables (org_id, venue_id, floor_id, label, seats)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'H1', 4),
                  ($1::uuid, $2::uuid, $3::uuid, 'H2', 4),
                  ($1::uuid, $2::uuid, $3::uuid, 'H3', 4)
           RETURNING id, label`,
          [luna.orgId, luna.venueId, floor],
        );
        return inserted.rows;
      });
      mesa.id = tables.find((t) => t.label === 'H1')!.id;
      mesaLibre.id = tables.find((t) => t.label === 'H2')!.id;
      mesaExtra.id = tables.find((t) => t.label === 'H3')!.id;
    });

    // El turno se abre por el servicio, no por un INSERT: el resto del archivo usa la caja
    // como la usa el local, y un atajo aca taparia justo el bug que se busca (cobrar sin
    // caja abierta).
    const abierto = await asLuna(() =>
      cash.openShift(luna.orgId, luna.venueId, { openingFloatCents: 10_000 }, actorCajero()),
    );
    turnoInicial = abierto.id;
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

  // ---------------------------------------------------------------------------

  describe('comanda: apertura y carga', () => {
    it('abre una comanda, ocupa la mesa y el total coincide con orderTotals del dominio', async () => {
      const abierta = await asLuna(() =>
        orders.openOrder(
          luna.orgId,
          luna.venueId,
          openOrderSchema.parse({ tableId: mesa.id, guests: 2, numberLabel: 'A-1' }),
          actorCajero(),
        ),
      );

      const orderId = abierta.order.id;
      expect(abierta.order.status).toBe('OPEN');
      expect(abierta.order.tableLabel).toBe('H1');
      expect(abierta.replay).toBe(false);

      // La mesa queda ocupada con la comanda colgando: es el estado con el que trabaja el
      // mapa, y lo que `tables_occupied_consistent` garantiza.
      const mesaAbierta = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ status: string; order_id: string | null }>(
          `SELECT status, order_id FROM tables WHERE id = $1::uuid`,
          [mesa.id],
        );
        return found.rows[0]!;
      });
      expect(mesaAbierta.status).toBe('OCUPADA');
      expect(mesaAbierta.order_id).toBe(orderId);

      await asLuna(() =>
        orders.addItem(
          luna.orgId,
          luna.venueId,
          orderId,
          addItemSchema.parse({ productId: producto.id, quantity: 2 }),
          actorCajero(),
        ),
      );

      const detalle = await asLuna(() => orders.orderDetail(luna.orgId, luna.venueId, orderId));

      // El numero que el dominio calcula sobre los mismos items que guardamos.
      const esperado = orderTotals({
        items: detalle.order.items.map((item) => ({
          unitPriceCents: item.unitPriceCents,
          quantity: item.quantity,
          status: item.status,
          modifiers: item.modifiers,
        })),
        currency: 'XXX',
      });

      expect(detalle.order.totalCents).toBe(esperado.totalCents);
      expect(detalle.totals.totalCents).toBe(esperado.totalCents);
      expect(detalle.totals.subtotalCents).toBe(12_000);
      expect(detalle.totals.remainingCents).toBe(12_000);
      expect(detalle.shift?.id).toBe(turnoInicial);

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });

    it('el precio del item lo recalcula el servidor, no el cliente', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 1 }]);

      // El contrato ni siquiera tiene un campo de precio: mandarlo seria descartado por el
      // esquema, y lo que se guarda sale de `products.price_cents`.
      const detalle = await asLuna(() => orders.orderDetail(luna.orgId, luna.venueId, orderId));
      expect(detalle.order.items[0]!.unitPriceCents).toBe(producto.priceCents);
      expect(detalle.order.items[0]!.nameSnapshot).toBe('Milanesa');

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });

    it('con modificadores: el delta y el nombre salen del catalogo', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 1 }]);

      await asLuna(() =>
        orders.addItem(
          luna.orgId,
          luna.venueId,
          orderId,
          addItemSchema.parse({
            productId: producto.id,
            quantity: 1,
            // El cuerpo no manda `priceDeltaCents`: el servidor busca el modificador.
            modifiers: [{ modifierId: modificador.id }],
          }),
          actorCajero(),
        ),
      );

      const detalle = await asLuna(() => orders.orderDetail(luna.orgId, luna.venueId, orderId));
      const item = detalle.order.items[1]!;

      expect(item.modifiers).toHaveLength(1);
      expect(item.modifiers[0]!.name).toBe('Extra queso');
      expect(item.modifiers[0]!.priceDeltaCents).toBe(modificador.priceDeltaCents);

      // El modificador entra dentro del precio de la linea, no como una fila aparte: en un
      // ticket real "milanesa con extra queso" es un producto.
      const esperado = orderTotals({
        items: detalle.order.items.map((i) => ({
          unitPriceCents: i.unitPriceCents,
          quantity: i.quantity,
          status: i.status,
          modifiers: i.modifiers,
        })),
        currency: 'XXX',
      });
      expect(detalle.totals.subtotalCents).toBe(producto.priceCents + producto.priceCents + 900);
      expect(detalle.totals.totalCents).toBe(esperado.totalCents);

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });

    it('el listado trae items, modificadores y pagos ya agregados', async () => {
      const orderId = await comandaCon([{ productId: productoBarato.id, quantity: 3 }]);

      const listado = await asLuna(() =>
        orders.listOrders(luna.orgId, luna.venueId, { status: ['OPEN'], limit: 50, offset: 0 }),
      );
      const encontrada = listado.find((order) => order.id === orderId)!;

      expect(encontrada.items).toHaveLength(1);
      expect(encontrada.paidCents).toBe(0);
      expect(encontrada.remainingCents).toBe(15_000);
      expect(encontrada.tableLabel).not.toBeNull();

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });

    it('no deja abrir dos comandas en la misma mesa', async () => {
      const abierta = await asLuna(() =>
        orders.openOrder(
          luna.orgId,
          luna.venueId,
          openOrderSchema.parse({ tableId: mesa.id }),
          actorCajero(),
        ),
      );

      await rejectsWith(
        asLuna(() =>
          orders.openOrder(
            luna.orgId,
            luna.venueId,
            openOrderSchema.parse({ tableId: mesa.id }),
            actorCajero(),
          ),
        ),
        /ya tiene una comanda abierta/i,
      );

      await asLuna(() =>
        orders.closeOrder(luna.orgId, luna.venueId, abierta.order.id, actorCajero()),
      );
    });

    it('con la misma Idempotency-Key devuelve la comanda que ya abrio, no otra', async () => {
      const key = uuidv7();
      const cuerpo = openOrderSchema.parse({ tableId: mesa.id });

      const primera = await asLuna(() =>
        orders.openOrder(luna.orgId, luna.venueId, cuerpo, actorCajero(), key),
      );
      const segunda = await asLuna(() =>
        orders.openOrder(luna.orgId, luna.venueId, cuerpo, actorCajero(), key),
      );

      expect(primera.replay).toBe(false);
      expect(segunda.replay).toBe(true);
      expect(segunda.order.id).toBe(primera.order.id);

      const abiertas = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ count: string }>(
          `SELECT count(*)::text AS count FROM orders
            WHERE table_id = $1::uuid AND status = 'OPEN'`,
          [mesa.id],
        );
        return Number(found.rows[0]!.count);
      });
      expect(abiertas).toBe(1);

      await asLuna(() =>
        orders.closeOrder(luna.orgId, luna.venueId, primera.order.id, actorCajero()),
      );
    });
  });

  // ---------------------------------------------------------------------------

  describe('anulaciones', () => {
    it('anular sin motivo falla antes de tocar la base', async () => {
      // El motivo lo exige `order_items_void_consistent`: si el contrato lo dejara pasar,
      // el error seria de Postgres (`23514`) y el mozo veria un fallo sin accion posible.
      expect(() => voidItemSchema.parse({})).toThrow(/motivo/i);
      expect(() => voidItemSchema.parse({ reason: '   ' })).toThrow(/motivo/i);
    });

    it('anular baja el total y queda con el importe que dejo de cobrarse', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 2 }]);

      const antes = await asLuna(() => orders.orderDetail(luna.orgId, luna.venueId, orderId));
      const itemId = antes.order.items[0]!.id;

      const detalle = await asLuna(() =>
        orders.voidItem(
          luna.orgId,
          luna.venueId,
          itemId,
          { reason: 'El cliente devolvio el plato.' },
          actorEncargado(),
        ),
      );

      expect(detalle.order.items[0]!.status).toBe('VOIDED');
      expect(detalle.order.items[0]!.voidReason).toBe('El cliente devolvio el plato.');
      expect(detalle.totals.totalCents).toBe(0);

      // El motivo y el importe van al registro: sin eso, "cuanto se descuento por
      // anulaciones" no se puede responder con un filtro.
      const registros = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ action: string; reason: string; after: Record<string, number> }>(
          `SELECT action, reason, after FROM audit_log
            WHERE entity = 'order_item' AND entity_id = $1::text
            ORDER BY created_at DESC LIMIT 1`,
          [itemId],
        );
        return found.rows[0]!;
      });
      expect(registros.action).toBe('order.item_voided');
      expect(registros.reason).toBe('El cliente devolvio el plato.');
      expect(registros.after.removedCents).toBe(12_000);

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });

    it('anular dos veces el mismo item es un conflicto, no una doble devolucion', async () => {
      const orderId = await comandaCon([{ productId: productoBarato.id, quantity: 1 }]);
      const detalle = await asLuna(() => orders.orderDetail(luna.orgId, luna.venueId, orderId));
      const itemId = detalle.order.items[0]!.id;

      await asLuna(() =>
        orders.voidItem(
          luna.orgId,
          luna.venueId,
          itemId,
          { reason: 'Se equivocaron de mesa.' },
          actorEncargado(),
        ),
      );

      await rejectsWith(
        asLuna(() =>
          orders.voidItem(
            luna.orgId,
            luna.venueId,
            itemId,
            { reason: 'Otra vez.' },
            actorEncargado(),
          ),
        ),
        /ya estaba anulado/i,
      );

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });
  });

  // ---------------------------------------------------------------------------

  describe('cobro', () => {
    it('pago mixto cierra la comanda y libera la mesa', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 2 }]);

      const result = await asLuna(() =>
        payments.pay(
          luna.orgId,
          luna.venueId,
          orderId,
          paySchema.parse({
            lines: [
              { method: 'CASH', amountCents: 5000 },
              {
                method: 'CARD',
                amountCents: 7000,
                provider: 'terminal-local',
                providerRef: 'TERM-000123',
              },
            ],
          }),
          actorCajero(),
          uuidv7(),
        ),
      );

      expect(result.closed).toBe(true);
      expect(result.payments).toHaveLength(2);
      expect(result.totals.remainingCents).toBe(0);

      // La mesa se busca por el `table_id` de la comanda y no por su `order_id`: al
      // cerrar, `freeTable` ya lo puso en NULL, y una consulta por `order_id` no
      // encontraria nada justo cuando la liberacion es lo que se quiere verificar.
      const estado = await harness.asOrg(luna.orgId, async (q) => {
        const order = await q<{ status: string; shift_id: string | null; table_id: string | null }>(
          `SELECT status, shift_id, table_id FROM orders WHERE id = $1::uuid`,
          [orderId],
        );
        const row = order.rows[0]!;
        const mesaRow = await q<{ status: string; order_id: string | null }>(
          `SELECT status, order_id FROM tables WHERE id = $1::uuid`,
          [row.table_id],
        );
        return { order: row, mesa: mesaRow.rows[0]! };
      });

      expect(estado.order.status).toBe('CLOSED');
      expect(estado.order.shift_id).toBe(turnoInicial);
      expect(estado.mesa.status).toBe('LIBRE');
      expect(estado.mesa.order_id).toBeNull();

      // El pago externo guarda el comprobante del terminal y nada mas: ningun campo del
      // sistema puede contener el numero de tarjeta (PLAN §6).
      const pagos = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{
          method: string;
          provider_ref: string | null;
          provider: string | null;
        }>(
          `SELECT method, provider_ref, provider FROM payments WHERE order_id = $1::uuid ORDER BY method`,
          [orderId],
        );
        return found.rows;
      });
      expect(pagos).toHaveLength(2);
      const tarjeta = pagos.find((p) => p.method === 'CARD')!;
      expect(tarjeta.provider_ref).toBe('TERM-000123');
      expect(tarjeta.provider).toBe('terminal-local');
    });

    it('el mismo Idempotency-Key dos veces no cobra dos veces', async () => {
      const orderId = await comandaCon([{ productId: productoBarato.id, quantity: 2 }]);
      const key = uuidv7();
      const cuerpo = paySchema.parse({ lines: [{ method: 'CASH', amountCents: 10_000 }] });

      const primero = await asLuna(() =>
        payments.pay(luna.orgId, luna.venueId, orderId, cuerpo, actorCajero(), key),
      );
      const segundo = await asLuna(() =>
        payments.pay(luna.orgId, luna.venueId, orderId, cuerpo, actorCajero(), key),
      );

      expect(primero.closed).toBe(true);
      expect(segundo.replay).toBe(true);
      expect(segundo.payments.map((p) => p.id)).toEqual(primero.payments.map((p) => p.id));

      const count = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ count: string; sum: string }>(
          `SELECT count(*)::text AS count, COALESCE(SUM(amount_cents), 0)::text AS sum
             FROM payments WHERE order_id = $1::uuid`,
          [orderId],
        );
        return found.rows[0]!;
      });

      expect(Number(count.count)).toBe(1);
      expect(Number(count.sum)).toBe(10_000);
    });

    it('un pago insuficiente se rechaza y no deja nada registrado', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 2 }]);

      await rejectsWith(
        asLuna(() =>
          payments.pay(
            luna.orgId,
            luna.venueId,
            orderId,
            paySchema.parse({ lines: [{ method: 'CASH', amountCents: 5000 }] }),
            actorCajero(),
            uuidv7(),
          ),
        ),
        /faltan 7000 centavos/i,
      );

      const pagos = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ count: string }>(
          `SELECT count(*)::text AS count FROM payments WHERE order_id = $1::uuid`,
          [orderId],
        );
        return Number(found.rows[0]!.count);
      });
      expect(pagos).toBe(0);

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });

    it('pagar de mas exige un motivo', async () => {
      const orderId = await comandaCon([{ productId: productoBarato.id, quantity: 1 }]);

      await rejectsWith(
        asLuna(() =>
          payments.pay(
            luna.orgId,
            luna.venueId,
            orderId,
            paySchema.parse({ lines: [{ method: 'CASH', amountCents: 6000 }] }),
            actorCajero(),
            uuidv7(),
          ),
        ),
        /excede la cuenta por 1000/i,
      );

      // Con motivo, el cobro pasa: un cambio mal dado es legitimo si queda escrito.
      const conMotivo = await asLuna(() =>
        payments.pay(
          luna.orgId,
          luna.venueId,
          orderId,
          paySchema.parse({
            lines: [{ method: 'CASH', amountCents: 6000 }],
            overpayReason: 'El cliente se equivocó al sacar el billete.',
          }),
          actorCajero(),
          uuidv7(),
        ),
      );
      expect(conMotivo.closed).toBe(true);
      expect(conMotivo.totals.paidCents).toBe(6000);
      expect(conMotivo.totals.remainingCents).toBe(-1000);
    });

    it('el cobro se audita con importe, metodo y referencia del proveedor', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 1 }]);
      await asLuna(() =>
        payments.pay(
          luna.orgId,
          luna.venueId,
          orderId,
          paySchema.parse({
            lines: [
              {
                method: 'QR',
                amountCents: producto.priceCents,
                provider: 'pasarela',
                providerRef: 'QR-9988',
              },
            ],
          }),
          actorCajero(),
          uuidv7(),
        ),
      );

      const registro = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ action: string; actor_id: string; after: Record<string, unknown> }>(
          `SELECT action, actor_id, after FROM audit_log
            WHERE action = 'bill.paid' ORDER BY created_at DESC LIMIT 1`,
        );
        return found.rows[0]!;
      });

      expect(registro.action).toBe('bill.paid');
      expect(registro.actor_id).toBe(cajero.userId);
      expect(registro.after.amountCents).toBe(producto.priceCents);
      expect(registro.after.method).toBe('QR');
      expect(registro.after.providerRef).toBe('QR-9988');
    });

    it('remainingToPay es total menos pagado, en enteros', async () => {
      const orderId = await comandaCon([{ productId: productoBarato.id, quantity: 2 }]);

      const antes = await asLuna(() => payments.remainingToPay(luna.orgId, luna.venueId, orderId));
      expect(antes.totalCents).toBe(10_000);
      expect(antes.paidCents).toBe(0);
      expect(antes.remainingCents).toBe(10_000);
      expect(Number.isInteger(antes.remainingCents)).toBe(true);

      await asLuna(() =>
        payments.pay(
          luna.orgId,
          luna.venueId,
          orderId,
          paySchema.parse({ lines: [{ method: 'CASH', amountCents: 10_000 }] }),
          actorCajero(),
          uuidv7(),
        ),
      );

      const despues = await asLuna(() =>
        payments.remainingToPay(luna.orgId, luna.venueId, orderId),
      );
      expect(despues.paidCents).toBe(10_000);
      expect(despues.remainingCents).toBe(0);
    });

    it('sin caja abierta no se puede cobrar', async () => {
      // El escenario que hace falta para el resto del archivo: con el turno cerrado, el
      // cobro tiene que fallar con un mensaje que diga que abrir la caja.
      const orderId = await comandaCon([{ productId: productoBarato.id, quantity: 1 }]);

      await harness.asOrg(luna.orgId, async (q) => {
        await q(
          `UPDATE shifts SET status = 'CLOSED', closed_at = now(), declared_cash_cents = 0,
                  expected_cash_cents = 0, diff_cents = 0
            WHERE id = $1::uuid`,
          [turnoInicial],
        );
      });

      await rejectsWith(
        asLuna(() =>
          payments.pay(
            luna.orgId,
            luna.venueId,
            orderId,
            paySchema.parse({
              lines: [{ method: 'CASH', amountCents: productoBarato.priceCents }],
            }),
            actorCajero(),
            uuidv7(),
          ),
        ),
        /no hay caja abierta/i,
      );

      turnoInicial = (
        await asLuna(() =>
          cash.openShift(luna.orgId, luna.venueId, { openingFloatCents: 0 }, actorCajero()),
        )
      ).id;

      await asLuna(() =>
        payments.pay(
          luna.orgId,
          luna.venueId,
          orderId,
          paySchema.parse({ lines: [{ method: 'CASH', amountCents: productoBarato.priceCents }] }),
          actorCajero(),
          uuidv7(),
        ),
      );
    });
  });

  // ---------------------------------------------------------------------------

  describe('division de cuenta', () => {
    it('divide en partes iguales y las partes suman el total exacto', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 3 }]);

      const split = await asLuna(() =>
        payments.splitBill(
          luna.orgId,
          luna.venueId,
          orderId,
          // 18000 entre 3 no es divisible: el resto va a la primera parte y las tres
          // siguen sumando 18000 exactos.
          splitBillSchema.parse({ mode: 'EQUAL', parts: 3 }),
          actorCajero(),
        ),
      );

      expect(split.allocations).toHaveLength(3);
      expect(split.allocations.reduce((acc, a) => acc + a.amountCents, 0)).toBe(18_000);
      expect(split.totalCents).toBe(18_000);
      // Cada parte tiene su propio id uuid: es la identidad con la que la pantalla marca
      // "esta parte ya se pago".
      expect(new Set(split.allocations.map((a) => a.id)).size).toBe(3);

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });

    it('rechaza un reparto que no suma el total, diciendo los dos numeros', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 1 }]);

      await rejectsWith(
        asLuna(() =>
          payments.splitBill(
            luna.orgId,
            luna.venueId,
            orderId,
            splitBillSchema.parse({
              mode: 'EQUAL',
              allocations: [
                { label: 'Parte 1', amountCents: 1000, itemIds: [] },
                { label: 'Parte 2', amountCents: 1000, itemIds: [] },
              ],
            }),
            actorCajero(),
          ),
        ),
        /reparto suma 2000 y la cuenta tiene 6000/i,
      );

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });

    it('el reparto guardado aparece en el detalle de la comanda', async () => {
      const orderId = await comandaCon([{ productId: productoBarato.id, quantity: 2 }]);

      await asLuna(() =>
        payments.splitBill(
          luna.orgId,
          luna.venueId,
          orderId,
          splitBillSchema.parse({ mode: 'BY_ITEM' }),
          actorCajero(),
        ),
      );

      const detalle = await asLuna(() => orders.orderDetail(luna.orgId, luna.venueId, orderId));
      expect(detalle.splits).toHaveLength(1);
      expect(detalle.splits[0]!.mode).toBe('BY_ITEM');
      expect(detalle.splits[0]!.allocations.reduce((acc, a) => acc + a.amountCents, 0)).toBe(
        10_000,
      );

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });
  });

  // ---------------------------------------------------------------------------

  describe('propinas', () => {
    it('suma la propina al total y sugiere los porcentajes del local', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 1 }]);

      const sugerencias = await asLuna(() =>
        orders.tipSuggestions(luna.orgId, luna.venueId, orderId, { bps: '500,1000' }),
      );
      expect(sugerencias.basisPoints).toEqual([500, 1000]);
      // 10% de 6000 son 600: el redondeo a centavos lo hace el dominio, no el endpoint.
      expect(sugerencias.amountsCents).toEqual([300, 600]);

      const conPropina = await asLuna(() =>
        payments.addTip(luna.orgId, luna.venueId, orderId, { basisPoints: 1000 }),
      );

      expect(conPropina.tipCents).toBe(600);
      // El total incluye la propina: sin recalcular, `total_cents` y `tip_cents` dirian
      // cosas distintas y el cobro saldria mal.
      expect(conPropina.totals.totalCents).toBe(6600);

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, orderId, actorCajero()));
    });
  });

  // ---------------------------------------------------------------------------

  describe('transferencia y union', () => {
    it('transferir mueve la comanda y deja las dos mesas coherentes', async () => {
      const abierta = await asLuna(() =>
        orders.openOrder(
          luna.orgId,
          luna.venueId,
          openOrderSchema.parse({ tableId: mesa.id }),
          actorCajero(),
        ),
      );

      const detalle = await asLuna(() =>
        orders.transferOrder(
          luna.orgId,
          luna.venueId,
          abierta.order.id,
          { toTableId: mesaLibre.id },
          actorCajero(),
        ),
      );

      expect(detalle.order.tableId).toBe(mesaLibre.id);
      expect(detalle.order.tableLabel).toBe('H2');

      const mesas = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ id: string; status: string; order_id: string | null }>(
          `SELECT id, status, order_id FROM tables WHERE id = ANY($1::uuid[]) ORDER BY label`,
          [[mesa.id, mesaLibre.id]],
        );
        return found.rows;
      });
      expect(mesas.find((t) => t.id === mesa.id)!.status).toBe('LIBRE');
      expect(mesas.find((t) => t.id === mesaLibre.id)!.order_id).toBe(abierta.order.id);

      await asLuna(() =>
        orders.closeOrder(luna.orgId, luna.venueId, abierta.order.id, actorCajero()),
      );
    });

    it('unir dos comandas deja los items en la de destino y cierra la absorbida', async () => {
      const primera = await comandaCon([{ productId: productoBarato.id, quantity: 1 }]);
      const segunda = await comandaCon([{ productId: producto.id, quantity: 1 }], mesaExtra.id);

      const detalle = await asLuna(() =>
        orders.mergeOrders(luna.orgId, luna.venueId, primera, segunda, actorCajero()),
      );

      // Sobrevive la de destino, que es la que tiene la mesa, y recibe los items de la
      // absorbida: el total es la suma de las dos cuentas, no el de una sola.
      expect(detalle.order.id).toBe(segunda);
      expect(detalle.order.tableId).toBe(mesaExtra.id);
      expect(detalle.order.totalCents).toBe(11_000);
      expect(detalle.order.items).toHaveLength(2);

      // La comanda absorbida queda cerrada con turno: `orders_closed_consistent` no
      // permite cerrar sin caja, y sin cerrar quedaria ocupando la mesa para siempre.
      const origen = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ status: string; shift_id: string | null; table_id: string | null }>(
          `SELECT status, shift_id, table_id FROM orders WHERE id = $1::uuid`,
          [primera],
        );
        return found.rows[0]!;
      });
      expect(origen.status).toBe('CLOSED');
      expect(origen.shift_id).not.toBeNull();

      // Y la mesa de la comanda absorbida quedo libre.
      const mesaLiberada = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ status: string; order_id: string | null }>(
          `SELECT status, order_id FROM tables WHERE id = $1::uuid`,
          [mesaLibre.id],
        );
        return found.rows[0]!;
      });
      expect(mesaLiberada.status).toBe('LIBRE');
      expect(mesaLiberada.order_id).toBeNull();

      await asLuna(() => orders.closeOrder(luna.orgId, luna.venueId, segunda, actorCajero()));
    });
  });

  // ---------------------------------------------------------------------------

  describe('caja: turnos, movimientos y arqueo ciego', () => {
    it('no deja abrir dos cajas a la vez', async () => {
      // En este punto ya hay un turno abierto (lo que las pruebas anteriores dejaron), asi
      // que abrir otro tiene que ser un 409. El camino feliz ya lo cubrio el `beforeAll`.
      await rejectsWith(
        asLuna(() =>
          cash.openShift(luna.orgId, luna.venueId, { openingFloatCents: 500 }, actorCajero()),
        ),
        /la caja ya está abierta/i,
      );
    });

    it('un movimiento exige motivo', () => {
      expect(() =>
        cashMovementSchema.parse({ shiftId: uuidv7(), type: 'IN', amountCents: 100 }),
      ).toThrow(/motivo/i);
    });

    it('IN suma y RETIRO resta: el signo lo decide el tipo', async () => {
      const turno = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ id: string }>(
          `SELECT id FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN' LIMIT 1`,
          [luna.venueId],
        );
        return found.rows[0]!.id;
      });

      const entrada = await asLuna(() =>
        cash.cashMovement(
          luna.orgId,
          luna.venueId,
          cashMovementSchema.parse({
            shiftId: turno,
            type: 'IN',
            amountCents: 5000,
            reason: 'Fondo extra de la caja chica.',
          }),
          actorCajero(),
        ),
      );
      expect(entrada.movement.amountCents).toBe(5000);
      expect(entrada.signedCents).toBe(5000);

      const retiro = await asLuna(() =>
        cash.cashMovement(
          luna.orgId,
          luna.venueId,
          cashMovementSchema.parse({
            shiftId: turno,
            type: 'RETIRO',
            amountCents: 3000,
            reason: 'Faltante para el cambio.',
          }),
          actorCajero(),
        ),
      );
      // El importe se guarda positivo siempre: el signo se aplica al sumar, no al guardar.
      expect(retiro.movement.amountCents).toBe(3000);
      expect(retiro.signedCents).toBe(-3000);

      const guardado = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ type: string; amount_cents: number }>(
          `SELECT type, amount_cents FROM cash_movements WHERE shift_id = $1::uuid ORDER BY created_at DESC LIMIT 2`,
          [turno],
        );
        return found.rows;
      });
      expect(guardado.every((row) => row.amount_cents > 0)).toBe(true);

      const auditoria = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ action: string; reason: string; after: Record<string, number> }>(
          `SELECT action, reason, after FROM audit_log
            WHERE action = 'shift.cash_movement' ORDER BY created_at DESC LIMIT 1`,
        );
        return found.rows[0]!;
      });
      expect(auditoria.reason).toBe('Faltante para el cambio.');
      expect(auditoria.after.signedCents).toBe(-3000);
    });

    it('el arqueo ciego NO le devuelve el esperado al cajero', async () => {
      // Este es el test que define el modulo. El cajero declara lo que tiene SIN ver el
      // esperado: si la respuesta lo trajera, el arqueo seria un conteo con ayuda y el
      // unico que puede "cuadrar" la caja seria el que decide cuanto dice que tiene.
      const turno = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ id: string }>(
          `SELECT id FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN' LIMIT 1`,
          [luna.venueId],
        );
        return found.rows[0]!.id;
      });

      const cerrado = await asLuna(() =>
        cash.closeShift(
          luna.orgId,
          luna.venueId,
          turno,
          closeShiftSchema.parse({ declaredCashCents: 12_345 }),
          actorCajero(),
        ),
      );

      // Las claves no existen en la respuesta. No en `null`: si volvieran en `null`, un
      // cliente que solo mira `!== undefined` las encontraria.
      turnoArqueado = cerrado.id;

      expect(cerrado).not.toHaveProperty('expectedCashCents');
      expect(cerrado).not.toHaveProperty('diffCents');
      expect(cerrado).toHaveProperty('declaredCashCents');
      expect(cerrado.declaredCashCents).toBe(12_345);
      expect(cerrado.status).toBe('CLOSED');

      // Y el numero del esperado no aparece en ningun lado del JSON, que es la forma en
      // que se filtraria de verdad (un log, un `console.log`, un serializado).
      expect(JSON.stringify(cerrado)).not.toContain('expected');

      // El turno abierto tampoco lo expone.
      const abierto = await asLuna(() => cash.currentShift(luna.orgId, luna.venueId));
      expect(abierto).toBeNull();
    });

    it('el esperado se le devuelve a quien tiene cash.viewExpected', async () => {
      const fila = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{
          opening_float_cents: number;
          expected_cash_cents: number;
          declared_cash_cents: number;
          diff_cents: number;
        }>(
          `SELECT opening_float_cents, expected_cash_cents, declared_cash_cents, diff_cents
             FROM shifts WHERE id = $1::uuid`,
          [turnoArqueado],
        );
        return found.rows[0]!;
      });

      const esperado = await asLuna(() =>
        cash.expectedCash(luna.orgId, luna.venueId, turnoArqueado),
      );

      // El servidor guardo los tres: la constraint `shifts_closed_consistent` exige
      // declarado **y** esperado cuando el turno no esta abierto.
      expect(esperado.expectedCashCents).toBe(fila.expected_cash_cents);
      expect(esperado.declaredCashCents).toBe(fila.declared_cash_cents);
      expect(esperado.diffCents).toBe(fila.diff_cents);
      expect(esperado.closedAt).not.toBeNull();

      const informe = await asLuna(() => cash.shiftReport(luna.orgId, luna.venueId, turnoArqueado));

      // El informe si los trae, y la diferencia es la que el cajero no pudo ver.
      expect(informe.shift.expectedCashCents).toBe(fila.expected_cash_cents);
      expect(informe.totals.declaredCashCents).toBe(fila.declared_cash_cents);
      expect(informe.totals.diffCents).toBe(fila.declared_cash_cents - fila.expected_cash_cents);
      expect(informe.totals.openingFloatCents).toBe(fila.opening_float_cents);
      expect(informe.movements.every((movimiento) => movimiento.amountCents > 0)).toBe(true);
    });

    it('el esperado sale del fondo mas el efectivo del turno menos lo que salio', async () => {
      // Un turno limpio, con una sola venta en efectivo y un retiro, para que la cuenta del
      // arqueo se pueda verificar a mano.
      const turno = (
        await asLuna(() =>
          cash.openShift(luna.orgId, luna.venueId, { openingFloatCents: 10_000 }, actorCajero()),
        )
      ).id;

      const orderId = await comandaCon([{ productId: producto.id, quantity: 1 }]);
      await asLuna(() =>
        payments.pay(
          luna.orgId,
          luna.venueId,
          orderId,
          paySchema.parse({ lines: [{ method: 'CASH', amountCents: producto.priceCents }] }),
          actorCajero(),
          uuidv7(),
        ),
      );

      await asLuna(() =>
        cash.cashMovement(
          luna.orgId,
          luna.venueId,
          cashMovementSchema.parse({
            shiftId: turno,
            type: 'OUT',
            amountCents: 2500,
            reason: 'Se llevo el vuelto al proveedor.',
          }),
          actorCajero(),
        ),
      );

      // 10000 de fondo + 6000 en efectivo - 2500 que salieron.
      const esperado = await asLuna(() => cash.expectedCash(luna.orgId, luna.venueId, turno));
      expect(esperado.expectedCashCents).toBe(13_500);

      const cerrado = await asLuna(() =>
        cash.closeShift(
          luna.orgId,
          luna.venueId,
          turno,
          closeShiftSchema.parse({ declaredCashCents: 13_500 }),
          actorCajero(),
        ),
      );
      expect(cerrado).not.toHaveProperty('diffCents');

      const informe = await asLuna(() => cash.shiftReport(luna.orgId, luna.venueId, turno));
      expect(informe.totals.expectedCashCents).toBe(13_500);
      expect(informe.totals.diffCents).toBe(0);
      expect(informe.totals.cashSalesCents).toBe(6000);
      expect(informe.totals.cashOutCents).toBe(2500);
    });
  });

  // ---------------------------------------------------------------------------

  describe('aislamiento entre organizaciones', () => {
    it('una comanda de la org A no se lee desde la org B', async () => {
      const orderId = await comandaCon([{ productId: producto.id, quantity: 1 }]);

      await rejectsWith(
        asOrion(() => orders.orderDetail(orion.orgId, orion.venueId, orderId)),
        /no existe en este local/i,
      );

      const listadoOrion = await asOrion(() =>
        orders.listOrders(orion.orgId, orion.venueId, { limit: 50, offset: 0 }),
      );
      expect(listadoOrion.find((order) => order.id === orderId)).toBeUndefined();

      // Tampoco se puede cobrar ni anular desde el otro local: el RLS filtra la lectura, y
      // una escritura sobre una fila invisible no toca nada.
      await rejectsWith(
        asOrion(() =>
          payments.pay(
            orion.orgId,
            orion.venueId,
            orderId,
            paySchema.parse({ lines: [{ method: 'CASH', amountCents: 6000 }] }),
            actorCajero(),
            uuidv7(),
          ),
        ),
        /no existe en este local/i,
      );

      const pagos = await harness.asOrg(luna.orgId, async (q) => {
        const found = await q<{ count: string }>(
          `SELECT count(*)::text AS count FROM payments WHERE order_id = $1::uuid`,
          [orderId],
        );
        return Number(found.rows[0]!.count);
      });
      expect(pagos).toBe(0);
      // La comanda queda abierta a proposito: es el ultimo test y la caja ya esta
      // cerrada, asi que no habria forma de cerrarla. `afterAll` borra el tenant.
    });
  });
});
