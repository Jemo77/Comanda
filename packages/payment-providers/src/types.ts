/**
 * Contrato del adaptador de pagos.
 *
 * Un `PaymentProvider` crea un intento de cobro y verifica webhooks. Nunca ve
 * datos de tarjeta: el cliente los ingresa en la pantalla del proveedor (SDK
 * tokenizado o redirect) y a nosotros nos llega solo el resultado firmado.
 *
 * Dinero siempre entero + moneda. Nunca float (PLAN §1).
 */

export interface PaymentIntentRequest {
  /** Id interno, se usa como referencia del comercio. */
  internalId: string;
  amountCents: number;
  currency: string;
  description: string;
  /** URL a la que vuelve el cliente al terminar (redirect providers). */
  successUrl?: string;
  failureUrl?: string;
  customerPhone?: string;
}

export interface PaymentIntentResult {
  /** Id del intento en el proveedor. */
  externalRef: string;
  /** Lo que el navegador necesita para completar el pago (token del SDK o URL). */
  clientToken: string;
  redirectUrl?: string;
  /** El mock no cobra solo: el evento llega firmado por webhook. */
  status: 'PENDING' | 'APPROVED' | 'FAILED';
}

export type PaymentWebhookStatus = 'APPROVED' | 'FAILED' | 'CANCELLED';

export interface PaymentWebhookEvent {
  /** Id UNICO del evento en el proveedor (no del pago): la idempotencia. */
  externalId: string;
  status: PaymentWebhookStatus;
  /** Id del intento al que pertenece el evento. */
  externalRef: string;
  amountCents?: number;
  raw: unknown;
}

/** Error terminal del proveedor: la tarjeta fue rechazada, no se reintenta. */
export class PaymentRejectedError extends Error {
  readonly code = 'PAYMENT_REJECTED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PaymentRejectedError';
  }
}

/** Falla transitoria (red, 5xx): se puede reintentar. */
export class PaymentUnavailableError extends Error {
  readonly code = 'PAYMENT_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PaymentUnavailableError';
  }
}

/** Firma de webhook invalida: se rechaza y se audita. */
export class WebhookSignatureError extends Error {
  readonly code = 'WEBHOOK_BAD_SIGNATURE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export interface PaymentProvider {
  readonly key: string;
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult>;
  /**
   * Verifica la firma del webhook y devuelve el evento parseado.
   * `rawBody` es el cuerpo CRUDO (sin parsear): la firma se calcula sobre esos
   * bytes exactos, parsear y re-serializar cambia el payload y rompe la firma.
   */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): PaymentWebhookEvent;
}

/** Credenciales por local. En mock solo el secreto de firma. */
export interface PaymentCredentials {
  accessToken: string;
  /** Secreto HMAC para verificar webhooks. */
  webhookSecret: string;
  environment: 'homo' | 'prod';
}
