-- =============================================================================
-- Comanda · Fase 1: POS MVP
--
-- Catálogo, salón, comandas, cobro, caja y sincronización.
--
-- Dos decisiones de este archivo que vale la pena leer antes que nada:
--
-- 1. `sync_events.event_id` es la clave primaria. Es lo que hace idempotente el
--    push: reenviar toda la outbox tras una desconexión es seguro porque el
--    servidor ignora lo que ya vio. Por eso NO es un id generado por la base.
--
-- 2. `sync_events.seq_global` es un bigserial y define el cursor del pull. El
--    incremental se lee de acá y no de un `updated_at` por tabla: un `updated_at`
--    con reloj del servidor tiene empates y saltos, y un cliente que synchronize
--    entre dos peticiones con el mismo timestamp pierde cambios para siempre.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Estaciones (enrutado de impressions y KDS)
-- -----------------------------------------------------------------------------
CREATE TABLE stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  -- `bar` / `cocina` / `cafe`: decide a qué impresora o KDS va cada producto.
  kind varchar(16) NOT NULL DEFAULT 'cocina',
  -- Destino de impresión, arbitrario: una IP, un nombre de cola, un ESC/POS
  -- compartido. El driver lo resuelve; la base no conoce impresoras.
  printer_target varchar(120),
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stations_org_id_idx ON stations (org_id);
CREATE INDEX stations_venue_id_idx ON stations (venue_id, sort);

-- -----------------------------------------------------------------------------
-- Catálogo
-- -----------------------------------------------------------------------------
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  -- NULL = categoría compartida por todos los locales de la organización.
  venue_id uuid REFERENCES venues(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX categories_org_sort_idx ON categories (org_id, sort);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name varchar(120) NOT NULL,
  sku varchar(40),
  -- Centavos, SIEMPRE enteros. Un float acá se acumula en el arqueo de caja.
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  -- Tasa de impuesto como fracción (0.21). El motor fiscal es Fase 2; el campo
  -- existe ahora para no tener que repoblar la tabla más adelante.
  tax_rate numeric(5,4) NOT NULL DEFAULT 0,
  station_id uuid REFERENCES stations(id) ON DELETE SET NULL,
  -- Descuenta stock al confirmar venta. False en entradas, promos y refinery.
  tracks_stock boolean NOT NULL DEFAULT true,
  available boolean NOT NULL DEFAULT true,
  image_url text,
  allergens text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_tax_rate_range CHECK (tax_rate >= 0 AND tax_rate <= 1)
);

CREATE INDEX products_org_category_idx ON products (org_id, category_id, sort);
CREATE INDEX products_station_idx ON products (station_id);
CREATE UNIQUE INDEX products_org_sku_key ON products (org_id, sku) WHERE sku IS NOT NULL;

CREATE TABLE modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name varchar(80) NOT NULL,
  -- Cuántos hay que elegir. `min_select > 0` hace el grupo obligatorio.
  min_select integer NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select integer NOT NULL DEFAULT 1 CHECK (max_select >= min_select),
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX modifier_groups_org_idx ON modifier_groups (org_id, sort);

CREATE TABLE modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  -- Puede ser negativo: "sin hielo" no descuenta, pero "menos queso" sí.
  price_delta_cents integer NOT NULL DEFAULT 0,
  -- Cambios de escandallo (leche de almendras en vez de entera). Fase 4 lo consume.
  recipe_override jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX modifiers_group_idx ON modifiers (group_id, sort);

CREATE TABLE product_modifier_groups (
  -- org_id aunque sea tabla puente: la RLS filtra por organización y un filtro que
  -- necesita un JOIN a otra tabla en cada lectura es un filtro que algún día se
  -- olvida. La regla "toda tabla lleva org_id" no tiene excepción.
  org_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  sort integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id)
);

CREATE INDEX product_modifier_groups_org_idx ON product_modifier_groups (org_id);

-- -----------------------------------------------------------------------------
-- Salón: sectores y mesas
-- -----------------------------------------------------------------------------
CREATE TABLE floors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX floors_venue_idx ON floors (venue_id, sort);

CREATE TABLE tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  floor_id uuid NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  label varchar(20) NOT NULL,
  seats smallint NOT NULL DEFAULT 2 CHECK (seats > 0),
  -- Geometría del editor de planos.
  x numeric(8,2) NOT NULL DEFAULT 0,
  y numeric(8,2) NOT NULL DEFAULT 0,
  w numeric(8,2) NOT NULL DEFAULT 100,
  h numeric(8,2) NOT NULL DEFAULT 100,
  shape varchar(16) NOT NULL DEFAULT 'rect',
  -- LIBRE | OCUPADA | PIDIO_CUENTA | RESERVADA | BLOQUEADA
  status varchar(16) NOT NULL DEFAULT 'LIBRE',
  -- Cuándo se ocupó. La alerta de "mesa hace 2h30" se calcula con esto.
  occupied_since timestamptz,
  -- Orden abierta que ocupa la mesa. NULL cuando está libre.
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tables_status_valid CHECK (status IN ('LIBRE','OCUPADA','PIDIO_CUENTA','RESERVADA','BLOQUEADA')),
  -- Una mesa ocupada SIEMPRE tiene orden y momento de ocupación. Sin esto, el mapa
  -- puede mostrar "OCUPADA" sin ninguna comanda detrás.
  CONSTRAINT tables_occupied_consistent CHECK (
    (status IN ('OCUPADA','PIDIO_CUENTA') AND order_id IS NOT NULL AND occupied_since IS NOT NULL)
    OR status NOT IN ('OCUPADA','PIDIO_CUENTA')
  )
);

CREATE INDEX tables_venue_idx ON tables (venue_id, floor_id, label);
CREATE INDEX tables_status_idx ON tables (venue_id, status);

-- -----------------------------------------------------------------------------
-- Turnos y caja
-- -----------------------------------------------------------------------------
CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  opened_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_at timestamptz NOT NULL DEFAULT now(),
  -- Fondo con el que arrancó la caja, en centavos.
  opening_float_cents integer NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
  closed_at timestamptz,
  -- Lo que el cajero DECLARA tener. Se compara contra el esperado, que el cajero
  -- no puede ver (arqueo ciego, PLAN §4.4).
  declared_cash_cents integer,
  expected_cash_cents integer,
  diff_cents integer,
  status varchar(12) NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shifts_status_valid CHECK (status IN ('OPEN','CLOSED')),
  CONSTRAINT shifts_closed_complete CHECK (
    status = 'OPEN'
    OR (closed_at IS NOT NULL AND declared_cash_cents IS NOT NULL AND expected_cash_cents IS NOT NULL)
  )
);

-- Un solo turno abierto por local: dos cajas abiertas a la vez no tienen sentido
-- y duplicarían el arqueo.
CREATE UNIQUE INDEX shifts_one_open_per_venue ON shifts (venue_id) WHERE status = 'OPEN';
CREATE INDEX shifts_venue_idx ON shifts (venue_id, opened_at DESC);

CREATE TABLE cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  type varchar(16) NOT NULL,
  amount_cents integer NOT NULL,
  reason varchar(300),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_movements_type_valid CHECK (type IN ('IN','OUT','RETIRO')),
  -- IN suma, OUT y RETIRO restan. El signo lo decide el tipo, no el que lo escribe.
  CONSTRAINT cash_movements_sign CHECK (
    (type = 'IN' AND amount_cents > 0)
    OR (type IN ('OUT','RETIRO') AND amount_cents > 0)
  )
);

CREATE INDEX cash_movements_shift_idx ON cash_movements (shift_id, created_at);

-- -----------------------------------------------------------------------------
-- Comandas
-- -----------------------------------------------------------------------------
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  table_id uuid REFERENCES tables(id) ON DELETE SET NULL,
  -- POS | QR | TAKEAWAY | DELIVERY
  channel varchar(16) NOT NULL DEFAULT 'POS',
  status varchar(16) NOT NULL DEFAULT 'OPEN',
  -- Número visible para el local. Offline es `device_prefix-seq`, no correlativo
  -- global: dos tablets abiertas pueden generar el mismo número y es intencional.
  -- El identificador real es el UUID.
  number_label varchar(24) NOT NULL,
  opened_by uuid REFERENCES users(id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  guests smallint NOT NULL DEFAULT 1 CHECK (guests > 0),
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  -- Dispositivo y evento que abrieron la comanda: para auditar un At rib que se
  -- que se abre offline.
  source_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  source_event_id uuid,
  -- Total cacheado. Es una desnormalizacion a proposito: el cobro lo vuelve a calcular
  -- desde items y pagos; esto es para que el mapa y el ticket no sumen en cliente.
  total_cents integer NOT NULL DEFAULT 0,
  tip_cents integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_status_valid CHECK (status IN ('OPEN','PEDIDO_CUENTA','CLOSED','CANCELLED')),
  CONSTRAINT orders_channel_valid CHECK (channel IN ('POS','QR','TAKEAWAY','DELIVERY'))
);

-- Una sola comanda abierta por mesa. Es la regla que hace resoluble el conflicto
-- de dos dispositivos sobre la misma mesa.
CREATE UNIQUE INDEX orders_one_open_per_table ON orders (table_id)
  WHERE table_id IS NOT NULL AND status IN ('OPEN','PEDIDO_CUENTA');
CREATE INDEX orders_venue_status_idx ON orders (venue_id, status);
CREATE INDEX orders_shift_idx ON orders (shift_id) WHERE shift_id IS NOT NULL;
CREATE UNIQUE INDEX orders_source_event_key ON orders (source_event_id) WHERE source_event_id IS NOT NULL;

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  -- Snapshot del nombre: dentro de seis meses el producto puede haberse renombrado
  -- o borrado, y el ticket tiene que seguir diciendo lo que se pidió.
  name_snapshot varchar(120) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  -- Snapshot del precio al momento de agregarlo. Cambiar el precio del catálogo
  -- después no debe alterar comandas ya abiertas.
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  list_price_cents integer NOT NULL CHECK (list_price_cents >= 0),
  -- Reglas de precio aplicadas, para poder explicar el total (motor de promos).
  applied_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- ACTIVE | VOIDED. Borrar no existe: anular es un evento, y el ítem queda.
  status varchar(12) NOT NULL DEFAULT 'ACTIVE',
  course smallint NOT NULL DEFAULT 1,
  seat smallint,
  note varchar(300),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  source_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  source_event_id uuid,
  void_reason varchar(300),
  voided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_items_status_valid CHECK (status IN ('ACTIVE','VOIDED')),
  -- Un item anulado tiene que decir por qué y quién. Sin esto, la auditoría de
  -- "cuánto se descontó por anulaciones" es imposible.
  CONSTRAINT order_items_void_consistent CHECK (
    status = 'ACTIVE' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL)
  )
);

CREATE INDEX order_items_order_idx ON order_items (order_id, status);
CREATE UNIQUE INDEX order_items_source_event_key ON order_items (source_event_id) WHERE source_event_id IS NOT NULL;

CREATE TABLE order_item_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id uuid REFERENCES modifiers(id) ON DELETE SET NULL,
  name_snapshot varchar(80) NOT NULL,
  price_delta_cents integer NOT NULL DEFAULT 0,
  sort integer NOT NULL DEFAULT 0
);

CREATE INDEX order_item_modifiers_item_idx ON order_item_modifiers (order_item_id, sort);

-- -----------------------------------------------------------------------------
-- Cobro
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  -- CASH | CARD | QR | TRANSFER
  method varchar(12) NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  tip_cents integer NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  provider varchar(24),
  -- Referencia del proveedor. Para tarjeta offline es el comprobante del terminal:
  -- NUNCA el PAN. La API nunca ve el número de tarjeta (PLAN §6, PCI).
  provider_ref varchar(120),
  -- PENDING | APPROVED | FAILED | REFUNDED
  status varchar(12) NOT NULL DEFAULT 'APPROVED',
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  received_by uuid REFERENCES users(id) ON DELETE SET NULL,
  source_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  source_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_method_valid CHECK (method IN ('CASH','CARD','QR','TRANSFER')),
  CONSTRAINT payments_status_valid CHECK (status IN ('PENDING','APPROVED','FAILED','REFUNDED'))
);

CREATE INDEX payments_order_idx ON payments (order_id);
CREATE INDEX payments_shift_idx ON payments (shift_id) WHERE shift_id IS NOT NULL;
CREATE UNIQUE INDEX payments_source_event_key ON payments (source_event_id) WHERE source_event_id IS NOT NULL;

CREATE TABLE bill_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- BY_ITEM | EQUAL | AMOUNT
  mode varchar(12) NOT NULL,
  -- Reparto en centavos: { "asiento": 1, "importeCents": 3400, "pagado": false }
  allocations jsonb NOT NULL,
  total_cents integer NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bill_splits_mode_valid CHECK (mode IN ('BY_ITEM','EQUAL','AMOUNT'))
);

CREATE INDEX bill_splits_order_idx ON bill_splits (order_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- KDS (pantalla de cocina)
-- -----------------------------------------------------------------------------
CREATE TABLE kitchen_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  station_id uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- NEW | PREPARING | READY | SERVED
  status varchar(12) NOT NULL DEFAULT 'NEW',
  priority smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kitchen_tickets_status_valid CHECK (status IN ('NEW','PREPARING','READY','SERVED'))
);

CREATE INDEX kitchen_tickets_station_idx ON kitchen_tickets (station_id, status, priority, created_at);
CREATE INDEX kitchen_tickets_order_idx ON kitchen_tickets (order_id);

-- -----------------------------------------------------------------------------
-- Sincronización: el corazón del modo offline
-- -----------------------------------------------------------------------------
CREATE TABLE sync_events (
  -- UUIDv7 generado por el DISPOSITIVO. Es la clave primaria y la que hace
  -- idempotente el push: reenviar la outbox entera tras una desconexión no
  -- duplica nada, porque laPK descarta lo ya visto.
  event_id uuid PRIMARY KEY,

  -- Cursor del pull. bigserial y no `received_at`: dos eventos pueden llegar en el
  -- mismo milisegundo, y un cliente que sincroniza entre ambos con un cursor de
  -- tiempo los pierde para siempre. El bigserial es total y monotono.
  seq_global bigserial NOT NULL UNIQUE,

  org_id uuid NOT NULL,
  venue_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Secuencia monotona POR DISPOSITIVO. Detecta huecos y reordenamientos.
  seq integer NOT NULL,

  type varchar(40) NOT NULL,
  payload jsonb NOT NULL,

  -- Reloj del DISPOSITIVO. Puede estar desfasado. Para reportes nunca se usa:
  -- manda `received_at`.
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),

  -- APPLIED | DUPLICATE | REJECTED | CONFLICT
  status varchar(12) NOT NULL DEFAULT 'APPLIED',
  -- Qué pasó: id generado, mesa reasignada, motivo del rechazo. El cliente lo lee
  -- para corregir su réplica local.
  result jsonb,

  CONSTRAINT sync_events_status_valid CHECK (status IN ('APPLIED','DUPLICATE','REJECTED','CONFLICT')),
  CONSTRAINT sync_events_type_valid CHECK (type IN (
    'TABLE_OPENED','TABLE_ITEM_ADDED','TABLE_ITEM_VOIDED','TABLE_NOTE_SET',
    'ORDER_OPENED','ORDER_ITEM_ADDED','ORDER_ITEM_VOIDED','ORDER_NOTE_SET',
    'ORDER_CLOSED','ORDER_CANCELED','ORDER_ITEM_COURSE_SET','ORDER_SEAT_SET',
    'PAYMENT_RECORDED','TIP_ADDED','SPLIT_SAVED','SHIFT_OPENED','SHIFT_CASH_MOVEMENT',
    'KDS_STATUS_SET'
  ))
);

-- El pull incremental se lee por acá.
CREATE INDEX sync_events_org_seq_idx ON sync_events (org_id, seq_global);
CREATE INDEX sync_events_device_seq_idx ON sync_events (device_id, seq);
-- Para detectar huecos en la secuencia de un dispositivo.
CREATE INDEX sync_events_received_idx ON sync_events (venue_id, received_at);

-- -----------------------------------------------------------------------------
-- Turnos: la caja se cierra una vez, pero los pagos entran mientras está abierta
-- -----------------------------------------------------------------------------
ALTER TABLE orders
  ADD CONSTRAINT orders_closed_consistent CHECK (
    status NOT IN ('CLOSED','CANCELLED')
    OR (closed_at IS NOT NULL AND shift_id IS NOT NULL)
  );

-- =============================================================================
-- RLS
--
-- Mismas reglas que en la Fase 0: ENABLE + FORCE, comparación contra
-- `app.current_org`, y `nullif(...,'')` porque `current_setting` devuelve cadena
-- vacía (no NULL) tras una transacción con `set_config(..., true)`.
-- =============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stations','categories','products','modifier_groups','modifiers',
    'product_modifier_groups','floors','tables','shifts','cash_movements',
    'orders','order_items','order_item_modifiers','payments','bill_splits',
    'kitchen_tickets','sync_events'
  ]
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

-- =============================================================================
-- Red de seguridad del build
--
-- `drizzle-kit generate` no conoce las policies. Este chequeo corre en la
-- migración: si alguien agrega una tabla de tenant y olvida su policy, el build
-- falla en vez de dejar una tabla abierta.
-- =============================================================================
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT (c.relname = ANY (ARRAY['permissions', '__comanda_migrations', 'sync_cursor']))
    AND NOT c.relrowsecurity;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Las siguientes tablas no tienen RLS habilitada: %', missing;
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  stations, categories, products, modifier_groups, modifiers,
  product_modifier_groups, floors, tables, shifts, cash_movements,
  orders, order_items, order_item_modifiers, payments, bill_splits,
  kitchen_tickets, sync_events
  TO comanda_app;