import type {
  PaymentProvider,
  PaymentCredentials,
  PaymentIntentRequest,
  PaymentIntentResult,
  PaymentWebhookEvent,
} from './types';
import { WebhookSignatureError } from './types';
import { hmacHex, secureEqual } from './crypto';

/**
 * Mercado Pago real, con HTTP inyectable: los tests prueban el protocolo
 * (qué endpoint, qué headers, qué firma) sin tocar el homologador.
 */
export class MercadoPagoProvider implements PaymentProvider {
  readonly key = 'mercadopago';

  constructor(
    private readonly credentials: PaymentCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult> {
    const response = await this.fetchImpl('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        external_reference: request.internalId,
        currency_id: request.currency,
        items: [
          {
            title: request.description,
            quantity: 1,
            unit_price: request.amountCents / 100,
            currency_id: request.currency,
          },
        ],
        back_urls: request.successUrl
          ? { success: request.successUrl, failure: request.failureUrl ?? request.successUrl }
          : undefined,
      }),
    });
    if (!response.ok) {
      throw new Error(`MercadoPago createIntent falló con ${response.status}`);
    }
    const body = (await response.json()) as { id?: string; init_point?: string };
    if (!body.id || !body.init_point) {
      throw new Error('MercadoPago devolvió una preferencia incompleta');
    }
    return {
      externalRef: body.id,
      clientToken: body.id,
      redirectUrl: body.init_point,
      status: 'PENDING',
    };
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): PaymentWebhookEvent {
    // Firma MP: header `x-signature` con "ts=...,v1=...", calculada sobre
    // "id:{dataId};request-id:{x-request-id};ts:{ts};".
    const signatureHeader = headers['x-signature'] ?? '';
    const parts = Object.fromEntries(
      signatureHeader
        .split(',')
        .map((kv) => kv.split('=').map((s) => s.trim()) as [string, string]),
    );
    const ts = parts['ts'];
    const v1 = parts['v1'];
    if (!ts || !v1) {
      throw new WebhookSignatureError('MercadoPago: header x-signature malformado.');
    }
    let parsed: { data?: { id?: string | number }; type?: string; action?: string };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      throw new WebhookSignatureError('MercadoPago: webhook no es JSON.');
    }
    const dataId = parsed.data?.id;
    if (dataId === undefined || dataId === null) {
      throw new WebhookSignatureError('MercadoPago: webhook sin data.id.');
    }
    const requestId = headers['x-request-id'] ?? '';
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const expected = hmacHex(this.credentials.webhookSecret, manifest);
    if (!secureEqual(v1, expected)) {
      throw new WebhookSignatureError('MercadoPago: firma inválida.');
    }
    const approved =
      parsed.type === 'payment' &&
      (parsed.action === 'payment.created' || parsed.action === 'payment.updated');
    return {
      externalId: `${parsed.type ?? 'unknown'}:${String(dataId)}`,
      status: approved ? 'APPROVED' : 'CANCELLED',
      externalRef: String(dataId),
      raw: parsed,
    };
  }
}
