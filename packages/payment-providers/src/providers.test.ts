import { describe, expect, it, vi } from 'vitest';
import { MercadoPagoProvider } from './mercadopago';
import { StripeProvider } from './stripe';
import { hmacHex } from './crypto';

const creds = { accessToken: 'tok', webhookSecret: 'whsec', environment: 'homo' as const };

describe('MercadoPagoProvider.verifyWebhook', () => {
  const provider = new MercadoPagoProvider(creds);
  const dataId = '12345';
  const ts = '1700000000';
  const requestId = 'req-1';
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const v1 = hmacHex(creds.webhookSecret, manifest);
  const body = JSON.stringify({ type: 'payment', action: 'payment.updated', data: { id: dataId } });

  it('firma válida aprueba', () => {
    const event = provider.verifyWebhook(
      { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
      body,
    );
    expect(event.status).toBe('APPROVED');
    expect(event.externalRef).toBe(dataId);
  });

  it('firma inválida se rechaza', () => {
    expect(() =>
      provider.verifyWebhook(
        { 'x-signature': `ts=${ts},v1=${v1.replace(/.$/, '0')}`, 'x-request-id': requestId },
        body,
      ),
    ).toThrow(/firma inválida/i);
  });
});

describe('MercadoPagoProvider.createIntent', () => {
  it('arma la preferencia correcta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'pref_1', init_point: 'https://mp/checkout' }), {
        status: 200,
      }),
    );
    const provider = new MercadoPagoProvider(creds, fetchImpl);
    const result = await provider.createIntent({
      internalId: 'order-1',
      amountCents: 150000,
      currency: 'ARS',
      description: 'Mesa 4',
    });
    expect(result).toEqual({
      externalRef: 'pref_1',
      clientToken: 'pref_1',
      redirectUrl: 'https://mp/checkout',
      status: 'PENDING',
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).toContain('order-1');
  });
});

describe('StripeProvider.verifyWebhook', () => {
  const provider = new StripeProvider(creds);
  const t = '1700000000';
  const body = JSON.stringify({
    id: 'evt_1',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_1', amount: 2500 } },
  });
  const v1 = hmacHex(creds.webhookSecret, `${t}.${body}`);

  it('firma válida aprueba', () => {
    const event = provider.verifyWebhook({ 'stripe-signature': `t=${t},v1=${v1}` }, body);
    expect(event.status).toBe('APPROVED');
    expect(event.externalRef).toBe('pi_1');
    expect(event.amountCents).toBe(2500);
  });

  it('firma inválida se rechaza', () => {
    expect(() =>
      provider.verifyWebhook({ 'stripe-signature': `t=${t},v1=${'0'.repeat(v1.length)}` }, body),
    ).toThrow();
  });
});

describe('StripeProvider.createIntent', () => {
  it('arma el payment_intent correcto', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'pi_9', client_secret: 'secret_9' }), { status: 200 }),
      );
    const provider = new StripeProvider(creds, fetchImpl);
    const result = await provider.createIntent({
      internalId: 'order-1',
      amountCents: 100,
      currency: 'ARS',
      description: 'x',
    });
    expect(result).toEqual({ externalRef: 'pi_9', clientToken: 'secret_9', status: 'PENDING' });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.body?.toString()).toContain('amount=100');
  });
});
