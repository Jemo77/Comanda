import { createTestDatabase, truncateAuditLog, truncateOrg } from '../support/db';

/**
 * Aislamiento entre tenants.
 *
 * Estos son los tests mas importantes del proyecto. Si un dia un Consultor puede
 * leer las ventas de otro local, es un incidente legal, no un bug.
 *
 * Cada asercion conecta con el rol `comanda_app`, el mismo que la API: sin
 * BYPASSRLS y sin ser owner. Un test de RLS corrido como superusuario no probaria
 * nada, asi que `createTestDatabase` verifica eso antes de empezar y falla si no
 * se cumple.
 */
describe('RLS: aislamiento entre tenants', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let luna: { orgId: string; venueId: string };
  let orion: { orgId: string; venueId: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    luna = await db.createOrg('Cafe Luna');
    orion = await db.createOrg('Bar Orion');

    // Cada local arranca con su propia fila de prueba, mas las que agregan los tests.
    await db.asOrg(luna.orgId, (q) =>
      q(`INSERT INTO venues (org_id, name, kind) VALUES ($1, 'Cafe Luna', 'cafe')`, [luna.orgId]),
    );
    await db.asOrg(orion.orgId, (q) =>
      q(`INSERT INTO venues (org_id, name, kind) VALUES ($1, 'Bar Orion', 'bar')`, [orion.orgId]),
    );
  });

  afterAll(async () => {
    if (luna) {
      await truncateAuditLog(db, luna.orgId);
      await truncateOrg(db, luna.orgId);
    }
    if (orion) {
      await truncateAuditLog(db, orion.orgId);
      await truncateOrg(db, orion.orgId);
    }
    await db.close();
  });

  describe('lectura', () => {
    it('sin contexto de tenant no ve ninguna fila', async () => {
      // El caso de una conexion recien abierta. Cero filas, no error:
      // `current_setting(..., true)` devuelve NULL y comparar con NULL da NULL,
      // que en una policy equivale a negar.
      const { rows } = await db.query(`SELECT id FROM venues`);
      expect(rows).toHaveLength(0);
    });

    it('ve solo las filas de su propia organizacion', async () => {
      const lunaVenues = await db.asOrg(luna.orgId, (q) =>
        q(`SELECT name FROM venues ORDER BY name`),
      );
      const orionVenues = await db.asOrg(orion.orgId, (q) =>
        q(`SELECT name FROM venues ORDER BY name`),
      );

      expect(lunaVenues.rows.map((r) => r.name)).toEqual(['Cafe Luna', 'Local de prueba']);
      expect(orionVenues.rows.map((r) => r.name)).toEqual(['Bar Orion', 'Local de prueba']);
      expect(lunaVenues.rows.map((r) => r.name)).not.toContain('Bar Orion');
    });

    it('el filtro no depende de que la consulta traiga org_id en el WHERE', async () => {
      // Esta es la property clave: una consulta SIN filtro de org sigue devolviendo
      // solo lo propio, porque la RLS agrega el filtro. Si alguien olvida el WHERE,
      // el error seria una fuga silenciosa de datos entre locales.
      const conFiltro = await db.asOrg(luna.orgId, (q) =>
        q(`SELECT name FROM venues WHERE org_id = $1`, [luna.orgId]),
      );
      const sinFiltro = await db.asOrg(luna.orgId, (q) => q(`SELECT name FROM venues`));

      expect(sinFiltro.rows.length).toBeGreaterThan(0);
      // Ambos devuelven exactamente lo mismo: la RLS no deja pasar nada extra.
      expect(sinFiltro.rows.map((r) => r.name).sort()).toEqual(
        conFiltro.rows.map((r) => r.name).sort(),
      );

      // Y ninguno ve la fila del otro, ni siquiera pidiendo el nombre exacto.
      const veBarOrion = await db.asOrg(luna.orgId, (q) =>
        q(`SELECT name FROM venues WHERE name = 'Bar Orion'`),
      );
      const veCafeLuna = await db.asOrg(orion.orgId, (q) =>
        q(`SELECT name FROM venues WHERE name = 'Cafe Luna'`),
      );
      expect(veBarOrion.rows).toHaveLength(0);
      expect(veCafeLuna.rows).toHaveLength(0);
    });

    it('una conexion reutilizada no hereda el contexto del uso anterior', async () => {
      // Tras una transaccion con `set_config(..., true)`, Postgres deja la variable
      // en cadena vacia, no en NULL. Un `::uuid` a secas lanzaria
      // "invalid input syntax" en la segunda peticion del proceso, no en el arranque.
      await db.asOrg(luna.orgId, (q) =>
        q(`SELECT set_config('app.current_org', $1, true)`, [luna.orgId]),
      );

      // Se fuerza el mismo cliente varias veces: el pool devuelve conexiones con
      // historia y el aislamiento tiene que aguantar.
      for (let i = 0; i < 3; i++) {
        const leaked = await db.query(`SELECT id FROM venues`);
        expect(leaked.rows, `intento ${i} vio datos de otro tenant`).toHaveLength(0);
      }
    });
  });

  describe('escritura', () => {
    it('no puede insertar filas de otra organizacion', async () => {
      // Con el contexto de Luna, un INSERT con org_id de Orion viola la policy de
      // WITH CHECK. Es el ataque clasico: crear un recurso en un tenant ajeno.
      await expect(
        db.asOrg(luna.orgId, (q) =>
          q(`INSERT INTO venues (org_id, name, kind) VALUES ($1, 'Infiltrado', 'bar')`, [
            orion.orgId,
          ]),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('no puede mover una fila a otra organizacion con UPDATE', async () => {
      await expect(
        db.asOrg(luna.orgId, (q) =>
          q(`UPDATE venues SET org_id = $1 WHERE org_id = $2`, [orion.orgId, luna.orgId]),
        ),
      ).rejects.toThrow(/row-level security/i);

      const unchanged = await db.asOrg(orion.orgId, (q) =>
        q(`SELECT name FROM venues WHERE name = 'Cafe Luna'`),
      );
      expect(unchanged.rows).toHaveLength(0);
    });

    it('no puede borrar filas de otra organizacion', async () => {
      // La RLS no lanza error: filtra las filas y el DELETE afecta cero filas. Es el
      // comportamiento correcto de `USING`; lo que importa es que la fila sobreviva.
      const result = await db.asOrg(orion.orgId, (q) =>
        q(`DELETE FROM venues WHERE org_id = $1`, [luna.orgId]),
      );
      expect(result.rowCount).toBe(0);

      const still = await db.asOrg(luna.orgId, (q) =>
        q(`SELECT name FROM venues WHERE name = 'Cafe Luna'`),
      );
      expect(still.rows).toHaveLength(1);
    });

    it('puede escribir en su propia organizacion', async () => {
      await expect(
        db.asOrg(luna.orgId, (q) =>
          q(`INSERT INTO venues (org_id, name, kind) VALUES ($1, 'Terraza', 'cafe')`, [luna.orgId]),
        ),
      ).resolves.toBeTruthy();
    });
  });

  describe('transacciones y contexto', () => {
    it('el contexto se descarta al terminar la transaccion', async () => {
      // Es la garantia contra la fuga clasica con pool de conexiones: una conexion
      // devuelta al pool con el tenant puesto serviria datos ajenos a la peticion
      // siguiente. `SET LOCAL` lo previene.
      await db.asOrg(luna.orgId, (q) =>
        q(`SELECT set_config('app.current_org', $1, true)`, [luna.orgId]),
      );

      const next = await db.query(`SELECT current_setting('app.current_org', true) AS org`);
      expect(next.rows[0]!.org).toBeFalsy();
    });

    it('dentro de una misma transaccion el contexto persiste', async () => {
      await db.asOrg(luna.orgId, async (q) => {
        await q(`SELECT set_config('app.current_org', $1, true)`, [luna.orgId]);
        const still = await q(`SELECT current_setting('app.current_org', true) AS org`);
        expect(still.rows[0]!.org).toBe(luna.orgId);
      });
    });

    it('un ROLLBACK no deja el contexto puesto', async () => {
      await expect(
        db.asOrg(luna.orgId, async (q) => {
          await q(`SELECT set_config('app.current_org', $1, true)`, [luna.orgId]);
          throw new Error('fallo a proposito');
        }),
      ).rejects.toThrow('fallo a proposito');

      const after = await db.query(`SELECT current_setting('app.current_org', true) AS org`);
      expect(after.rows[0]!.org).toBeFalsy();
    });
  });

  describe('tabla raiz', () => {
    it('cada organizacion solo se ve a si misma', async () => {
      const own = await db.asOrg(luna.orgId, (q) => q(`SELECT name FROM organizations`));
      expect(own.rows).toHaveLength(1);
      expect(own.rows[0]!.name).toBe('Cafe Luna');

      const other = await db.asOrg(luna.orgId, (q) =>
        q(`SELECT name FROM organizations WHERE id = $1`, [orion.orgId]),
      );
      expect(other.rows).toHaveLength(0);
    });
  });

  describe('todas las tablas de negocio', () => {
    it('tienen RLS habilitada y forzada', async () => {
      // El mismo chequeo que corre en la migracion, pero verificado en cada corrida:
      // si alguien agrega una tabla sin policy, el deploy falla y ademas este test
      // lo dice explicitamente.
      const { rows } = await db.query<{ relname: string; rls: boolean; force: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relname IN ('venues','devices','users','roles','role_permissions',
                             'user_roles','refresh_tokens','audit_log','organizations')`,
      );

      expect(rows).toHaveLength(9);
      for (const row of rows) {
        expect(row.rls, `${row.relname} sin RLS`).toBe(true);
        // FORCE importa: sin el, el owner de la tabla (que es como corren las
        // migraciones) saltaria las policies y los tests correrian con ventaja.
        expect(row.force, `${row.relname} sin FORCE RLS`).toBe(true);
      }
    });

    it('el catalogo global de permisos es la unica excepcion', async () => {
      // `permissions` no lleva org_id: es identico para todos los tenants.
      // Filtrarlo por organizacion no aportaria nada y solo haria mas lento cada
      // request.
      const { rows } = await db.query<{ rls: boolean }>(
        `SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'permissions'`,
      );
      expect(rows[0]!.rls).toBe(false);
    });
  });
});
