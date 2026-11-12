import { Pool } from 'pg';
import { TEST_SECRETS, testDatabaseUrl, type TestDatabase } from './env';

/**
 * Base de datos para tests de integracion.
 *
 * Dos conexiones con propositos distintos:
 *
 *  - `app` (rol `comanda_app`): la que se usa en las aserciones. Es el mismo rol
 *    que la API, sin BYPASSRLS y sin ser owner, asi que los tests comprueban la RLS
 *    de verdad.
 *  - `admin` (superusuario): solo para crear y borrar fixtures. Las fixtures no se
 *    pueden crear con el rol app porque las policies no dejan insertar la fila de
 *    `organizations` inicial: es un requisito del modelo, no un bug.
 *
 * Correr TODAS las aserciones con el superusuario daria verde sin comprobar nada,
 * por eso `assertIsolationIsReal` falla si la conexion principal no es un rol sin
 * privilegios.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = testDatabaseUrl();
  const appPool = new Pool({ connectionString: url, max: 6 });
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;

  if (!adminUrl) {
    throw new Error(
      'TEST_DATABASE_ADMIN_URL no esta definida. Se necesita una conexion con ' +
        'privilegios para crear y borrar las fixtures (no se usa para aserciones).',
    );
  }
  const adminPool = new Pool({ connectionString: adminUrl, max: 2 });

  await assertIsolationIsReal(appPool);

  const query = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    const result = await appPool.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  };

  const adminQuery = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    const result = await adminPool.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  };

  /** Ejecuta con `app.current_org` seteado en una transaccion dedicada. */
  const asOrg = async <T>(
    orgId: string,
    fn: (q: TestDatabase['query']) => Promise<T>,
  ): Promise<T> => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_org', $1, true)`, [orgId]);
      // El callback usa ESTA conexion, asi que ve el contexto puesto.
      const scoped: TestDatabase['query'] = async <R extends Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
      };
      const value = await fn(scoped);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const createOrg = async (name = 'Test') => {
    const admin = await adminPool.connect();
    try {
      await admin.query('BEGIN');
      const org = await admin.query<{ id: string }>(
        `INSERT INTO organizations (name, country, currency, timezone)
         VALUES ($1, 'AR', 'ARS', 'America/Argentina/Buenos_Aires') RETURNING id`,
        [name],
      );
      const orgId = org.rows[0]!.id;

      // Contexto de tenant tambien en la conexion admin, para que las policies de
      // `venues` y `roles` la acepten si el admin no fuera superusuario.
      await admin.query(`SELECT set_config('app.current_org', $1, true)`, [orgId]);

      const venue = await admin.query<{ id: string }>(
        `INSERT INTO venues (org_id, name, kind) VALUES ($1, 'Local de prueba', 'bar') RETURNING id`,
        [orgId],
      );

      const role = await admin.query<{ id: string }>(
        `INSERT INTO roles (org_id, key, name, system) VALUES ($1, 'dueno', 'Dueño', true) RETURNING id`,
        [orgId],
      );

      await admin.query('COMMIT');
      return { orgId, venueId: venue.rows[0]!.id, ownerRoleId: role.rows[0]!.id };
    } catch (error) {
      await admin.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      admin.release();
    }
  };

  return {
    url,
    query,
    adminQuery,
    asOrg,
    createOrg,
    close: async () => {
      await appPool.end();
      await adminPool.end();
    },
  };
}

/**
 * Falla temprano si el aislamiento no esta real.
 *
 * Si `TEST_DATABASE_URL` apunta a un superusuario, todas las policies se saltan y
 * los tests de aislamiento darian verde sin comprobar nada. Es el fallo mas
 * silencioso y peligroso que puede tener esta suite, asi que se verifica antes de
 * correr el primer test.
 */
async function assertIsolationIsReal(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    usesuper: boolean;
  }>(
    `SELECT r.rolsuper, r.rolbypassrls, u.usesuper
     FROM pg_roles r
     JOIN pg_user u ON u.usesysid = r.oid
     WHERE r.rolname = current_user`,
  );

  const user = rows[0];
  if (!user) throw new Error('No se pudo identificar el usuario de la conexion de test');

  if (user.rolsuper || user.rolbypassrls || user.usesuper) {
    throw new Error(
      'TEST_DATABASE_URL apunta a un superusuario (o con BYPASSRLS). ' +
        'La RLS se ignoraria y los tests de aislamiento probarian un falso. ' +
        'Usá el rol comanda_app como TEST_DATABASE_URL.',
    );
  }
}

/**
 * Borra los datos de un tenant.
 *
 * `audit_log` es append-only: no se puede TRUNCATE ni DELETE desde el rol de la
 * app, asi que la limpieza va por la conexion admin.
 */
export async function truncateOrg(db: TestDatabase, orgId: string): Promise<void> {
  // Una consulta por tabla: `pg` no admite multiples comandos con parametros
  // ("cannot insert multiple commands into a prepared statement").
  const tables = [
    // Fase 1 primero. El orden importa por las FK: `shifts.opened_by` referencia `users`
    // con ON DELETE RESTRICT, asi que borrar los usuarios antes que los turnos hacia fallar
    // la limpieza de cualquier suite que abra caja.
    'kitchen_tickets',
    // Fase 2 primero: `invoices.order_id` es RESTRICT, asi que hay que borrar los
    // comprobantes antes que las comandas.
    'invoices',
    'fiscal_settings',
    'price_rules',
    'order_item_modifiers',
    'order_items',
    'bill_splits',
    'payments',
    'orders',
    'cash_movements',
    'shifts',
    'tables',
    'floors',
    'product_modifier_groups',
    'modifiers',
    'modifier_groups',
    'products',
    'categories',
    'stations',
    'sync_events',
    // Y despues la Fase 0: `products` cuelga de `categories` con ON DELETE RESTRICT, asi
    // que borrar el local con el catalogo cargado fallaria y la suite seria dependiente de
    // que el test anterior dejara el tenant limpio.
    'refresh_tokens',
    'user_roles',
    'role_permissions',
    'roles',
    'users',
    'devices',
    'venues',
  ];
  for (const table of tables) {
    await db.adminQuery(`DELETE FROM ${table} WHERE org_id = $1::uuid`, [orgId]);
  }
  await db.adminQuery(`DELETE FROM organizations WHERE id = $1::uuid`, [orgId]);
}

/**
 * Borra SOLO los registros de auditoria de un tenant.
 *
 * Requiere desactivar el trigger: `audit_log` es append-only incluso para el
 * superusuario (un trigger corre siempre, y esa es justamente la garantia). Por eso
 * la limpieza de fixtures es la unica excepcion controlada, y se reactiva
 * inmediatamente despues para que la base quede igual de intocable.
 *
 * En produccion esto no existe: un `audit_log` se conserva o se restaura de un
 * backup, nunca se borra.
 */
export async function truncateAuditLog(db: TestDatabase, orgId: string): Promise<void> {
  await db.adminQuery('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete');
  try {
    await db.adminQuery(`DELETE FROM audit_log WHERE org_id = $1::uuid`, [orgId]);
  } finally {
    await db.adminQuery('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete');
  }
}

export { TEST_SECRETS };
