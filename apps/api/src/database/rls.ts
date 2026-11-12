import { randomBytes } from 'node:crypto';

/**
 * Politica RLS por tabla.
 *
 * Se genera desde una lista de tablas, y no tabla por tabla a mano, por una
 * razon concreta: el isolation entre tenants es la propiedad de seguridad mas
 * importante del producto y tiene que ser **uniforme**. Si cada tabla nueva
 * define su propia policy, tarde o temprano alguien olvida la RLS de la tabla que
 * acaba de agregar, y el tests de aislamiento sigue pasando porque prueba las
 * tablas viejas.
 *
 * Generar de forma uniforme y, ademas, fallar en la migracion si una tabla
 * tenant no tiene policy, convierte el olvido en un error de build.
 */

/** Tablas de negocio: llevan `org_id` y se aíslan por organizacion. */
export const TENANT_TABLES = [
  'venues',
  'devices',
  'users',
  'roles',
  'role_permissions',
  'user_roles',
  'refresh_tokens',
  'audit_log',
  // Fase 1: catálogo, salón, comandas, cobro, caja y sincronización.
  // Si alguna queda afuera, la migración falla en su chequeo de RLS: la tabla
  // quedaría abierta y ningún test funcional lo detectaría.
  'stations',
  'categories',
  'products',
  'modifier_groups',
  'modifiers',
  'product_modifier_groups',
  'floors',
  'tables',
  'shifts',
  'cash_movements',
  'orders',
  'order_items',
  'order_item_modifiers',
  'payments',
  'bill_splits',
  'kitchen_tickets',
  'sync_events',
  'pos_device_state',
] as const;

/**
 * Tablas que no son de tenant y por eso no llevan RLS.
 *
 * `permissions` es el catalogo global de claves: es identico para todos los
 * tenants y filtrarlo por org no aportaria nada. `organizations` es la tabla
 * raiz: cada fila es un tenant, asi que su "tenant" es ella misma.
 */
export const GLOBAL_TABLES = ['permissions'] as const;
export const ROOT_TABLES = ['organizations'] as const;

export const ALL_TABLES = [...ROOT_TABLES, ...TENANT_TABLES, ...GLOBAL_TABLES] as const;

/**
 * Emite el SQL de RLS para una tabla de tenant.
 *
 * `ENABLE` + `FORCE`: con `FORCE`, las politicas se aplican tambien al owner de
 * la tabla. Sin el, un `SELECT` hecho como `comanda_owner` (que es como corren
 * las migraciones) saltaria la RLS entera y los tests correrian con dos ventajas
 * que la API real no tiene.
 */
export function tenantRlsSql(table: string): string {
  return `
-- ${table}: aislamiento por organizacion.
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;

CREATE POLICY ${table}_tenant_select ON ${table}
  FOR SELECT USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY ${table}_tenant_insert ON ${table}
  FOR INSERT WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY ${table}_tenant_update ON ${table}
  FOR UPDATE
  USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY ${table}_tenant_delete ON ${table}
  FOR DELETE USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
`.trim();
}

/**
 * RLS de la tabla raiz.
 *
 * Cada fila es un tenant, asi que la policy compara contra su propio id. Un
 * `SELECT * FROM organizations` sin contexto devuelve cero filas en vez de
 * exponer la lista de clientes de la plataforma.
 */
export function rootRlsSql(table: string): string {
  return `
-- ${table}: cada fila es un tenant.
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;

CREATE POLICY ${table}_self_select ON ${table}
  FOR SELECT USING (id = nullif(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY ${table}_self_update ON ${table}
  FOR UPDATE
  USING (id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.current_org', true), '')::uuid);

-- Alta de la organizacion: todavia no hay tenant, asi que no hay
-- \`app.current_org\` que poner. Se acota a INSERT con el contexto vacio, que es el
-- mismo camino que usara el endpoint de alta de la Fase 1.
CREATE POLICY ${table}_bootstrap_insert ON ${table}
  FOR INSERT WITH CHECK (
    nullif(current_setting('app.current_org', true), '') IS NULL
  );
`.trim();
}

/**
 * Policy de `INSERT` acotada para los intentos de login fallido de los que NO se
 * conoce la organizacion (correo inexistente, dispositivo no registrado).
 *
 * Sin esto, un ataque con correos inventados no dejaría rastro, que es justamente el
 * ataque que hay que poder detectar. La policy es deliberadamente mínima: solo
 * INSERT, solo `auth.login.failed`, y `org_id` obligatoriamente NULL. Un cliente no
 * puede usarla para escribir ningún otro tipo de registro ni atribuirse a una
 * organización.
 *
 * Viene aparte porque `dropPoliciesIfExist` borra todas las policies de la tabla
 * en cada deploy: si esta viviera solo en la migración, el segundo deploy se la
 * llevaría y los intentos de login sin organizar dejarían de registrarse.
 */
export function auditLogUnattributedPolicySql(): string {
  return `
CREATE POLICY audit_log_unattributed_login_failed ON audit_log
  FOR INSERT WITH CHECK (
    org_id IS NULL
    AND action = 'auth.login.failed'
    AND actor_id IS NULL
  );
`.trim();
}

/**
 * `audit_log` append-only.
 *
 * Tres capas, todas necesarias porque cada una tapa un agujero distinto:
 *
 *  1. `REVOKE`: el rol de la app ni puede intentar UPDATE/DELETE/TRUNCATE.
 *  2. Trigger: cubre al owner y a quien acceda con otro rol.
 *  3. Sin policy de UPDATE/DELETE: aunque existiera el permiso, no hay policy que
 *     lo autorice, y con `FORCE` RLS no se puede desactivar por sesion.
 */
export function auditLogImmutableSql(): string {
  return `
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM comanda_app;

CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  -- \`OLD\` no existe en un trigger de TRUNCATE (es de sentencia): referenciarlo
  -- ahi aborta el CREATE del trigger con "record old is not assigned yet".
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION
      'audit_log es append-only: TRUNCATE no esta permitido'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RAISE EXCEPTION
    'audit_log es append-only: % no esta permitido (registro %)',
    TG_OP, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- No se puede truncar la tabla para "empezar de cero".
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();
`.trim();
}

/**
 * Hash encadenado del registro de auditoria.
 *
 * Se calcula en un trigger en lugar de en la aplicacion por dos motivos: la
 * cadena se mantiene aunque alguien escriba con psql, y el hash no depende de que
 * el codigo de la app haya pasado por el camino correcto.
 *
 * La cadena es por organizacion (`ORDER BY created_at, id` dentro del mismo
 * `org_id`), para que el crecimiento de un tenant grande no bloquee a los demas.
 */
export function auditLogHashSql(): string {
  return `
CREATE OR REPLACE FUNCTION audit_log_chain_hash()
RETURNS TRIGGER AS $$
DECLARE
  previous_hash text;
BEGIN
  SELECT hash INTO previous_hash
  FROM audit_log
  WHERE org_id = NEW.org_id AND id <> NEW.id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  NEW.prev_hash := COALESCE(previous_hash, repeat('0', 64));
  NEW.hash := encode(
    digest(
      concat_ws('|',
        NEW.prev_hash,
        NEW.org_id::text,
        COALESCE(NEW.venue_id::text, ''),
        COALESCE(NEW.actor_id::text, ''),
        NEW.action,
        NEW.entity,
        COALESCE(NEW.entity_id, ''),
        COALESCE(NEW.reason, ''),
        COALESCE(NEW.before::text, ''),
        COALESCE(NEW.after::text, '')
      ),
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_set_hash
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain_hash();
`.trim();
}

/**
 * Verificacion de la cadena.
 *
 * Se expone como funcion de base (y no como codigo de la app) porque tiene que
 * poder correr durante una investigacion, con las mismas reglas con las que se
 * escribieron los registros.
 */
export function auditLogVerifySql(): string {
  return `
CREATE OR REPLACE FUNCTION audit_log_verify_chain(target_org uuid)
RETURNS TABLE (record_id uuid, expected_hash text, actual_hash text, ok boolean)
LANGUAGE sql STABLE AS $$
  WITH chain AS (
    SELECT
      id,
      hash,
      prev_hash,
      LAG(hash) OVER (ORDER BY created_at, id) AS previous,
      org_id,
      venue_id,
      actor_id,
      action,
      entity,
      entity_id,
      reason,
      before,
      after
    FROM audit_log
    WHERE org_id = target_org
  )
  SELECT
    id,
    COALESCE(previous, repeat('0', 64)) AS expected_hash,
    prev_hash AS actual_hash,
    prev_hash = COALESCE(previous, repeat('0', 64)) AS ok
  FROM chain
  WHERE prev_hash IS DISTINCT FROM COALESCE(previous, repeat('0', 64));
$$;
`.trim();
}

/**
 * Red de seguridad del build: toda tabla de tenant tiene que tener policy.
 *
 * `drizzle-kit generate` no conoce las policies, asi que este chequeo corre en la
 * migracion: si alguien agrega una tabla a `TENANT_TABLES` pero olvida el
 * `GRANT`/policy, la migracion falla y CI queda rojo.
 */
export function assertNoMissingPoliciesSql(): string {
  const tables = TENANT_TABLES.map((t) => `'${t}'`).join(', ');
  return `
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c.relname, ', ')
  INTO missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (${tables})
    AND NOT c.relrowsecurity;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Las siguientes tablas de tenant no tienen RLS habilitada: %', missing;
  END IF;
END
$$;
`.trim();
}

/**
 * Genera un id de evento con prefijo, para los UUIDv7 del servidor.
 * Se usa en los jobs y en el worker de sync; el POS genera los suyos en cliente.
 */
export function newUuid(): string {
  return randomBytes(16).toString('hex');
}
