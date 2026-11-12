-- Reversa de 0005_sync_eventos_de_servidor.
--
-- Se restituye la constraint original de la 0004 para que un `down` deje la base
-- en un estado que la 0004 pueda volver a aplicar sin cambios.

ALTER TABLE sync_events
  DROP CONSTRAINT IF EXISTS sync_events_seq_sign;

DROP TABLE IF EXISTS pos_device_state;

ALTER TABLE sync_events
  DROP CONSTRAINT IF EXISTS sync_events_type_valid;

ALTER TABLE sync_events
  ADD CONSTRAINT sync_events_type_valid CHECK (type IN (
    'TABLE_OPENED','TABLE_ITEM_ADDED','TABLE_ITEM_VOIDED','TABLE_NOTE_SET',
    'ORDER_OPENED','ORDER_ITEM_ADDED','ORDER_ITEM_VOIDED','ORDER_NOTE_SET',
    'ORDER_CLOSED','ORDER_CANCELED','ORDER_ITEM_COURSE_SET','ORDER_SEAT_SET',
    'PAYMENT_RECORDED','TIP_ADDED','SPLIT_SAVED','SHIFT_OPENED','SHIFT_CASH_MOVEMENT',
    'KDS_STATUS_SET'
  ));