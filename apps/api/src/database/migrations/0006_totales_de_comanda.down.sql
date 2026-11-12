-- Reversa de 0006_totales_de_comanda.
--
-- Se vuelven a quitar las columnas de descuento y servicio. `total_cents` y
-- `tip_cents` quedan intactos: son de la migracion 0004.

-- La constraint vuelve al estado de la 0005, sin `ORDER_CHARGES_SET`.
ALTER TABLE sync_events
  DROP CONSTRAINT IF EXISTS sync_events_type_valid;

ALTER TABLE sync_events
  ADD CONSTRAINT sync_events_type_valid CHECK (type IN (
    'ORDER_OPENED','ORDER_ITEM_ADDED','ORDER_ITEM_VOIDED','ORDER_NOTE_SET',
    'ORDER_CLOSED','ORDER_CANCELED','ORDER_ITEM_COURSE_SET','ORDER_SEAT_SET',
    'PAYMENT_RECORDED','TIP_ADDED','SPLIT_SAVED',
    'SHIFT_OPENED','SHIFT_CASH_MOVEMENT',
    'KDS_STATUS_SET',
    'TABLE_OPENED','TABLE_ITEM_ADDED','TABLE_ITEM_VOIDED','TABLE_NOTE_SET',
    'TABLE_STATUS_CHANGED','CATALOG_PUBLISHED'
  ));

DROP INDEX IF EXISTS orders_venue_status_total_idx;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_service_bps_range;
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_discount_non_negative;
ALTER TABLE orders
  DROP COLUMN IF EXISTS service_bps;
ALTER TABLE orders
  DROP COLUMN IF EXISTS discount_cents;