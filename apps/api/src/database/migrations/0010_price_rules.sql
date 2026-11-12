-- =============================================================================
-- Comanda · Fase 2: promociones (motor de precios del lado del servidor)
--
-- `price_rules` es la tabla que faltaba para encender el motor de promociones:
-- `orders.service#addItem` ya evalua con `@comanda/pricing-engine` y ya guarda
-- el snapshot en `order_items.applied_rules`; lo que hoy es un stub (`activeRules`
-- devolvia siempre []) pasa a ser esta consulta.
--
-- Forma de la fila = `PromotionRule` del engine (packages/pricing-engine):
-- `type`, `scope`, `scope_id`, `schedule` (jsonb con daysOfWeek/from/to/timezone/
-- startsOn/endsOn), `params` (jsonb con bps/cents/n/m/priceCents segun el tipo),
-- `priority`, `stackable`, `active`.
--
-- `venue_id` NULL = la promo aplica a todos los locales de la organizacion.
-- =============================================================================

CREATE TABLE price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  -- NULL = aplica a todos los locales de la organizacion.
  venue_id uuid REFERENCES venues(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  type varchar(16) NOT NULL,
  scope varchar(12) NOT NULL,
  -- Id del producto o categoria segun `scope`. NULL cuando scope = ORDER.
  scope_id uuid,
  -- Schedule del engine: { daysOfWeek, from, to, timezone, startsOn?, endsOn? }.
  -- NULL = siempre vigente.
  schedule jsonb,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Numero mas alto gana. Dos reglas con la misma prioridad: la apilable primero.
  priority integer NOT NULL DEFAULT 0,
  stackable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_rules_type_valid CHECK (type IN ('PERCENT','FIXED','BOGO','NXM','PRICE_OVERRIDE')),
  CONSTRAINT price_rules_scope_valid CHECK (scope IN ('PRODUCT','CATEGORY','ORDER')),
  -- ORDER no tiene scope_id; PRODUCT y CATEGORY si. Sin esta check, una regla
  -- PRODUCT con scope_id NULL aplicaria a "todos los productos" sin decirlo.
  CONSTRAINT price_rules_scope_id_consistent CHECK (
    (scope = 'ORDER' AND scope_id IS NULL) OR (scope <> 'ORDER' AND scope_id IS NOT NULL)
  )
);

CREATE INDEX price_rules_org_active_idx ON price_rules (org_id, active);
CREATE INDEX price_rules_venue_idx ON price_rules (venue_id) WHERE venue_id IS NOT NULL;
CREATE INDEX price_rules_scope_idx ON price_rules (org_id, scope, scope_id) WHERE active;

-- =============================================================================
-- RLS: misma plantilla que el resto de las tablas de tenant.
-- =============================================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE price_rules ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE price_rules FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY price_rules_tenant_select ON price_rules FOR SELECT USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)';
  EXECUTE 'CREATE POLICY price_rules_tenant_insert ON price_rules FOR INSERT WITH CHECK (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)';
  EXECUTE 'CREATE POLICY price_rules_tenant_update ON price_rules FOR UPDATE USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)';
  EXECUTE 'CREATE POLICY price_rules_tenant_delete ON price_rules FOR DELETE USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)';
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON price_rules TO comanda_app;
