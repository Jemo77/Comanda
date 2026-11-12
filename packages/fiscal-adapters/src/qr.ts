import type { FiscalInvoiceRequest } from './types';

/**
 * QR fiscal.
 *
 * AFIP define el QR como una URL: `https://www.afip.gob.ar/fe/qr/?p=<base64url-ish>`
 * donde el payload es un JSON en base64 (normal, no url-safe: lo exige asi la
 * especificacion) con los datos del comprobante. Se guarda la URL completa porque
 * el ticket la imprime como string para el generador del QR, no decodifica nunca.
 */
export function buildFiscalQrUrl(params: {
  issueDate: string; // YYYY-MM-DD
  cuit: string;
  pointOfSale: string;
  type: FiscalInvoiceRequest['type'];
  voucherNumber: number;
  totalCents: number;
  currency: string;
  cae: string;
  receiverTaxId: string;
  /** Tipo de cambio a pesos; 1 cuando moneda = ARS. */
  exchangeRate?: number;
}): string {
  const typeCode = VOUCHER_TYPE_CODES[params.type];
  const payload = {
    ver: 1,
    fecha: params.issueDate,
    cuit: Number(params.cuit),
    ptoVta: Number(params.pointOfSale),
    tipoCmp: typeCode,
    nroCmp: params.voucherNumber,
    importe: params.totalCents / 100,
    moneda: params.currency,
    ctz: params.exchangeRate ?? 1,
    tipoDocRec: params.receiverTaxId === '0' ? 99 : 80,
    nroDocRec: Number(params.receiverTaxId === '0' ? 0 : params.receiverTaxId),
    tipoCodAut: 'E',
    codAut: Number(params.cae),
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `https://www.afip.gob.ar/fe/qr/?p=${b64}`;
}

/** Codigos de comprobante de AFIP para el QR. */
const VOUCHER_TYPE_CODES: Record<FiscalInvoiceRequest['type'], number> = {
  FACT_A: 1,
  FACT_B: 6,
  FACT_C: 11,
  NC_A: 3,
  NC_B: 8,
  NC_C: 13,
};

/** Decodifica el payload de un QR para auditoria y tests (nunca en el cliente). */
export function parseFiscalQrUrl(url: string): Record<string, unknown> | null {
  const marker = '?p=';
  const index = url.indexOf(marker);
  if (index === -1) return null;
  try {
    return JSON.parse(Buffer.from(url.slice(index + marker.length), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
