import { describe, expect, it } from 'vitest';
import { AfipFiscalProvider, type CmsProvider, type WsaaTransport } from './afip';
import { FiscalRejectionError, FiscalUnavailableError, type FiscalInvoiceRequest } from './types';

/**
 * AFIP/ARCA con transporte falso: el provider se prueba contra XML que es lo
 * que de verdad contesta el homologador (forma y campos), sin tocar la red.
 */

const request: FiscalInvoiceRequest = {
  type: 'FACT_B',
  pointOfSale: '00003',
  internalId: 'abc',
  receiver: { name: 'Consumidor Final', taxId: '0', condition: 'CONSUMIDOR_FINAL' },
  concept: 1,
  issueDate: '20261002',
  currency: 'ARS',
  netoCents: 82644,
  ivaCents: 17356,
  totalCents: 100000,
  ivaLines: [{ rate: 0.21, netoCents: 82644, ivaCents: 17356 }],
};

const WSAA_OK = `<?xml version="1.0"?><loginCmsResponse><token>TOKEN123</token><sign>SIGN456</sign></loginCmsResponse>`;

const WSFE_OK = `<?xml version="1.0"?><FECAESolicitarResponse><FECAESolicitarResult><FeDetResp><CbteDesde>10234</CbteDesde><Resultado>A</Resultado><CAE>71112222333444</CAE><CAEFchVto>20261012</CAEFchVto></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`;

const WSFE_REJECTED = `<?xml version="1.0"?><FECAESolicitarResponse><FECAESolicitarResult><FeDetResp><Resultado>R</Resultado><Errors><Err><Code>10015</Code><Msg>CUIT del emisor invalido</Msg></Err></Errors></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`;

class FakeTransport implements WsaaTransport {
  calls: Array<{ url: string; action: string }> = [];
  constructor(private readonly responses: Record<string, string>) {}

  async call(url: string, action: string): Promise<string> {
    this.calls.push({ url, action });
    const response = this.responses[action];
    if (!response) throw new FiscalUnavailableError(`Sin respuesta para ${action}`);
    return response;
  }
}

const fakeCms: CmsProvider = async () => 'BASE64CMS==';
const credentials = { cuit: '30712345678', certRef: 'secret://cert', environment: 'homo' as const };

describe('AfipFiscalProvider', () => {
  it('emite contra el homologador y devuelve CAE + QR', async () => {
    const transport = new FakeTransport({ loginCms: WSAA_OK, 'http://ar.gov.afip.dif.FEV1/FECAESolicitar': WSFE_OK });
    const provider = new AfipFiscalProvider(credentials, transport, fakeCms);

    const result = await provider.issueInvoice(request);

    expect(result.voucherNumber).toBe(10234);
    expect(result.cae).toBe('71112222333444');
    expect(result.caeDue).toBe('2026-10-12');
    expect(result.qrPayload).toContain('afip.gob.ar/fe/qr');
    expect(result.contingency).toBe(false);
    // Las dos llamadas: WSAA y WSFE, en ese orden.
    expect(transport.calls.map((c) => c.action)).toEqual([
      'loginCms',
      'http://ar.gov.afip.dif.FEV1/FECAESolicitar',
    ]);
    expect(transport.calls[0]!.url).toContain('wsaahomo');
    expect(transport.calls[1]!.url).toContain('wswhomo');
  });

  it('un rechazo del fisco es terminal, con el mensaje del fisco', async () => {
    const transport = new FakeTransport({ loginCms: WSAA_OK, 'http://ar.gov.afip.dif.FEV1/FECAESolicitar': WSFE_REJECTED });
    const provider = new AfipFiscalProvider(credentials, transport, fakeCms);

    await expect(provider.issueInvoice(request)).rejects.toMatchObject({
      name: 'FiscalRejectionError',
      code: 'FISCAL_REJECTED',
    });
    await expect(provider.issueInvoice(request)).rejects.toBeInstanceOf(FiscalRejectionError);
  });

  it('WSFE caido sin CAEA: la cola tiene que reintentar', async () => {
    const transport = new FakeTransport({ loginCms: WSAA_OK }); // WSFE falta
    const provider = new AfipFiscalProvider(credentials, transport, fakeCms);

    await expect(provider.issueInvoice(request)).rejects.toMatchObject({
      name: 'FiscalUnavailableError',
    });
  });

  it('WSFE caido con CAEA vigente: contingencia marcada', async () => {
    const transport = new FakeTransport({ loginCms: WSAA_OK });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const provider = new AfipFiscalProvider(
      { ...credentials, caeaNumber: '71234567890123', caeaExpiresOn: tomorrow },
      transport,
      fakeCms,
    );

    const result = await provider.issueInvoice(request);
    expect(result.contingency).toBe(true);
    expect(result.cae).toBe('71234567890123');
    expect(result.caeDue).toBe(tomorrow);
  });

  it('CAEA vencido no sirve de contingencia', async () => {
    const transport = new FakeTransport({ loginCms: WSAA_OK });
    const provider = new AfipFiscalProvider(
      { ...credentials, caeaNumber: '71234567890123', caeaExpiresOn: '2020-01-01' },
      transport,
      fakeCms,
    );

    await expect(provider.issueInvoice(request)).rejects.toMatchObject({
      name: 'FiscalUnavailableError',
    });
  });

  it('un WSAA sin token/sign es rechazo, no factura', async () => {
    const transport = new FakeTransport({
      loginCms: `<loginCmsResponse><header><faultcode>a:cms.bad</faultcode></header></loginCmsResponse>`,
      'http://ar.gov.afip.dif.FEV1/FECAESolicitar': WSFE_OK,
    });
    const provider = new AfipFiscalProvider(credentials, transport, fakeCms);

    await expect(provider.issueInvoice(request)).rejects.toBeInstanceOf(FiscalRejectionError);
  });
});
