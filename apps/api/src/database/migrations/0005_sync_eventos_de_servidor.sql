-- =============================================================================
-- Comanda · Fase 1: eventos que emite el servidor
--
-- La constraint `sync_events_type_valid` de la migracion 0004 aceptaba solo los
-- tipos que produce el POS. Faltaban los dos que el servidor genera para
-- mantener la replica al dia, y sin ellos no se pueden escribir:
--
--   - `TABLE_STATUS_CHANGED`: la mesa quedo ocupada por otra comanda (el POS la
--     perdi en el conflicto) o se libero. Sin este evento el POS sigue
--     mostrando una mesa ocupada por una comanda que el servidor no tiene.
--   - `CATALOG_PUBLISHED`: el cliente cargo una carta nueva. Es la señal de que
--     la replica tiene que re-hidratarce.
--
-- La alternativa era no emitirlos y resolverlo por polling del `/sync/pull` de
-- las tablas: mas viajes de red y una replica que puede quedar desactualizada
-- entre un pull y el siguiente. Un evento por cambio es mas simple de probar.
-- =============================================================================

-- `shifts.source_event_id`: el POS abre el turno offline y lo sube despues. Sin
-- esta columna, dos tablets que abran caja offline producen dos filas de turno y
-- el arqueo del turno se duplica. Es la misma razon por la que `orders` y
-- `payments` la tienen.
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS source_event_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS shifts_source_event_key
  ON shifts (source_event_id) WHERE source_event_id IS NOT NULL;

ALTER TABLE sync_events
  DROP CONSTRAINT IF EXISTS sync_events_type_valid;

ALTER TABLE sync_events
  ADD CONSTRAINT sync_events_type_valid CHECK (type IN (
    -- Comanda
    'ORDER_OPENED','ORDER_ITEM_ADDED','ORDER_ITEM_VOIDED','ORDER_NOTE_SET',
    'ORDER_CLOSED','ORDER_CANCELED','ORDER_ITEM_COURSE_SET','ORDER_SEAT_SET',
    -- Cobro
    'PAYMENT_RECORDED','TIP_ADDED','SPLIT_SAVED',
    -- Caja
    'SHIFT_OPENED','SHIFT_CASH_MOVEMENT',
    -- Cocina
    'KDS_STATUS_SET',
    -- Salon
    'TABLE_OPENED','TABLE_ITEM_ADDED','TABLE_ITEM_VOIDED','TABLE_NOTE_SET',
    -- Emitidos por el servidor
    'TABLE_STATUS_CHANGED','CATALOG_PUBLISHED'
  ));

-- El `seq` de un evento de servidor es 0: no pertenece a la secuencia de ningun
-- dispositivo. La constraint siguiente deja eso explicito en vez de dejarlo
-- como una convencion que el proximo que lea la tabla no va a conocer.
ALTER TABLE sync_events
  ADD CONSTRAINT sync_events_seq_sign CHECK (
    -- Un dispositivo siempre arranca en 1 y es monotono.
    (seq = 0 AND actor_id IS NULL) OR seq > 0
  );

-- -----------------------------------------------------------------------------
-- El POS necesita guardar su replica con mas de una comanda abierta
-- -----------------------------------------------------------------------------
-- `active_order` no vivia en ningun lado. Sin el, la UI tiene que adivinar cual
-- de las comandas abiertas es "la" comanda que esta mirando el mozo, y con dos
-- tablets se abre en la comanda equivocada.

CREATE TABLE pos_device_state (
  -- Un dispositivo ve una sola replica a la vez.
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,

  -- Comanda abierta en pantalla. NULL cuando el mozo esta en el mapa de mesas.
  active_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,

  -- Ultimo `seq_global` del pull que se aplico entero. Es lo que permite
  -- reanudar sin volver a bajar toda la historia.
  cursor bigint NOT NULL DEFAULT 0,

  -- Secuencia del dispositivo, para retomar la outbox sin repetir `seq`.
  local_seq integer NOT NULL DEFAULT 0,

  -- Cuando fue la ultima sincronizacion exitosa. La UI lo muestra como
  -- "sincronizado hace 3 s" para que el mozo sepa si lo que ve esta al dia.
  last_synced_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pos_device_state_org_idx ON pos_device_state (org_id);
CREATE INDEX pos_device_state_venue_idx ON pos_device_state (venue_id);

-- =============================================================================
-- RLS
-- =============================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_device_state']
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

GRANT SELECT, INSERT, UPDATE, DELETE ON pos_device_state TO comanda_app;