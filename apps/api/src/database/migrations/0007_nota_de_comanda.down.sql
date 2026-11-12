-- Reversa de 0007_nota_de_comanda.
--
-- Se quita la columna. Las notas de comanda que ya se escribieron se pierden:
-- es el mismo criterio que usa el resto de las reversas, donde el dato derivado
-- se recalcula y el historico vive en `audit_log`.

ALTER TABLE orders
  DROP COLUMN IF EXISTS note;