import type {
  FiscalCredentials,
  FiscalInvoiceRequest,
  FiscalInvoiceResult,
  FiscalProvider,
  FiscalVoucherType,
} from './types';
import { FiscalRejectionError, FiscalUnavailableError } from './types';
import { buildFiscalQrUrl } from './qr';

/**
 * AFIP/ARCA WSFE.
 *
 * Todo lo que no es deterministico esta inyectado, porque un test que pega de
 * verdad al homologador es un test que falla los viernes:
 *
 *  - `transport`: la transaccion HTTP. En produccion es `HttpWsaaTransport`; en
 *    tests, un doble que devuelve XML de ejemplo.
 *  - `cmsProvider`: firma del TRA de WSAA con el certificado del local. En
 *    produccion se resuelve con el .key del vault; en tests, cualquier string.
 *
 * El provider NO guarda el token: cada emision resuelve WSAA fresco. Un token
 * cacheado al disco puede expirar y peor, escribirse con permisos demas.
 */

export interface WsaaTransport {
  call(url: string, action: string, envelope: string): Promise<string>;
}

export type CmsProvider = (serviceName: string) => Promise<string>;

export class HttpWsaaTransport implements WsaaTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async call(url: string, action: string, envelope: string): Promise<string> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: action,
      },
      body: envelope,
    });
    if (!response.ok) {
      throw new FiscalUnavailableError(`WSFE/WSAA respondio HTTP ${response.status}`);
    }
    return response.text();
  }
}

const WSFE_TYPE_CODES: Record<FiscalVoucherType, number> = {
  FACT_A: 1,
  FACT_B: 6,
  FACT_C: 11,
  NC_A: 3,
  NC_B: 8,
  NC_C: 13,
};

const IVA_ID_BY_RATE: Array<{ rate: number; id: number }> = [
  { rate: 0.21, id: 5 },
  { rate: 0.105, id: 4 },
  { rate: 0.27, id: 6 },
  { rate: 0.05, id: 8 },
  { rate: 0.025, id: 9 },
  { rate: 0, id: 3 },
];

function ivaId(rate: number): number {
  const found = IVA_ID_BY_RATE.find((r) => Math.abs(r.rate - rate) < 0.0001);
  if (!found) throw new FiscalRejectionError(`Alicuota no soportada por el mapeo WSFE: ${rate}`);
  return found.id;
}

export class AfipFiscalProvider implements FiscalProvider {
  readonly key = 'afip';

  constructor(
    private readonly credentials: FiscalCredentials,
    private readonly transport: WsaaTransport,
    private readonly cmsProvider: CmsProvider,
  ) {}

  async issueInvoice(request: FiscalInvoiceRequest): Promise<FiscalInvoiceResult> {
    return this.send(request, false);
  }

  async creditNote(request: FiscalInvoiceRequest): Promise<FiscalInvoiceResult> {
    return this.send(request, true);
  }

  private async send(request: FiscalInvoiceRequest, _creditNote: boolean): Promise<FiscalInvoiceResult> {
    const environment = this.credentials.environment;
    const wsaaUrl =
      environment === 'prod'
        ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
        : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
    const wsfeUrl =
      environment === 'prod'
        ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
        : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';

    try {
      const { token, sign } = await this.login(wsaaUrl);
      const envelope = buildFECAESolicitar(request, this.credentials.cuit, token, sign);
      const xml = await this.transport.call(wsfeUrl, 'http://ar.gov.afip.dif.FEV1/FECAESolicitar', envelope);
      return this.parseResult(xml, request);
    } catch (error) {
      if (error instanceof FiscalUnavailableError) {
        // Contingencia: WSFE caido y hay CAEA vigente -> emitir con CAEA y
        // registrar que quedo contingente. Si no, la cola reintenta despues.
        const contingency = this.tryContingency(request);
        if (contingency) return contingency;
      }
      throw error;
    }
  }

  private tryContingency(request: FiscalInvoiceRequest): FiscalInvoiceResult | null {
    if (!this.credentials.caeaNumber || !this.credentials.caeaExpiresOn) return null;
    const today = new Date().toISOString().slice(0, 10);
    if (this.credentials.caeaExpiresOn < today) return null;

    const issueDate = normalizeDate(request.issueDate);
    return {
      voucherNumber: hashNumber(request.internalId),
      cae: this.credentials.caeaNumber,
      caeDue: this.credentials.caeaExpiresOn,
      qrPayload: buildFiscalQrUrl({
        issueDate,
        cuit: this.credentials.cuit,
        pointOfSale: request.pointOfSale,
        type: request.type,
        voucherNumber: hashNumber(request.internalId),
        totalCents: request.totalCents,
        currency: request.currency,
        cae: this.credentials.caeaNumber,
        receiverTaxId: request.receiver.taxId,
      }),
      contingency: true,
    };
  }

  private async login(wsaaUrl: string): Promise<{ token: string; sign: string }> {
    const cms = await this.cmsProvider('wsfe');
    const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://wsaa.AFIP.gov.ar"><soapenv:Header/><soapenv:Body><ar:loginCms><ar:in0>${escapeXml(cms)}</ar:in0></ar:loginCms></soapenv:Body></soapenv:Envelope>`;
    let xml: string;
    try {
      xml = await this.transport.call(wsaaUrl, 'loginCms', envelope);
    } catch (error) {
      if (error instanceof FiscalUnavailableError) throw error;
      throw new FiscalUnavailableError(`WSAA no respondio: ${error instanceof Error ? error.message : String(error)}`);
    }
    const token = extractTag(xml, 'token');
    const sign = extractTag(xml, 'sign');
    if (!token || !sign) {
      throw new FiscalRejectionError('WSAA no devolvio token/sign', [extractFirstMessage(xml)].filter(Boolean) as string[]);
    }
    return { token, sign };
  }

  private parseResult(xml: string, request: FiscalInvoiceRequest): FiscalInvoiceResult {
    const result = extractTag(xml, 'Resultado');
    if (result === 'R') {
      throw new FiscalRejectionError('WSFE rechazo el comprobante', extractMessages(xml));
    }
    const cae = extractTag(xml, 'CAE');
    const caeDueRaw = extractTag(xml, 'CAEFchVto');
    const voucherNumber = Number(extractTag(xml, 'CbteDesde') ?? extractTag(xml, 'CbteHasta'));
    if (!cae || !caeDueRaw || !Number.isInteger(voucherNumber)) {
      // Ni A ni R con mensaje: algo raro en la respuesta. No inventar un comprobante.
      throw new FiscalUnavailableError('WSFE devolvio una respuesta sin CAE ni rechazo');
    }
    const issueDate = normalizeDate(request.issueDate);
    return {
      voucherNumber,
      cae,
      caeDue: `${caeDueRaw.slice(0, 4)}-${caeDueRaw.slice(4, 6)}-${caeDueRaw.slice(6, 8)}`,
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

// -----------------------------------------------------------------------------
// Envelopes y parsing de XML
// -----------------------------------------------------------------------------

function buildFECAESolicitar(
  request: FiscalInvoiceRequest,
  cuit: string,
  token: string,
  sign: string,
): string {
  const typeCode = WSFE_TYPE_CODES[request.type];
  const docTipo = request.receiver.taxId === '0' ? 99 : 80;
  const docNro = request.receiver.taxId === '0' ? 0 : Number(request.receiver.taxId);
  const ivaRows = request.ivaLines
    .map(
      (line) =>
        `<ar:AlicIva><ar:Id>${ivaId(line.rate)}</ar:Id><ar:BaseImp>${(line.netoCents / 100).toFixed(2)}</ar:BaseImp><ar:Importe>${(line.ivaCents / 100).toFixed(2)}</ar:Importe></ar:AlicIva>`,
    )
    .join('');

  const creditNoteBlock = request.creditNoteFor
    ? `<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>${WSFE_TYPE_CODES[request.creditNoteFor.type]}</ar:Tipo><ar:PtoVta>${Number(request.creditNoteFor.pointOfSale)}</ar:PtoVta><ar:Nro>${request.creditNoteFor.number}</ar:Nro></ar:CbteAsoc></ar:CbtesAsoc>`
    : '';

  return (
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1">` +
    `<soapenv:Header/><soapenv:Body>` +
    `<ar:FECAESolicitar>` +
    `<ar:Auth><ar:Token>${escapeXml(token)}</ar:Token><ar:Sign>${escapeXml(sign)}</ar:Sign><ar:Cuit>${cuit}</ar:Cuit></ar:Auth>` +
    `<ar:FeCAEReq>` +
    `<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${Number(request.pointOfSale)}</ar:PtoVta><ar:CbteTipo>${typeCode}</ar:CbteTipo></ar:FeCabReq>` +
    `<ar:FeDetReq>` +
    `<ar:Concepto>${request.concept}</ar:Concepto><ar:DocTipo>${docTipo}</ar:DocTipo><ar:DocNro>${docNro}</ar:DocNro>` +
    `<ar:CbteDesde>0</ar:CbteDesde><ar:CbteHasta>0</ar:CbteHasta>` +
    `<ar:CbteFch>${request.issueDate}</ar:CbteFch>` +
    `<ar:ImpTotal>${(request.totalCents / 100).toFixed(2)}</ar:ImpTotal>` +
    `<ar:ImpTotConc>0.00</ar:ImpTotConc>` +
    `<ar:ImpNeto>${(request.netoCents / 100).toFixed(2)}</ar:ImpNeto>` +
    `<ar:ImpOpEx>0.00</ar:ImpOpEx>` +
    `<ar:ImpIVA>${(request.ivaCents / 100).toFixed(2)}</ar:ImpIVA>` +
    `<ar:ImpTrib>0.00</ar:ImpTrib>` +
    `<ar:MonId>${request.currency === 'ARS' ? 'PES' : request.currency}</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>` +
    creditNoteBlock +
    `<ar:Iva>${ivaRows}</ar:Iva>` +
    `</ar:FeDetReq>` +
    `</ar:FeCAEReq></ar:FECAESolicitar></soapenv:Body></soapenv:Envelope>`
  );
}

/** Extrae el primer <tag>...</tag> del texto XML, sin namespace. */
function extractTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<(?:[^>:]+:)?${tag}>([^<]*)</(?:[^>:]+:)?${tag}>`).exec(xml);
  return match?.[1] !== undefined ? match[1].trim() : null;
}

function extractMessages(xml: string): string[] {
  const messages: string[] = [];
  const regex = /<(?:[^>:]+:)?Msg>([^<]*)<\/(?:[^>:]+:)?Msg>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const msg = match[1];
    if (msg !== undefined) messages.push(msg);
  }
  return messages;
}

function extractFirstMessage(xml: string): string | null {
  return extractMessages(xml)[0] ?? null;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizeDate(issueDate: string): string {
  // YYYYMMDD -> YYYY-MM-DD. Acepta tambien YYYY-MM-DD por las dudas.
  if (issueDate.includes('-')) return issueDate;
  return `${issueDate.slice(0, 4)}-${issueDate.slice(4, 6)}-${issueDate.slice(6, 8)}`;
}

function hashNumber(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 999_999 + 1;
}
