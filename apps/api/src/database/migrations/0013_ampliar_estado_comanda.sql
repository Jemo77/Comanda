-- =============================================================================
-- Comanda · Fase 3 (fix): el largo de orders.status
--
-- `orders.status` era varchar(16), como cuando solo habia OPEN/CLOSED/CANCELLED.
-- Al agregar PENDIENTE_APROBACION (20 caracteres) el INSERT rompe con
-- "value too long for type character varying(16)" y la mesa quedaba trabada.
-- =============================================================================
ALTER TABLE orders ALTER COLUMN status TYPE varchar(24);
