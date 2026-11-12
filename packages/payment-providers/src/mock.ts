import { createHash } from 'node:crypto';
import type {
  PaymentProvider,
  PaymentIntentRequest,
  PaymentIntentResult,
  PaymentWebhookEvent,
} from './types';
import { WebhookSignatureError } from './types';
import { hmacHex, secureEqual } from './crypto';

/**
 * Provider falso, idéntico en forma al real.
 *
 * Es el que corre en desarrollo y en los tests: `createIntent` devuelve un
 * externo derivado del id interno, y la "aprobación" llega por un webhook con
 * firma HMAC válida que el propio test construye con `signWebhookBody`. Sin
 * azar: dos corridas dan el mismo resultado.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly key = 'mock';

  constructor(private readonly webhookSecret: string = 'comanda-mock-webhook-secret') {}

  createIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult> {
    const externalRef = `mock_pay_${createHash('sha256').update(request.internalId).digest('hex').slice(0, 16)}`;
    return Promise.resolve({
      externalRef,
      clientToken: `mock_client_${externalRef}`,
      status: 'PENDING' as const,
    });
  }

  /** Lo usa el ambiente de demo para "pagar" sin depender de una pasarela. */
  simulateApprovalBody(externalRef: string, externalId: string, amountCents?: number): string {
    return JSON.stringify({ type: 'payment.approved', id: externalId, externalRef, amountCents });
  }

  signWebhookBody(rawBody: string): string {
    return hmacHex(this.webhookSecret, rawBody);
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): PaymentWebhookEvent {
    const signature = headers['x-signature'];
    const expected = this.signWebhookBody(rawBody);
    if (!signature || !secureEqual(signature, expected)) {
      throw new WebhookSignatureError('Firma de webhook inválida.');
    }
    const parsed = JSON.parse(rawBody) as {
      type?: string;
      id?: string;
      externalRef?: string;
      amountCents?: number;
    };
    if (!parsed.id || !parsed.externalRef) {
      throw new WebhookSignatureError('Webhook sin id ni externalRef.');
    }
    const status: PaymentWebhookEvent['status'] =
      parsed.type === 'payment.approved'
        ? 'APPROVED'
        : parsed.type === 'payment.failed'
          ? 'FAILED'
          : 'CANCELLED';
    return {
      externalId: parsed.id,
      status,
      externalRef: parsed.externalRef,
      amountCents: parsed.amountCents,
      raw: parsed,
    };
  }
}
