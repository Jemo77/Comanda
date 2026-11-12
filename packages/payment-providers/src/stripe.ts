import type {
  PaymentProvider,
  PaymentCredentials,
  PaymentIntentRequest,
  PaymentIntentResult,
  PaymentWebhookEvent,
} from './types';
import { WebhookSignatureError } from './types';
import { hmacHex, secureEqual } from './crypto';

/** Stripe real, con HTTP inyectable igual que el resto de los adaptadores. */
export class StripeProvider implements PaymentProvider {
  readonly key = 'stripe';

  constructor(
    private readonly credentials: PaymentCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult> {
    const body = new URLSearchParams({
      amount: String(request.amountCents),
      currency: request.currency.toLowerCase(),
      description: request.description,
      'metadata[internal_id]': request.internalId,
    });
    const response = await this.fetchImpl('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`Stripe createIntent falló con ${response.status}`);
    }
    const payload = (await response.json()) as { id?: string; client_secret?: string };
    if (!payload.id || !payload.client_secret) {
      throw new Error('Stripe devolvió un PaymentIntent incompleto');
    }
    return { externalRef: payload.id, clientToken: payload.client_secret, status: 'PENDING' };
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): PaymentWebhookEvent {
    // Firma Stripe: header `Stripe-Signature` con "t=...,v1=..." sobre
    // "{t}.{payload}".
    const header = headers['stripe-signature'] ?? '';
    const parts = Object.fromEntries(
      header.split(',').map((kv) => {
        const idx = kv.indexOf('=');
        return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()] as [string, string];
      }),
    );
    const t = parts['t'];
    const v1 = parts['v1'];
    if (!t || !v1) {
      throw new WebhookSignatureError('Stripe: header stripe-signature malformado.');
    }
    const expected = hmacHex(this.credentials.webhookSecret, `${t}.${rawBody}`);
    if (!secureEqual(v1, expected)) {
      throw new WebhookSignatureError('Stripe: firma inválida.');
    }
    const parsed = JSON.parse(rawBody) as {
      id?: string;
      type?: string;
      data?: { object?: { id?: string; amount?: number; status?: string } };
    };
    const object = parsed.data?.object;
    if (!parsed.id || !object?.id) {
      throw new WebhookSignatureError('Stripe: webhook sin id.');
    }
    const status: PaymentWebhookEvent['status'] =
      parsed.type === 'payment_intent.succeeded'
        ? 'APPROVED'
        : parsed.type === 'payment_intent.payment_failed'
          ? 'FAILED'
          : 'CANCELLED';
    return {
      externalId: parsed.id,
      status,
      externalRef: object.id,
      amountCents: object.amount,
      raw: parsed,
    };
  }
}
