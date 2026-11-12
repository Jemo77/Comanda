import type { Pool } from 'pg';
import {
  TENANT_TABLES,
  tenantRlsSql,
  rootRlsSql,
  auditLogImmutableSql,
  auditLogHashSql,
  auditLogUnattributedPolicySql,
  auditLogVerifySql,
  assertNoMissingPoliciesSql,
} from './rls';

/**
 * Capa de seguridad aplicada DESPUES de las migraciones.
 *
 * RLS, triggers de auditoria y privilegios del rol `comanda_app`.
 *
 * No sale de `drizzle-kit generate` porque son policies, triggers y revoked, cosas
 * que el generador no modela. Se aplica en un paso aparte, y es idempotente:
 * correrlo dos veces no rompe nada, que importa porque se ejecuta en cada deploy.
 */

export async function applySecurityLayer(pool: Pool): Promise<void> {
  for (const table of TENANT_TABLES) {
    await pool.query(dropPoliciesIfExist(table));
    await pool.query(tenantRlsSql(table));
  }

  for (const table of ['organizations']) {
    await pool.query(dropPoliciesIfExist(table));
    await pool.query(rootRlsSql(table));
  }

  // Los triggers se dropean antes de recrearlos. La migracion 0000 ya los crea, y
  // el capa de seguridad se aplica en cada deploy: sin este DROP, el segundo
  // deploy falla con "trigger already exists".
  await pool.query('DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log');
  await pool.query('DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log');
  await pool.query('DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log');
  await pool.query('DROP TRIGGER IF EXISTS audit_log_set_hash ON audit_log');

  await pool.query(auditLogUnattributedPolicySql());
  await pool.query(auditLogImmutableSql());
  await pool.query(auditLogHashSql());
  await pool.query(auditLogVerifySql());

  await pool.query(`
    DO $$
    DECLARE
      missing text;
    BEGIN
      -- Las tablas internas de infraestructura (control de migraciones, catalogo
      -- global de permisos) no son datos de tenant: filtrarlas por org no
      -- aportaria nada y la RLS solo estorbaria. Cualquier otra tabla que no la
      -- tenga habilitada es un olvido, y el build tiene que fallar.
      SELECT string_agg(c.relname, ', ') INTO missing
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND NOT (c.relname = ANY (ARRAY['permissions', '__comanda_migrations', '__drizzle_migrations']))
        AND NOT c.relrowsecurity;

      IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Las siguientes tablas no tienen RLS habilitada: %', missing;
      END IF;
    END
    $$
  `);

  await grantAppRole(pool);
  await pool.query(assertNoMissingPoliciesSql());
}

/** Las policies se recrean en cada deploy, asi que hay que tirar las viejas. */
function dropPoliciesIfExist(table: string): string {
  return `DO $$
  DECLARE p record;
  BEGIN
    FOR p IN SELECT policyname FROM pg_policies WHERE tablename = '${table}' LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p.policyname, '${table}');
    END LOOP;
  END
  $$`;
}

/**
 * Privilegios del rol de aplicacion.
 *
 * `audit_log` solo recibe INSERT y SELECT. UPDATE, DELETE y TRUNCATE quedan
 * revocados: el append-only se sostiene con privilegios ademas del trigger.
 */
async function grantAppRole(pool: Pool): Promise<void> {
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      organizations, venues, devices, users, roles, role_permissions, user_roles, refresh_tokens,
      stations, categories, products, modifier_groups, modifiers, product_modifier_groups,
      floors, tables, shifts, cash_movements, orders, order_items, order_item_modifiers,
      payments, bill_splits, kitchen_tickets, sync_events, pos_device_state
    TO comanda_app
  `);

  await pool.query('GRANT SELECT, INSERT ON audit_log TO comanda_app');
  await pool.query('REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM comanda_app');

  // `permissions` es el catalogo global de claves: identico para todos los tenants,
  // asi que no lleva RLS (filtrarlo por org no aportaria nada). El rol de la app
  // puede escribirlo porque el catalogo se sincroniza al arrancar y en cada seed,
  // y no hay nada que auditar ahi: no son datos de un local.
  await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON permissions TO comanda_app');
  await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO comanda_app');
}
