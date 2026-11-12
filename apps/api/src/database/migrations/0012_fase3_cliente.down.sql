DROP FUNCTION IF EXISTS platform_mark_webhook_event(uuid, text);
DROP FUNCTION IF EXISTS platform_register_webhook_event(text, text, jsonb);
DROP FUNCTION IF EXISTS platform_venue_tenant(uuid);
DROP FUNCTION IF EXISTS platform_order_tenant(uuid);
DROP FUNCTION IF EXISTS platform_intent_lookup(text);
DROP TRIGGER IF EXISTS loyalty_entries_no_delete ON loyalty_entries;
DROP TRIGGER IF EXISTS loyalty_entries_no_update ON loyalty_entries;
DROP FUNCTION IF EXISTS loyalty_entries_freeze();
DELETE FROM role_permissions WHERE permission_key IN ('order.approve','loyalty.read','loyalty.redeem');
DELETE FROM permissions WHERE key IN ('order.approve','loyalty.read','loyalty.redeem');
DROP TABLE IF EXISTS payment_webhook_events;
DROP TABLE IF EXISTS payment_intents;
DROP TABLE IF EXISTS loyalty_entries;
DROP TABLE IF EXISTS loyalty_programs;
DROP TABLE IF EXISTS customers;
ALTER TABLE categories DROP COLUMN IF EXISTS name_i18n;
ALTER TABLE products DROP COLUMN IF EXISTS description_i18n, DROP COLUMN IF EXISTS name_i18n, DROP COLUMN IF EXISTS description;
ALTER TABLE tables DROP COLUMN IF EXISTS qr_token_version;
ALTER TABLE orders DROP COLUMN IF EXISTS pickup_at, DROP COLUMN IF EXISTS customer_phone, DROP COLUMN IF EXISTS customer_name;
DROP INDEX IF EXISTS orders_one_open_per_table;
CREATE UNIQUE INDEX orders_one_open_per_table ON orders (table_id)
  WHERE table_id IS NOT NULL AND status IN ('OPEN','PEDIDO_CUENTA');
ALTER TABLE orders DROP CONSTRAINT orders_status_valid;
ALTER TABLE orders ADD CONSTRAINT orders_status_valid
  CHECK (status IN ('OPEN','PEDIDO_CUENTA','CLOSED','CANCELLED'));
