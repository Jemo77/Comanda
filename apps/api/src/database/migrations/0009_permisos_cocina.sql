-- =============================================================================
-- Comanda · Fase 1: permisos de cocina (KDS)
--
-- Por qué existe
-- --------------
-- El catálogo de permisos vive en `packages/domain/src/permissions.ts` y el seed lo
-- sincroniza con la tabla `permissions`. Pero los tenants que ya existen no vuelven a
-- correr el seed en un deploy, así que sin esta migración un local que ya estaba dado
-- de alta se queda sin `kitchen.read` y `kitchen.advance`: el KDS responde 403 para
-- todos y el síntoma es "el botón de cocina no le hace nada a nadie".
--
-- `permissions` es la única tabla del schema sin RLS (ver la nota de `0000`), porque
-- el catálogo es idéntico para todos los tenants: son strings, no datos de negocio.
-- Por eso el INSERT puede correr sin contexto de tenant.
--
-- Es idempotente a propósito: el seed corre en los flujos de alta de organización, y
-- esta migración corre en el deploy. Las dos caminos tienen que poder tocar la misma
-- fila sin que una rompa la otra.
-- =============================================================================

INSERT INTO permissions (key, description) VALUES
  ('kitchen.read', 'Ver la pantalla de cocina'),
  ('kitchen.advance', 'Avanzar el estado de un ticket de cocina')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- -----------------------------------------------------------------------------
-- Un ticket por (comanda, estación)
-- -----------------------------------------------------------------------------
--
-- Este índice es lo que hace idempotente `ensureTicketsForOrder`. El sync reenvía la
-- outbox entera cuando se cae la red: sin el, cada reenvío del mismo `ORDER_ITEM_ADDED`
-- insertaría un ticket nuevo para la misma estación y la cocina vería el mismo papel
-- dos veces — el plato sale una vez de más y nadie sabe por qué.
--
-- `orders` y `stations` se borran en cascada, así que el índice no necesita trigger de
-- limpieza: el `ON DELETE CASCADE` de `kitchen_tickets` lo resuelve.
CREATE UNIQUE INDEX IF NOT EXISTS kitchen_tickets_order_station_key
  ON kitchen_tickets (order_id, station_id);