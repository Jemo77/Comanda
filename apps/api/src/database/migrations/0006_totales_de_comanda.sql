-- =============================================================================
-- Comanda · Fase 1: el total se calcula una sola vez, con el mismo codigo
--
-- `orders` guardaba `total_cents` y `tip_cents`, pero no el descuento ni el
-- servicio. El POS calcula el total con `orderTotals()` del dominio, que incluye
-- servicio y descuento; el servidor lo recalculaba con un `SUM` propio que solo
-- cubria los items.
--
-- Consecuencia: el total que muestra el mozo y el que cobra el sistema son
-- distintos en cuanto hay descuento o servicio. Es el bug que la funcion compartida
-- existia para evitar, y estaba del lado del servidor.
--
-- La solucion no es mantener dos implementaciones: es guardar los parametros y
-- llamar a la MISMA funcion en los dos lados. Para eso hacen falta las columnas
-- que hoy no existen.
-- =============================================================================

-- Descuento ya aplicado a la comanda, en centavos enteros.
--
-- Se guarda el importe y no la regla: la regla puede desaparecer del catalogo
-- (las promos son de la Fase 2) y el total tiene que seguir siendo explicable
-- dentro de seis meses.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS discount_cents integer NOT NULL DEFAULT 0
  CONSTRAINT orders_discount_non_negative CHECK (discount_cents >= 0);

-- Servicio en basis points: 1000 = 10%.
--
-- Se guarda la TASA y no el importe, a diferencia del descuento. La razon es que
-- la tasa viene de la configuracion del local, no de una decision del mozo: si
-- el dueño cambia el servicio de 10% a 12%, las comandas abiertas tienen que
-- reflejar la tasa nueva, y guardar el importe las dejaria con el numero viejo.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS service_bps integer NOT NULL DEFAULT 0
  CONSTRAINT orders_service_bps_range CHECK (service_bps >= 0 AND service_bps <= 10000);

COMMENT ON COLUMN orders.discount_cents IS
  'Descuento ya aplicado, en centavos. Snapshot: la regla puede desaparecer.';
COMMENT ON COLUMN orders.service_bps IS
  'Tasa de servicio en basis points (1000 = 10%). Tasa y no importe, para que un cambio de configuracion afecte a las comandas abiertas.';

-- El total cacheado tiene que ser consistente con lo que se puede recalcular.
-- No se agrega un CHECK con la formula completa porque PostgreSQL no puede
-- llamar a una funcion de TypeScript: la garantia real la da `orderTotals` del
-- dominio, y el test de integracion compara ambos caminos.
--
-- Este indice si importa: el recalculo del total recorre los items por comanda.
CREATE INDEX IF NOT EXISTS orders_venue_status_total_idx ON orders (venue_id, status)
  INCLUDE (total_cents, discount_cents, tip_cents);

-- -----------------------------------------------------------------------------
-- `ORDER_CHARGES_SET`: descuento y tasa de servicio
-- -----------------------------------------------------------------------------
-- Va en una migracion nueva y no en la 0005 a proposito: la 0005 ya estaba
-- aplicada y el guard de checksum del migrador rechaza editarla. Asi la disciplina
-- de "no tocar migraciones aplicadas" se cumple en los dos casos.
ALTER TABLE sync_events
  DROP CONSTRAINT IF EXISTS sync_events_type_valid;

ALTER TABLE sync_events
  ADD CONSTRAINT sync_events_type_valid CHECK (type IN (
    -- Comanda
    'ORDER_OPENED','ORDER_ITEM_ADDED','ORDER_ITEM_VOIDED','ORDER_NOTE_SET',
    'ORDER_CLOSED','ORDER_CANCELED','ORDER_ITEM_COURSE_SET','ORDER_SEAT_SET',
    -- Cobro
    'PAYMENT_RECORDED','TIP_ADDED','SPLIT_SAVED','ORDER_CHARGES_SET',
    -- Caja
    'SHIFT_OPENED','SHIFT_CASH_MOVEMENT',
    -- Cocina
    'KDS_STATUS_SET',
    -- Salon
    'TABLE_OPENED','TABLE_ITEM_ADDED','TABLE_ITEM_VOIDED','TABLE_NOTE_SET',
    -- Emitidos por el servidor
    'TABLE_STATUS_CHANGED','CATALOG_PUBLISHED'
  ));