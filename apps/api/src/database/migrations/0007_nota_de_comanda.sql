-- =============================================================================
-- Comanda · Fase 1: la nota de la comanda
--
-- El POS ya manda la nota de una comanda (`ORDER_NOTE_SET` y `TABLE_NOTE_SET` en
-- el catalogo de eventos) y el ticket la imprime, pero `orders` no tenia donde
-- guardarla: el handler del sync receive la nota, actualiza `updated_at` y la
-- descarta. Una nota que el cliente escribio y el servidor no guardo aparece en
-- la tablet que la escribio y desaparece en el proximo `pull`.
--
-- La nota va como columna y no como tabla aparte porque es **un** dato de la
-- comanda, no un historial: se sobreescribe y no tiene fecha propia. El historial
-- que si importa (quien anularon que y por que) ya vive en `audit_log`.
--
-- El tope de 300 es el de `order_items.note` y el de `audit_log.reason`: el
-- widest de los tres manda, asi que una misma columna acepta el mismo texto en
-- los tres lugares.
-- =============================================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS note varchar(300);

COMMENT ON COLUMN orders.note IS
  'Nota de la comanda. Se sobreescribe: no es un historial. Unica nota de la mesa.';