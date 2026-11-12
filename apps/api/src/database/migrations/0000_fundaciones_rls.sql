-- =============================================================================
-- Comanda · Fundaciones
-- Tenancy (Organization/Venue/Device/User/Role) + auditoria append-only.
--
-- Este archivo se aplica CON el rol comanda_migrator, que es miembro de
-- comanda_owner: los objetos quedan a nombre del owner y el rol comanda_app
-- (el que usa la API, los seeds y los tests) queda sujeto a RLS.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
CREATE TYPE plan AS ENUM ('starter', 'pro', 'enterprise');
CREATE TYPE venue_kind AS ENUM ('bar', 'cafe', 'restaurante', 'kiosco', 'confiteria');
CREATE TYPE device_kind AS ENUM ('tablet', 'pos', 'kiosk', 'printer', 'kds', 'unknown');
CREATE TYPE device_status AS ENUM ('pending', 'active', 'revoked');
CREATE TYPE user_status AS ENUM ('active', 'inactive');

-- -----------------------------------------------------------------------------
-- Organizaciones
-- -----------------------------------------------------------------------------
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  plan plan NOT NULL DEFAULT 'starter',
  country varchar(2) NOT NULL DEFAULT 'AR',
  currency varchar(3) NOT NULL DEFAULT 'ARS',
  timezone varchar(64) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  legal_name varchar(160),
  tax_id varchar(32),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_tax_id_key UNIQUE (tax_id),
  CONSTRAINT organizations_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT organizations_country_iso CHECK (country ~ '^[A-Z]{2}$')
);

-- -----------------------------------------------------------------------------
-- Locales
-- -----------------------------------------------------------------------------
CREATE TABLE venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  kind venue_kind NOT NULL DEFAULT 'bar',
  address varchar(300),
  timezone varchar(64) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  currency varchar(3) NOT NULL DEFAULT 'ARS',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX venues_org_id_idx ON venues (org_id);

-- -----------------------------------------------------------------------------
-- Dispositivos
-- -----------------------------------------------------------------------------
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  kind device_kind NOT NULL DEFAULT 'unknown',
  status device_status NOT NULL DEFAULT 'pending',
  fingerprint varchar(255) NOT NULL,
  token_version integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz,
  approved_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Un hardware no se registra dos veces en el mismo local. Si se reinstala, se
  -- reactiva el registro existente en vez de acumular huerfanos.
  CONSTRAINT devices_venue_fingerprint_key UNIQUE (venue_id, fingerprint),
  CONSTRAINT devices_revoked_has_timestamp CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR status <> 'revoked'
  )
);

CREATE INDEX devices_org_id_idx ON devices (org_id);
CREATE INDEX devices_venue_id_status_idx ON devices (venue_id, status);

-- -----------------------------------------------------------------------------
-- Usuarios
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  email varchar(254) NOT NULL,
  -- Hash argon2id. NULL para usuarios que solo entran con PIN.
  password_hash text,
  -- Hash del PIN con pepper. El pepper NO se guarda: vive en el gestor de
  -- secretos. Sin el, un dump de la base alcanza para probar los 10.000 PIN
  -- posibles en segundos.
  pin_hash text,
  pin_set_at timestamptz,
  status user_status NOT NULL DEFAULT 'active',
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- El email es unico por organizacion, no globalmente: el mismo dueno puede
  -- tener dos locales con el mismo correo y gestionarlos como tenants separados.
  CONSTRAINT users_org_email_key UNIQUE (org_id, email),
  CONSTRAINT users_failed_login_count_non_negative CHECK (failed_login_count >= 0)
);

CREATE INDEX users_org_id_idx ON users (org_id);

-- -----------------------------------------------------------------------------
-- Roles y permisos
-- -----------------------------------------------------------------------------
CREATE TABLE permissions (
  key varchar(64) PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Clave estable: los roles de sistema la tienen, los personalizados usan uuid.
  -- Permite que una migracion referencie el rol del Cajero sin depender del id.
  key varchar(64) NOT NULL,
  name varchar(80) NOT NULL,
  description text,
  -- Limites no binarios, como el tope de descuento del Cajero.
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_org_key_key UNIQUE (org_id, key)
);

CREATE TABLE role_permissions (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key varchar(64) NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  -- NULL = la asignacion vale para todos los locales de la organizacion. Es lo que
  -- necesita un dueno con varios locales, sin duplicar la asignacion por local.
  venue_id uuid REFERENCES venues(id) ON DELETE CASCADE,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_roles_scope_key ON user_roles (user_id, role_id, COALESCE(venue_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX user_roles_user_id_idx ON user_roles (user_id);

-- -----------------------------------------------------------------------------
-- Refresh tokens rotativos
-- -----------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  -- SHA-256. El token es un valor aleatorio de 256 bits, no una contrasena: por
  -- eso SHA-256 y no argon2.
  token_hash varchar(64) NOT NULL UNIQUE,
  -- La familia permite detectar robo: si se reutiliza un token ya rotado, se
  -- revoca la familia entera.
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason varchar(32),
  -- Ultimo uso del token. Permite distinguir en la pantalla de seguridad "este
  -- dispositivo se conecta a diario" de "lleva tres semanas sin usarse".
  last_seen_at timestamptz,
  ip varchar(45),
  user_agent varchar(500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);
-- La limpieza periodica busca filas ya vencidas.
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- -----------------------------------------------------------------------------
-- Auditoria append-only
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable a proposito: un intento de login contra un correo o un dispositivo que
  -- no existen NO pertenece a ninguna organizacion, y ese registro es
  -- precisamente el que sirve para detectar un ataque de fuerza bruta. Con
  -- NOT NULL ese ataque no dejaria ninguna rastro.
  --
  -- Las filas con org_id NULL solo se pueden insertar con la policy acotada
  -- `audit_log_unattributed_login_failed` (solo `auth.login.failed`, sin actor) y
  -- nunca se pueden leer desde el rol de la aplicación.
  org_id uuid,
  venue_id uuid,
  -- NULL en acciones del sistema (seeds, jobs) sin actor humano.
  actor_id uuid,
  -- Desnormalizado a proposito: el registro tiene que seguir siendo legible si el
  -- usuario se borra. "El usuario X hizo esto" importa mas que el id.
  actor_name varchar(120),
  device_id uuid,
  ip varchar(45),
  user_agent varchar(500),
  action varchar(64) NOT NULL,
  entity varchar(64) NOT NULL,
  entity_id varchar(64),
  before jsonb,
  after jsonb,
  reason varchar(300),
  prev_hash varchar(64),
  hash varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Distinta de created_at: los reportes usan esta, porque el reloj del
  -- dispositivo puede estar desfasado.
  server_received_at timestamptz NOT NULL DEFAULT now()
);

-- El indice por defecto de la pantalla de auditoria.
CREATE INDEX audit_log_org_created_at_idx ON audit_log (org_id, created_at);
CREATE INDEX audit_log_org_entity_idx ON audit_log (org_id, entity, entity_id);
CREATE INDEX audit_log_org_action_idx ON audit_log (org_id, action);
CREATE INDEX audit_log_org_actor_idx ON audit_log (org_id, actor_id);

-- =============================================================================
-- Capa de seguridad
-- =============================================================================

-- -----------------------------------------------------------------------------
-- RLS por organizacion
--
-- ENABLE + FORCE: con FORCE las politicas se aplican tambien al owner de la
-- tabla. Sin eso, un SELECT hecho como comanda_owner saltaria la RLS entera y los
-- tests correrian con una ventaja que la API real no tiene.
--
-- Sobre el `nullif(..., '')`:
--
-- `current_setting('app.current_org', true)` devuelve NULL si la variable nunca se
-- seteó, pero devuelve CADENA VACIA si se seteó dentro de una transaccion con
-- `set_config(..., true)` y esa transaccion ya terminó (que es lo que pasa cuando
-- el pool devuelve la conexión). Un `::uuid` sobre '' lanza
-- "invalid input syntax for type uuid", y el error aparecería en la segunda
-- petición de la vida del proceso, no en el arranque.
--
-- Con `nullif` los dos casos vuelven NULL, y comparar con NULL da NULL, que en una
-- policy equivale a negar: sin contexto de tenant no se lee nada.
-- -----------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_self_select ON organizations
  FOR SELECT USING (id = nullif(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY organizations_self_update ON organizations
  FOR UPDATE
  USING (id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.current_org', true), '')::uuid);

-- Alta de una organizacion (bootstrap / registro de un local nuevo).
--
-- Todavia no existe un tenant, asi que no hay `app.current_org` que poner y sin esta
-- policy el alta seria imposible con el rol de la aplicacion. Se acota a lo
-- indispensable: solo INSERT, y solo cuando el contexto esta vacio. Una vez creada
-- la fila, el mismo rol no puede modificarla sin el contexto correcto.
--
-- Vive en la base y no en el codigo del seed a proposito: es el mismo camino que
-- usara el endpoint de alta de la Fase 1, y la restriccion tiene que valer para
-- cualquiera que intente crear un local, no solo para el seed.
CREATE POLICY organizations_bootstrap_insert ON organizations
  FOR INSERT WITH CHECK (
    nullif(current_setting('app.current_org', true), '') IS NULL
  );

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['venues', 'devices', 'users', 'roles', 'role_permissions', 'user_roles', 'refresh_tokens', 'audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (org_id = current_setting(''app.current_org'', true)::uuid)',
      t || '_tenant_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (org_id = current_setting(''app.current_org'', true)::uuid)',
      t || '_tenant_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (org_id = current_setting(''app.current_org'', true)::uuid) WITH CHECK (org_id = current_setting(''app.current_org'', true)::uuid)',
      t || '_tenant_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      t || '_tenant_delete', t);
  END LOOP;
END
$$;

-- Policy acotada para los intentos de login fallido de los que NO se conoce la
-- organizacion (correo inexistente, dispositivo no registrado).
--
-- Sin esto, un ataque con correos inventados no dejaria ninguna rastro, que es
-- justamente el ataque que hay que poder detectar. La policy es deliberadamente
-- minima: solo INSERT, solo `auth.login.failed`, y `org_id` obligatoriamente NULL.
-- Un cliente no puede usarla para escribir ningun otro tipo de registro ni
-- atribuirse a una organizacion.
CREATE POLICY audit_log_unattributed_login_failed ON audit_log
  FOR INSERT WITH CHECK (
    org_id IS NULL
    AND action = 'auth.login.failed'
    AND actor_id IS NULL
  );

-- -----------------------------------------------------------------------------
-- audit_log: tres capas de inmutabilidad
--
-- 1. REVOKE: el rol de la app ni puede intentar UPDATE/DELETE/TRUNCATE.
-- 2. Trigger: cubre al owner y a quien acceda con otro rol.
-- 3. Sin policy de UPDATE/DELETE: aunque existiera el permiso, no hay policy que
--    lo autorice, y con FORCE la RLS no se puede desactivar por sesion.
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM comanda_app;

CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  -- `OLD` no existe en un trigger de TRUNCATE (es de sentencia): referenciarlo
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

-- El nombre de la funcion NO lleva sufijo: los triggers de DELETE y TRUNCATE
-- comparten cuerpo pero son objetos distintos, y Postgres identifica cada uno
-- por (tabla, evento, nombre).
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- TRUNCATE es una operacion de tabla: no pasa por las policies de fila, asi que
-- sin este trigger un TRUNCATE borraria todo sin que la RLS lo advierta.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

-- -----------------------------------------------------------------------------
-- Cadena de hashes
--
-- Se calcula en un trigger y no en la aplicacion por dos motivos: la cadena se
-- mantiene aunque alguien escriba con psql, y el hash no depende de que el codigo
-- de la app haya pasado por el camino correcto.
--
-- La cadena es por organizacion, para que un tenant grande no bloquee a los
-- demas al verificar.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_chain_hash()
RETURNS TRIGGER AS $$
DECLARE
  previous_hash text;
BEGIN
  SELECT a.hash INTO previous_hash
  FROM audit_log a
  WHERE a.org_id = NEW.org_id AND a.id <> NEW.id
  ORDER BY a.created_at DESC, a.id DESC
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

-- Verificacion de la cadena. Vive en la base para poder correr durante una
-- investigacion con las mismas reglas con las que se escribieron los registros.
CREATE OR REPLACE FUNCTION audit_log_verify_chain(target_org uuid)
RETURNS TABLE (record_id uuid, expected_hash text, actual_hash text, ok boolean)
LANGUAGE sql STABLE AS $$
  WITH chain AS (
    SELECT
      id, hash, prev_hash,
      LAG(hash) OVER (ORDER BY created_at, id) AS previous
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

-- -----------------------------------------------------------------------------
-- Privilegios del rol de aplicacion
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organizations, venues, devices, users, roles, role_permissions, user_roles, refresh_tokens
  TO comanda_app;

-- audit_log: solo INSERT y SELECT. UPDATE/DELETE/TRUNCATE revocados.
GRANT SELECT, INSERT ON audit_log TO comanda_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM comanda_app;

-- `permissions` es el catalogo global de claves: identico para todos los tenants, asi
-- que no lleva RLS. El rol de la app puede escribirlo porque el catalogo se sincroniza
-- al arrancar y en cada seed, y no hay nada que auditar ahi: no son datos de un local.
GRANT SELECT, INSERT, UPDATE, DELETE ON permissions TO comanda_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO comanda_app;

-- -----------------------------------------------------------------------------
-- Red de seguridad del build
--
-- drizzle-kit generate no conoce las policies, asi que este chequeo corre en la
-- migracion: si alguien agrega una tabla de tenant y olvida su policy, la
-- migracion falla y CI queda rojo en vez de dejar una tabla abierta.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  missing text;
BEGIN
  -- Las tablas internas de infraestructura (control de migraciones, catalogo
  -- global de permisos) no son datos de tenant: filtrarlas por org no aportaria
  -- nada y la RLS solo estorbaria. Cualquier otra tabla sin RLS es un olvido, y
  -- el build tiene que fallar.
  SELECT string_agg(c.relname, ', ') INTO missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT (c.relname = ANY (ARRAY['permissions', '__comanda_migrations', '__drizzle_migrations']))
    AND NOT c.relrowsecurity;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Las siguientes tablas no tienen RLS habilitada: %', missing;
  END IF;
END
$$;