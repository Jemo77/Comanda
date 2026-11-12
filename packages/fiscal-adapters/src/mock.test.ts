import { describe, expect, it } from 'vitest';
import { MockFiscalProvider } from './mock';
import type { FiscalInvoiceRequest } from './types';

const request: FiscalInvoiceRequest = {
  type: 'FACT_B',
  pointOfSale: '00001',
  internalId: 'order-123',
  receiver: { name: 'Consumidor Final', taxId: '0', condition: 'CONSUMIDOR_FINAL' },
  concept: 1,
  issueDate: '20261002',
  currency: 'ARS',
  netoCents: 82644,
  ivaCents: 17356,
  totalCents: 100000,
  ivaLines: [{ rate: 0.21, netoCents: 82644, ivaCents: 17356 }],
};

describe('MockFiscalProvider', () => {
  it('es deterministico: misma entrada, mismo comprobante', async () => {
    const provider = new MockFiscalProvider();
    const a = await provider.issueInvoice(request);
    const b = await provider.issueInvoice(request);
    expect(a).toEqual(b);
    expect(a.cae).toMatch(/^\d{14}$/);
    expect(a.qrPayload).toContain('afip.gob.ar/fe/qr');
    expect(a.contingency).toBe(false);
  });

  it('pedidos distintos dan comprobantes distintos', async () => {
    const provider = new MockFiscalProvider();
    const a = await provider.issueInvoice(request);
    const b = await provider.issueInvoice({ ...request, internalId: 'order-999' });
    expect(a.voucherNumber).not.toBe(b.voucherNumber);
  });

  it('las notas de credito usan el mismo camino', async () => {
    const provider = new MockFiscalProvider();
    const nc = await provider.creditNote({ ...request, type: 'NC_B' });
    expect(nc.voucherNumber).toBeGreaterThan(0);
  });
});
