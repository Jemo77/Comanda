import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Token del QR de mesa.
 *
 * El token es HMAC-SHA256(secreto, `comanda-table-qr|{venueId}|{tableId}|{version}`)
 * truncado a 22 caracteres base64url (132 bits: de sobra para una URL). El secreto
 * vive en el entorno, NUNCA en la base: si la base se filtra, los QR siguen siendo
 * válidos pero nadie puede fabricarlos.
 *
 * Rotar es incrementar `tables.qr_token_version`. Los QR impresos antes dejan de
 * validar y el encargado reimprime el nuevo. Sin permissible oracle: el POST de
 * pedido responde igual con token inválido o inexistente (404 de mesa).
 */

const PURPOSE = 'comanda-table-qr';

export function tableToken(
  secret: string,
  venueId: string,
  tableId: string,
  version: number,
): string {
  return createHmac('sha256', secret)
    .update(`${PURPOSE}|${venueId}|${tableId}|${version}`)
    .digest('base64url')
    .slice(0, 22);
}

export function verifyTableToken(
  secret: string,
  venueId: string,
  tableId: string,
  version: number,
  token: string,
): boolean {
  const expected = tableToken(secret, venueId, tableId, version);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
