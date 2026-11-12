-- =============================================================================
-- Comanda · Fase 3: experiencia del cliente
--
-- Seis cosas nuevas:
--
--  - `orders` gana `PENDIENTE_APROBACION` (el modo mozo del QR) y el par
--    `customer_name` / `customer_phone` que el takeaway necesita para llamar
--    al cliente cuando el pedido está listo.
--  - `tables.qr_token_version`: el token del QR se deriva de esta versión con
--    HMAC y se rota incrementándola. Rotar no borra la mesa ni la comanda, solo
--    invalida los QR impresos antes.
--  - Multi-idioma del menú: `name_i18n` / `description_i18n` en products y
--    categories. El texto plano sigue siendo el español por defecto.
--  - `customers` + `loyalty_programs` + `loyalty_entries`: el ledger de
--    puntos/sellos es inmutable (trigger), como `audit_log`.
--  - `payment_intents`: la cara de un cobro contra un proveedor externo. El
--    `client_token` es lo único que sale a internet abierto.
--  - `payment_webhook_events`: idempotencia del webhook. La clave
--    `(provider, external_id)` única es la que hace que reenviar el mismo
--    webhook dos veces cobre una sola vez.
-- =============================================================================

ALTER TABLE orders DROP CONSTRAINT orders_status_valid;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_valid
  CHECK (status IN ('OPEN','PEDIDO_CUENTA','CLOSED','CANCELLED','PENDIENTE_APROBACION'));

ALTER TABLE orders
  ADD COLUMN customer_name varchar(120),
  ADD COLUMN customer_phone varchar(32),
  ADD COLUMN pickup_at timestamptz;

-- La unica comanda abierta por mesa incluye la pendiente de aprobacion: abrir una
-- segunda mientras la primera espera al mozo es el mismo bug multi-dispositivo.
DROP INDEX IF EXISTS orders_one_open_per_table;
CREATE UNIQUE INDEX orders_one_open_per_table ON orders (table_id)
  WHERE table_id IS NOT NULL AND status IN ('OPEN','PEDIDO_CUENTA','PENDIENTE_APROBACION');

ALTER TABLE tables ADD COLUMN qr_token_version integer NOT NULL DEFAULT 1
  CHECK (qr_token_version > 0);

ALTER TABLE products
  ADD COLUMN description text,
  ADD COLUMN name_i18n jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN description_i18n jsonb NOT NULL DEFAULT '{}';
ALTER TABLE categories
  ADD COLUMN name_i18n jsonb NOT NULL DEFAULT '{}';

-- -----------------------------------------------------------------------------
-- Clientes y fidelidad
-- -----------------------------------------------------------------------------
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone varchar(32),
  email varchar(160),
  name varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Un cliente se identifica por teléfono o por email: no dos filas con los dos
  -- vacíos, y no duplicados de ninguno.
  CONSTRAINT customers_identity_present CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX customers_org_phone_key ON customers (org_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX customers_org_email_key ON customers (org_id, email) WHERE email IS NOT NULL;
CREATE INDEX customers_org_idx ON customers (org_id);

CREATE TABLE loyalty_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  -- POINTS: puntos por centavos gastados. STAMPS: un sello por comanda.
  kind varchar(8) NOT NULL,
  -- POINTS: cuántos centavos de gasto acreditan 1 punto. STAMPS: sellos
  -- necesarios para completar la tarjeta ("6to gratis" => 6).
  points_per_cents integer NOT NULL DEFAULT 0,
  stamps_target integer NOT NULL DEFAULT 0,
  -- Cuántos puntos cuesta un canje del premio estándar.
  redeem_cost_points integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_programs_kind_valid CHECK (kind IN ('POINTS','STAMPS')),
  CONSTRAINT loyalty_programs_kind_params CHECK (
    (kind = 'POINTS' AND points_per_cents > 0 AND stamps_target = 0)
    OR (kind = 'STAMPS' AND stamps_target > 0 AND points_per_cents = 0)
  )
);
CREATE INDEX loyalty_programs_org_idx ON loyalty_programs (org_id);

CREATE TABLE loyalty_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  program_id uuid REFERENCES loyalty_programs(id) ON DELETE SET NULL,
  -- Positivo acredita, negativo canjea. No existe "saldo": es la suma.
  delta integer NOT NULL CHECK (delta <> 0),
  reason varchar(16) NOT NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Idempotencia del job de acreditación: una venta suma puntos una sola vez.
  source_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_entries_reason_valid CHECK (reason IN ('ACCRUE','REDEEM','EXPIRE','ADJUST'))
);
CREATE UNIQUE INDEX loyalty_entries_source_event_key ON loyalty_entries (source_event_id) WHERE source_event_id IS NOT NULL;
-- Una comanda acredita una sola vez en cada programa.
CREATE UNIQUE INDEX loyalty_entries_order_program_key ON loyalty_entries (order_id, program_id)
  WHERE order_id IS NOT NULL AND reason = 'ACCRUE';
CREATE INDEX loyalty_entries_customer_idx ON loyalty_entries (customer_id, created_at);

-- Inmutable: un ajuste se hace con una fila nueva de signo contrario, como en el
-- ledger contable. Sin UPDATE/DELETE también para el owner (trigger).
CREATE OR REPLACE FUNCTION loyalty_entries_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'loyalty_entries es append-only: agregá un asiento de signo contrario';
END;
$$;
CREATE TRIGGER loyalty_entries_no_update BEFORE UPDATE ON loyalty_entries
  FOR EACH ROW EXECUTE FUNCTION loyalty_entries_freeze();
CREATE TRIGGER loyalty_entries_no_delete BEFORE DELETE ON loyalty_entries
  FOR EACH ROW EXECUTE FUNCTION loyalty_entries_freeze();

-- -----------------------------------------------------------------------------
-- Cobros con proveedor externo
-- -----------------------------------------------------------------------------
CREATE TABLE payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider varchar(24) NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency varchar(3) NOT NULL,
  -- PENDING | APPROVED | FAILED | CANCELLED
  status varchar(10) NOT NULL DEFAULT 'PENDING',
  -- id del intento en el proveedor. Se llena cuando el proveedor responde.
  external_ref varchar(120),
  -- Lo que el navegador del cliente usa para completar el pago (token del SDK,
  -- URL de redirección...). Nunca incluye datos de tarjeta.
  client_token varchar(500),
  -- Idempotencia del create: el retry de la red no crea dos intentos.
  source_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_status_valid CHECK (status IN ('PENDING','APPROVED','FAILED','CANCELLED'))
);
CREATE UNIQUE INDEX payment_intents_source_event_key ON payment_intents (source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX payment_intents_order_idx ON payment_intents (order_id, status);

CREATE TABLE payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(24) NOT NULL,
  -- Id DEL EVENTO en el proveedor, no del pago: un mismo pago puede traer
  -- varios eventos (created, approved) y cada uno se procesa una vez.
  external_id varchar(160) NOT NULL,
  payload jsonb NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'RECEIVED',
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
CREATE INDEX payment_webhook_events_status_idx ON payment_webhook_events (status, created_at);

-- La tabla de webhooks no lleva org_id: llega antes de saber qué tenant es.
-- La service la consulta con app.current_org puesto DESPUES de resolver el pago.
ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_webhook_events FORCE ROW LEVEL SECURITY;
-- Sin org_id no puede haber policy por tenant: el acceso es por función
-- SECURITY DEFINER (como el login). Sin policy de SELECT para el rol app.

-- -----------------------------------------------------------------------------
-- RLS y permisos
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','loyalty_programs','loyalty_entries','payment_intents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      t || '_tenant_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      t || '_tenant_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      t || '_tenant_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      t || '_tenant_delete', t);
  END LOOP;
END
$$;

-- Privilegios para las tablas nuevas.
GRANT SELECT, INSERT, UPDATE, DELETE ON customers, loyalty_programs, loyalty_entries, payment_intents TO comanda_app;
-- payment_webhook_events NO va en ese GRANT: tiene RLS FORCE sin policy para la app;
-- solo las funciones SECURITY DEFINER la tocan (ver más arriba).

-- Permisos nuevos de la Fase 3.
INSERT INTO permissions (key, description) VALUES
  ('order.approve', 'Aprobar comandas del autopedido QR'),
  ('loyalty.read', 'Ver saldos y movimientos de fidelidad'),
  ('loyalty.redeem', 'Canjear puntos/sellos de clientes')
ON CONFLICT (key) DO NOTHING;

-- Rol: permiso. (mozo,cajero,encargado,dueno) ya los tenían todos salvo que el
-- seed los actualice; acá va el mínimo que hace falta para que la Fase 3 funcione
-- en tenants viejos: order.approve para los cuatro (el mozo aprueba), loyalty.read
-- para los cuatro, loyalty.redeem para cajero/encargado/dueno.
INSERT INTO role_permissions (org_id, role_id, permission_key)
SELECT o.id, r.id, p.key
FROM organizations o
JOIN roles r ON r.org_id = o.id
JOIN permissions p ON p.key = 'order.approve'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (org_id, role_id, permission_key)
SELECT o.id, r.id, p.key
FROM organizations o
JOIN roles r ON r.org_id = o.id
JOIN permissions p ON p.key = 'loyalty.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (org_id, role_id, permission_key)
SELECT o.id, r.id, p.key
FROM organizations o
JOIN roles r ON r.org_id = o.id
JOIN permissions p ON p.key IN ('loyalty.redeem')
WHERE r.key IN ('cajero','encargado','dueno')
ON CONFLICT DO NOTHING;

-- Dos funciones SECURITY DEFINER para resolver el tenant sin sesión pero SIN
-- exponer datos de negocio: solo el par (org_id, venue_id) mínimo indispensable
-- para abrir la transacción con contexto, que es lo que necesita la superficie
-- pública (QR, takeaway, webhooks, fidelización por teléfono). Sin ellas la RLS
-- respondería vacío siempre porque en esos flujos no hay principal todavía.
CREATE OR REPLACE FUNCTION platform_venue_tenant(p_venue_id uuid)
RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.org_id FROM venues v WHERE v.id = p_venue_id AND v.active = true LIMIT 1
$$;
REVOKE ALL ON FUNCTION platform_venue_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_venue_tenant(uuid) TO comanda_app;

CREATE OR REPLACE FUNCTION platform_order_tenant(p_order_id uuid)
RETURNS TABLE (org_id uuid, venue_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.org_id, o.venue_id FROM orders o WHERE o.id = p_order_id LIMIT 1
$$;
REVOKE ALL ON FUNCTION platform_order_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_order_tenant(uuid) TO comanda_app;

CREATE OR REPLACE FUNCTION platform_intent_lookup(p_external_ref text)
RETURNS TABLE (org_id uuid, venue_id uuid, order_id uuid, amount_cents integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pi.org_id, pi.venue_id, pi.order_id, pi.amount_cents
    FROM payment_intents pi WHERE pi.external_ref = p_external_ref LIMIT 1
$$;
REVOKE ALL ON FUNCTION platform_intent_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_intent_lookup(text) TO comanda_app;

-- El webhook se procesa fuera de contexto de tenant, así que marcar RECEIVED →
-- PROCESSED también va por función SECURITY DEFINER. La app nunca lee ni edita
-- la fila directamente.
CREATE OR REPLACE FUNCTION platform_mark_webhook_event(p_id uuid, p_status text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE payment_webhook_events SET status = p_status, processed_at = now() WHERE id = p_id
$$;
REVOKE ALL ON FUNCTION platform_mark_webhook_event(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_mark_webhook_event(uuid, text) TO comanda_app;

-- Webhook de pagos: registrar el evento de forma atómica y sacar de a uno los
-- RECEIVED. La unicidad por (provider, external_id) es la idempotencia.
CREATE OR REPLACE FUNCTION platform_register_webhook_event(
  p_provider text,
  p_external_id text,
  p_payload jsonb
) RETURNS TABLE (id uuid, already boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  INSERT INTO payment_webhook_events (provider, external_id, payload)
  VALUES (p_provider, p_external_id, p_payload)
  ON CONFLICT (provider, external_id) DO NOTHING
  RETURNING payment_webhook_events.id, false;
  IF NOT FOUND THEN
    RETURN QUERY
    SELECT w.id, true FROM payment_webhook_events w
     WHERE w.provider = p_provider AND w.external_id = p_external_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION platform_register_webhook_event(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_register_webhook_event(text, text, jsonb) TO comanda_app;
