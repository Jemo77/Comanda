-- Down de 0004_fase1_pos.sql
--
-- Reversible por diseno (requisito del plan). El orden importa: primero las
-- tablas hijas, despues las padres.

DROP TABLE IF EXISTS sync_events;
DROP TABLE IF EXISTS kitchen_tickets;
DROP TABLE IF EXISTS bill_splits;
DROP TABLE IF EXISTS payments;

ALTER TABLE IF EXISTS orders DROP CONSTRAINT IF EXISTS orders_closed_consistent;
DROP TABLE IF EXISTS order_item_modifiers;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;

DROP TABLE IF EXISTS cash_movements;
DROP TABLE IF EXISTS shifts;

DROP TABLE IF EXISTS tables;
DROP TABLE IF EXISTS floors;

DROP TABLE IF EXISTS product_modifier_groups;
DROP TABLE IF EXISTS modifiers;
DROP TABLE IF EXISTS modifier_groups;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;

DROP TABLE IF EXISTS stations;