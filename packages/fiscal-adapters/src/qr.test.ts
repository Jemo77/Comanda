import { describe, expect, it } from 'vitest';
import { buildFiscalQrUrl, parseFiscalQrUrl } from './qr';

describe('QR fiscal', () => {
  const url = buildFiscalQrUrl({
    issueDate: '2026-10-02',
    cuit: '30712345678',
    pointOfSale: '00003',
    type: 'FACT_B',
    voucherNumber: 10234,
    totalCents: 123456,
    currency: 'ARS',
    cae: '71234567890123',
    receiverTaxId: '0',
  });

  it('es una URL de afip.gob.ar con payload base64', () => {
    expect(url.startsWith('https://www.afip.gob.ar/fe/qr/?p=')).toBe(true);
  });

  it('el payload decodifica con los campos obligatorios', () => {
    const payload = parseFiscalQrUrl(url);
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      ver: 1,
      fecha: '2026-10-02',
      cuit: 30712345678,
      ptoVta: 3,
      tipoCmp: 6,
      nroCmp: 10234,
      importe: 1234.56,
      moneda: 'ARS',
      ctz: 1,
      tipoDocRec: 99,
      tipoCodAut: 'E',
      codAut: 71234567890123,
    });
  });

  it('mapea los codigos de comprobante', () => {
    for (const [type, code] of [
      ['FACT_A', 1],
      ['FACT_B', 6],
      ['FACT_C', 11],
      ['NC_A', 3],
      ['NC_B', 8],
      ['NC_C', 13],
    ] as const) {
      const parsed = parseFiscalQrUrl(
        buildFiscalQrUrl({
          issueDate: '2026-01-01',
          cuit: '30111222333',
          pointOfSale: '1',
          type,
          voucherNumber: 1,
          totalCents: 100,
          currency: 'ARS',
          cae: '71234567890123',
          receiverTaxId: '20123456789',
        }),
      );
      expect(parsed?.tipoCmp).toBe(code);
    }
  });

  it('rechaza entradas que no son QR', () => {
    expect(parseFiscalQrUrl('https://example.com/nope')).toBeNull();
  });
});
