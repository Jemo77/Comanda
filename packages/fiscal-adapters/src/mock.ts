import type { FiscalCredentials, FiscalInvoiceRequest, FiscalInvoiceResult, FiscalProvider } from './types';
import { buildFiscalQrUrl } from './qr';

/**
 * Provider falso, identico en forma al real.
 *
 * Es el que corre en desarrollo y en los tests de la API: el camino feliz de
 * facturar nunca depende de AFIP, y una migracion rota o un typo en el SQL se
 * detecta igual. Deterministico a proposito: el CAE es una funcion del pedido,
 * asi dos llamadas con el mismo pedido dan el mismo comprobante y el test no
 * depende de azar.
 */
export class MockFiscalProvider implements FiscalProvider {
  readonly key = 'mock';

  constructor(private readonly credentials: Pick<FiscalCredentials, 'cuit' | 'environment'> = { cuit: '30712345678', environment: 'homo' }) {}

  async issueInvoice(request: FiscalInvoiceRequest): Promise<FiscalInvoiceResult> {
    return this.authorize(request, false);
  }

  async creditNote(request: FiscalInvoiceRequest): Promise<FiscalInvoiceResult> {
    return this.authorize(request, true);
  }

  private authorize(request: FiscalInvoiceRequest, _creditNote: boolean): FiscalInvoiceResult {
    const voucherNumber = hashToNumber(request.internalId);
    const cae = hashToCae(request.internalId);
    const issueDate = request.issueDate.slice(0, 4) + '-' + request.issueDate.slice(4, 6) + '-' + request.issueDate.slice(6, 8);
    return {
      voucherNumber,
      cae,
      // Los CAE vencen a los 10 dias; para el mock alcanza con una fecha fija.
      caeDue: new Date(Date.parse(issueDate) + 10 * 86_400_000).toISOString().slice(0, 10),
      qrPayload: buildFiscalQrUrl({
        issueDate,
        cuit: this.credentials.cuit,
        pointOfSale: request.pointOfSale,
        type: request.type,
        voucherNumber,
        totalCents: request.totalCents,
        currency: request.currency,
        cae,
        receiverTaxId: request.receiver.taxId,
      }),
      contingency: false,
    };
  }
}

function hashToNumber(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 999_999 + 1;
}

function hashToCae(seed: string): string {
  let h = 0x9e3779b9;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x85ebca6b);
  }
  return String((h >>> 0) % 10_000_000_000_000).padStart(14, '7');
}
