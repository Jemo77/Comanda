import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { uuidv7, type ProblemDetails } from '@comanda/domain';
import { loadEnv, type AppEnv } from '../../src/config/env';
import { DatabaseService, type TenantContext } from '../../src/database/database.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import {
  DEFAULT_OCCUPANCY_ALERT_MINUTES,
  TablesService,
  computeOccupancy,
  type TableStatusActor,
} from '../../src/modules/tables/tables.service';
import {
  createTableSchema,
  setTableStatusSchema,
  updateTableSchema,
  type CreateTableInput,
} from '../../src/modules/tables/tables.types';
import { createTestDatabase, truncateAuditLog, truncateOrg } from '../support/db';
import type { TestDatabase } from '../support/env';

/**
 * Salon: sectores, mesas, plano y temporizador, contra PostgreSQL real.
 *
 * La RLS y la constraint `tables_occupied_consistent` son funciones del motor: ningun
 * doble las reproduce. Estos tests las ejercitan de verdad, con el rol `comanda_app`.
 */
describe('tables: sectores, mesas y plano', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let tables: TablesService;
  let env: AppEnv;

  const luna = { orgId: '', venueId: '' };
  const orion = { orgId: '', venueId: '' };

  const floorSalon = { id: '' };
  const floorTerraza = { id: '' };
  /** M1: queda OCUPADA con una comanda abierta desde el `beforeAll`. */
  const table1 = { id: '' };
  const table2 = { id: '' };
  const table3 = { id: '' };

  /**
   * Corre un bloque dentro de una transaccion con el contexto de tenant puesto, igual
   * que lo hace el `TenantContextInterceptor` en produccion.
   *
   * No alcanza con `db.withTenant`: ese metodo abre su propia conexion, y `db.query()`
   * solo ve el contexto si esta en la transaccion **ambiental** que arma el
   * interceptor. Sin esto, las lecturas darian vacias (la RLS responde con cero filas, no
   * con un error) y los INSERT darian error de policy: dos fallos que parecen bugs del
   * servicio y son falta de contexto.
   *
   * El trabajo se arranca dentro de la `factory` a proposito: es lo unico que corre con
   * el contexto en el `AsyncLocalStorage`, porque la suscripcion al Observable ocurre
   * despues y ya esta afuera. El `Subject` es el puente para que el fin del trabajo
   * cierre la transaccion, y se resuelve en `complete`, que el interceptor emite
   * DESPUES del COMMIT.
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
    inTenant({ orgId: luna.orgId, venueId: luna.venueId }, work);
  const asOrion = <T>(work: () => Promise<T>) =>
    inTenant({ orgId: orion.orgId, venueId: orion.venueId }, work);

  /** Actor ficticio: `audit_log.actor_id` no tiene clave foranea. */
  const lunaActor = (): TableStatusActor => ({
    orgId: luna.orgId,
    venueId: luna.venueId,
    userId: uuidv7(),
    name: 'Mozo de prueba',
    deviceId: null,
  });

  /**
   * Verifica que la operacion falla **con ese mensaje**.
   *
   * Compara el `detail` del problem+json y no `error.message`: cuando Nest recibe un
   * objeto en el constructor, `message` queda en "Conflict Exception" y el texto que
   * ve el mozo vive en el `detail`. Los tests comparan ese texto porque es el contrato
   * que la UI muestra y lo que evita que un mozo entienda el error como que fallo algo.
   */
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

  /** Crea una mesa en Orion para probar el aislamiento en los dos sentidos. */
  const createOrionTable = async (): Promise<string> => {
    const floor = await asOrion(() =>
      tables.createFloor(orion.orgId, orion.venueId, { name: 'Orion', sort: 0 }, lunaActor()),
    );
    const mesa = await asOrion(() =>
      tables.createTable(
        orion.orgId,
        orion.venueId,
        createTableSchema.parse({ floorId: floor.id, label: 'O1' }),
        lunaActor(),
      ),
    );
    return mesa.id;
  };

  /** Pasa la entrada por el mismo esquema que el controller. */
  const tableInput = (input: { label: string; floorId?: string } & Partial<CreateTableInput>) =>
    createTableSchema.parse({ floorId: floorSalon.id, ...input });

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
    tables = new TablesService(db, new AuditService(db, env));

    const lunaOrg = await harness.createOrg('Mesas Luna');
    luna.orgId = lunaOrg.orgId;
    luna.venueId = lunaOrg.venueId;
    const orionOrg = await harness.createOrg('Mesas Orion');
    orion.orgId = orionOrg.orgId;
    orion.venueId = orionOrg.venueId;

    await asLuna(async () => {
      floorSalon.id = (
        await tables.createFloor(luna.orgId, luna.venueId, { name: 'Salon', sort: 0 }, lunaActor())
      ).id;
      floorTerraza.id = (
        await tables.createFloor(
          luna.orgId,
          luna.venueId,
          { name: 'Terraza', sort: 1 },
          lunaActor(),
        )
      ).id;

      table1.id = (
        await tables.createTable(
          luna.orgId,
          luna.venueId,
          tableInput({ label: 'M1', x: 10, y: 20 }),
          lunaActor(),
        )
      ).id;
      table2.id = (
        await tables.createTable(
          luna.orgId,
          luna.venueId,
          tableInput({ label: 'M2', seats: 4, w: 150 }),
          lunaActor(),
        )
      ).id;
      table3.id = (
        await tables.createTable(
          luna.orgId,
          luna.venueId,
          tableInput({ label: 'T1', floorId: floorTerraza.id }),
          lunaActor(),
        )
      ).id;
    });

    // M1 queda ocupada con una comanda abierta, como la deja `applyOrderOpened` del
    // sync: es el estado con el que el mapa realmente trabaja.
    await harness.asOrg(luna.orgId, async (q) => {
      const order = await q<{ id: string }>(
        `INSERT INTO orders (org_id, venue_id, table_id, channel, status, number_label)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'POS', 'OPEN', 'A-104')
         RETURNING id`,
        [luna.orgId, luna.venueId, table1.id],
      );
      await q(
        `UPDATE tables
            SET status = 'OCUPADA', order_id = $2::uuid,
                occupied_since = now() - interval '150 minutes'
          WHERE id = $1::uuid`,
        [table1.id, order.rows[0]!.id],
      );
    });
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

  describe('sectores y plano', () => {
    it('lista los sectores con el conteo de mesas', async () => {
      const floors = await asLuna(() => tables.listFloors(luna.orgId, luna.venueId));

      expect(floors.map((f) => f.name)).toEqual(['Salon', 'Terraza']);
      expect(floors.map((f) => f.tableCount)).toEqual([2, 1]);
    });

    it('devuelve el plano completo agrupado por sector, con la geometria', async () => {
      const plan = await asLuna(() => tables.floorPlan(luna.orgId, luna.venueId));

      expect(plan.floors).toHaveLength(2);
      const salon = plan.floors.find((f) => f.id === floorSalon.id)!;
      const terraza = plan.floors.find((f) => f.id === floorTerraza.id)!;

      expect(salon.tables.map((t) => t.label)).toEqual(['M1', 'M2']);
      expect(terraza.tables.map((t) => t.label)).toEqual(['T1']);
      expect(plan.floors.reduce((n, f) => n + f.tables.length, 0)).toBe(3);

      const m1 = salon.tables[0]!;
      expect(m1.x).toBe(10);
      expect(m1.y).toBe(20);
      expect(m1.w).toBe(100);
      expect(m1.seats).toBe(2);

      const m2 = salon.tables[1]!;
      expect(m2.status).toBe('LIBRE');
      expect(m2.occupiedSince).toBeNull();
      expect(m2.orderNumberLabel).toBeNull();
    });

    it('filtra las mesas por sector', async () => {
      const terraza = await asLuna(() =>
        tables.listTables(luna.orgId, luna.venueId, floorTerraza.id),
      );
      expect(terraza.map((t) => t.label)).toEqual(['T1']);

      const todas = await asLuna(() => tables.listTables(luna.orgId, luna.venueId));
      expect(todas).toHaveLength(3);
    });

    it('trae estado, ocupacion y numero de comanda de la mesa ocupada en la misma fila', async () => {
      const rows = await asLuna(() => tables.listTables(luna.orgId, luna.venueId, floorSalon.id));
      const m1 = rows.find((t) => t.id === table1.id)!;

      expect(m1.status).toBe('OCUPADA');
      expect(m1.orderNumberLabel).toBe('A-104');
      expect(m1.occupiedSince).not.toBeNull();
    });

    it('renombra un sector', async () => {
      const renamed = await asLuna(() =>
        tables.renameFloor(
          luna.orgId,
          luna.venueId,
          floorTerraza.id,
          { name: 'Terraza Norte' },
          lunaActor(),
        ),
      );
      expect(renamed.name).toBe('Terraza Norte');

      const floors = await asLuna(() => tables.listFloors(luna.orgId, luna.venueId));
      expect(floors.map((f) => f.name)).toEqual(['Salon', 'Terraza Norte']);
    });

    it('no deja colgar una mesa de un sector de otro local', async () => {
      // La clave foranea de `tables.floor_id` solo garantiza que el sector exista en
      // ALGUN local de la organizacion: sin el chequeo del servicio, una mesa del Salon
      // de Luna podria aparecer en el plano de Orion.
      await rejectsWith(
        asOrion(() =>
          tables.createTable(
            orion.orgId,
            orion.venueId,
            createTableSchema.parse({ floorId: floorSalon.id, label: 'X1' }),
            lunaActor(),
          ),
        ),
        /sector no existe/i,
      );
    });

    it('rechaza una geometria fuera de la grilla', async () => {
      expect(
        createTableSchema.safeParse({ floorId: floorSalon.id, label: 'M9', x: 999_999 }).success,
      ).toBe(false);
      expect(updateTableSchema.safeParse({ x: Number.POSITIVE_INFINITY }).success).toBe(false);
    });
  });

  describe('edicion de mesa', () => {
    it('cambia nombre, lugares y geometria', async () => {
      const updated = await asLuna(() =>
        tables.updateTable(
          luna.orgId,
          luna.venueId,
          table3.id,
          { label: 'T1-bis', seats: 6, x: 300, y: 40, shape: 'round' },
          lunaActor(),
        ),
      );

      expect(updated.label).toBe('T1-bis');
      expect(updated.seats).toBe(6);
      expect(updated.x).toBe(300);
      expect(updated.shape).toBe('round');
    });

    it('no deja cambiar el estado por la via de la edicion', async () => {
      // `status` no esta en `updateTableSchema`: el estado lo deriva la comanda.
      expect(updateTableSchema.safeParse({ status: 'OCUPADA' }).success).toBe(false);
    });
  });

  describe('cambio de estado', () => {
    it('rechaza OCUPADA y deja la mesa como estaba', async () => {
      await rejectsWith(
        asLuna(() => tables.setStatus(table3.id, 'OCUPADA', lunaActor())),
        /abrí la comanda/i,
      );

      const after = await asLuna(() => tables.tableById(luna.orgId, luna.venueId, table3.id));
      expect(after!.status).toBe('LIBRE');
    });

    it('rechaza PIDIO_CUENTA con un mensaje que dice por que', async () => {
      await rejectsWith(
        asLuna(() => tables.setStatus(table3.id, 'PIDIO_CUENTA', lunaActor())),
        /no se ocupa a mano/i,
      );
    });

    it('el enum del dominio acepta los cinco estados aunque el servicio rechace dos', async () => {
      // El recorte es del servicio, no del esquema: el POS recibe un 409 con que hacer
      // en vez de un 422 de "valor invalido".
      expect(setTableStatusSchema.safeParse({ status: 'OCUPADA' }).success).toBe(true);
    });

    it('bloquea y desbloquea una mesa libre', async () => {
      const blocked = await asLuna(() => tables.setStatus(table3.id, 'BLOQUEADA', lunaActor()));
      expect(blocked.status).toBe('BLOQUEADA');
      expect(blocked.orderId).toBeNull();
      expect(blocked.occupiedSince).toBeNull();

      const free = await asLuna(() => tables.setStatus(table3.id, 'LIBRE', lunaActor()));
      expect(free.status).toBe('LIBRE');
    });

    it('no deja bloquear una mesa ocupada: primero hay que cerrar la comanda', async () => {
      await rejectsWith(
        asLuna(() => tables.setStatus(table1.id, 'BLOQUEADA', lunaActor())),
        /cerrá la comanda/i,
      );
    });

    it('audita el cambio de estado con el estado anterior', async () => {
      await asLuna(() => tables.setStatus(table3.id, 'RESERVADA', lunaActor()));

      const rows = await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q<{ action: string; before: unknown; after: unknown }>(
          `SELECT action, before, after FROM audit_log
            WHERE entity = 'table' AND entity_id = $1 AND action = 'table.status_changed'
            ORDER BY created_at DESC LIMIT 1`,
          [table3.id],
        ),
      );

      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.before).toEqual({ status: 'LIBRE' });
      expect(rows.rows[0]!.after).toEqual({ status: 'RESERVADA' });
    });
  });

  describe('la constraint de la base', () => {
    it('no acepta una mesa OCUPADA sin comanda', async () => {
      // `tables_occupied_consistent`: OCUPADA o PIDIO_CUENTA exigen `order_id` Y
      // `occupied_since`. Es la garantia de que una mesa del mapa siempre tiene una
      // comanda detras. Se prueba la constraint real, no una validacion de la app.
      await expect(
        harness.asOrg(luna.orgId, (q) =>
          q(
            `UPDATE tables SET status = 'OCUPADA', order_id = NULL, occupied_since = now()
              WHERE id = $1::uuid`,
            [table3.id],
          ),
        ),
      ).rejects.toThrow(/tables_occupied_consistent/);
    });

    it('la constraint no cubre la dirección inversa: libre con comanda colgando', async () => {
      // Postgres ACEPTARIA esto (la constraint solo dice "ocupada => comanda"). Por eso
      // el servicio limpia `order_id` y `occupied_since` juntos al cambiar el estado:
      // la otra mitad de la invariante la sostiene la app, no la base.
      const orderId = await harness.asOrg(luna.orgId, async (q) => {
        const order = await q<{ id: string }>(
          `INSERT INTO orders (org_id, venue_id, channel, status, number_label)
           VALUES ($1::uuid, $2::uuid, 'POS', 'OPEN', 'A-999') RETURNING id`,
          [luna.orgId, luna.venueId],
        );
        await q(
          `UPDATE tables SET status = 'LIBRE', order_id = $2::uuid, occupied_since = NULL
            WHERE id = $1::uuid`,
          [table2.id, order.rows[0]!.id],
        );
        return order.rows[0]!.id;
      });

      const suelta = await harness.asOrg(luna.orgId, (q) =>
        q<{ order_id: string | null }>(`SELECT order_id FROM tables WHERE id = $1::uuid`, [
          table2.id,
        ]),
      );
      expect(suelta.rows[0]!.order_id).toBe(orderId);

      await asLuna(() => tables.setStatus(table2.id, 'BLOQUEADA', lunaActor()));

      const limpia = await harness.asOrg(luna.orgId, (q) =>
        q<{ order_id: string | null; occupied_since: Date | null }>(
          `SELECT order_id, occupied_since FROM tables WHERE id = $1::uuid`,
          [table2.id],
        ),
      );
      expect(limpia.rows[0]!.order_id).toBeNull();
      expect(limpia.rows[0]!.occupied_since).toBeNull();
    });

    it('rechaza un estado fuera del enum de la base', async () => {
      await expect(
        harness.asOrg(luna.orgId, (q) =>
          q(`UPDATE tables SET status = 'OCUPADA_X' WHERE id = $1::uuid`, [table3.id]),
        ),
      ).rejects.toThrow(/tables_status_valid/);
    });
  });

  describe('temporizador de ocupacion', () => {
    it('calcula los minutos con el reloj inyectado', () => {
      const now = new Date('2026-03-01T12:00:00.000Z');

      expect(computeOccupancy('2026-03-01T10:30:00.000Z', { now })!.minutes).toBe(90);
      // Trunca, no redondea: 119 minutos y medio siguen siendo 119.
      expect(computeOccupancy('2026-03-01T10:00:30.000Z', { now })!.minutes).toBe(119);
      // Un reloj atrasado no puede dar minutos negativos.
      expect(computeOccupancy('2026-03-01T13:00:00.000Z', { now })!.minutes).toBe(0);
      expect(computeOccupancy(null)).toBeNull();
    });

    it('avisa a los 120 minutos por defecto y el umbral se puede cambiar', () => {
      const now = new Date('2026-03-01T12:00:00.000Z');
      const haceDosHoras = '2026-03-01T10:00:00.000Z';

      const porDefecto = computeOccupancy(haceDosHoras, { now })!;
      expect(DEFAULT_OCCUPANCY_ALERT_MINUTES).toBe(120);
      expect(porDefecto.thresholdMinutes).toBe(120);
      expect(porDefecto.isOverdue).toBe(true);

      // El umbral es una politica del local, no un dato: por eso es un parametro.
      expect(computeOccupancy(haceDosHoras, { now, thresholdMinutes: 180 })!.isOverdue).toBe(false);
      // Diez minutos contra un umbral de 15: todavia no avisa.
      expect(
        computeOccupancy('2026-03-01T11:50:00.000Z', { now, thresholdMinutes: 15 })!.isOverdue,
      ).toBe(false);
    });

    it('el servicio lee el temporizador de la mesa ocupada de verdad', async () => {
      const timer = await asLuna(() => tables.occupiedSince(table1.id));

      expect(timer).not.toBeNull();
      expect(timer!.thresholdMinutes).toBe(120);
      // La mesa quedo ocupada hace 150 minutos en el fixture del `beforeAll`.
      expect(timer!.minutes).toBeGreaterThanOrEqual(149);
      expect(timer!.minutes).toBeLessThanOrEqual(151);
      expect(timer!.isOverdue).toBe(true);
    });

    it('una mesa libre no tiene temporizador', async () => {
      expect(await asLuna(() => tables.occupiedSince(table3.id))).toBeNull();
    });
  });

  describe('aislamiento entre organizaciones', () => {
    it('Orion no ve las mesas de Luna', async () => {
      const desdeOrion = await asOrion(() => tables.listTables(orion.orgId, orion.venueId));
      expect(desdeOrion).toHaveLength(0);

      const porId = await asOrion(() => tables.tableById(orion.orgId, orion.venueId, table1.id));
      expect(porId).toBeNull();

      const plan = await asOrion(() => tables.floorPlan(orion.orgId, orion.venueId));
      expect(plan.floors).toHaveLength(0);

      const sectores = await asOrion(() => tables.listFloors(orion.orgId, orion.venueId));
      expect(sectores).toHaveLength(0);
    });

    it('cada local ve solo lo suyo, en los dos sentidos', async () => {
      const mesaOrion = await createOrionTable();

      const deOrion = await asOrion(() => tables.listTables(orion.orgId, orion.venueId));
      expect(deOrion.map((t) => t.label)).toEqual(['O1']);

      const deLuna = await asLuna(() => tables.listTables(luna.orgId, luna.venueId));
      expect(deLuna.map((t) => t.label)).not.toContain('O1');

      const desdeLunaPorId = await asLuna(() =>
        tables.tableById(luna.orgId, luna.venueId, mesaOrion),
      );
      expect(desdeLunaPorId).toBeNull();
    });

    it('la consulta cruda sin filtro de org tampoco cruza la frontera', async () => {
      // La property clave: el servicio no filtra por `org_id` y aun asi no fuga. Lo que
      // filtra es la RLS. El `SELECT` de abajo no trae `org_id` en el WHERE a proposito.
      const mesaOrion = await createOrionTable();

      const conContexto = await harness.asOrg(luna.orgId, (q) =>
        q<{ id: string }>(`SELECT id FROM tables`),
      );
      const sinContexto = await harness.query<{ id: string }>(`SELECT id FROM tables`);

      const ids = conContexto.rows.map((r) => r.id);
      expect(ids).toContain(table1.id);
      expect(ids).not.toContain(mesaOrion);
      expect(sinContexto.rows).toHaveLength(0);
    });
  });

  describe('guardado del plano', () => {
    it('mueve varias mesas en una sola llamada', async () => {
      const result = await asLuna(() =>
        tables.bulkSaveLayout(luna.orgId, luna.venueId, [
          { tableId: table1.id, x: 500, y: 600 },
          { tableId: table2.id, x: 700, y: 800, w: 180, h: 120 },
          { tableId: table3.id, x: 900, y: 1000 },
        ]),
      );

      expect(result.updated).toBe(3);

      const mesas = await asLuna(() => tables.listTables(luna.orgId, luna.venueId));
      const porId = new Map(mesas.map((t) => [t.id, t]));

      expect(porId.get(table1.id)!.x).toBe(500);
      expect(porId.get(table1.id)!.y).toBe(600);
      expect(porId.get(table2.id)!.w).toBe(180);
      expect(porId.get(table2.id)!.h).toBe(120);
      expect(porId.get(table3.id)!.x).toBe(900);
    });

    it('arrastrar no cambia el ancho de la mesa', async () => {
      await asLuna(() =>
        tables.bulkSaveLayout(luna.orgId, luna.venueId, [{ tableId: table2.id, x: 750, y: 820 }]),
      );

      const mesa = await asLuna(() => tables.tableById(luna.orgId, luna.venueId, table2.id));
      expect(mesa!.w).toBe(180);
      expect(mesa!.h).toBe(120);
      expect(mesa!.x).toBe(750);
    });

    it('no acepta la misma mesa dos veces en el mismo lote', async () => {
      await rejectsWith(
        asLuna(() =>
          tables.bulkSaveLayout(luna.orgId, luna.venueId, [
            { tableId: table1.id, x: 1, y: 1 },
            { tableId: table1.id, x: 2, y: 2 },
          ]),
        ),
        /dos veces/i,
      );
    });

    it('falla si alguna mesa del lote no es de este local, y no mueve ninguna', async () => {
      const antes = await asLuna(() => tables.tableById(luna.orgId, luna.venueId, table1.id));

      await rejectsWith(
        asLuna(() =>
          tables.bulkSaveLayout(luna.orgId, luna.venueId, [
            { tableId: table1.id, x: 42, y: 42 },
            { tableId: uuidv7(), x: 42, y: 42 },
          ]),
        ),
        /ya no existen/i,
      );

      const despues = await asLuna(() => tables.tableById(luna.orgId, luna.venueId, table1.id));
      expect(despues!.x).toBe(antes!.x);
    });
  });
});
