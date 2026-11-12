import { describe, expect, it } from 'vitest';
import { MockPaymentProvider } from './mock';
import { hmacHex } from './crypto';

const provider = new MockPaymentProvider('secret-de-prueba');

describe('MockPaymentProvider', () => {
  it('createIntent es determinístico', async () => {
    const a = await provider.createIntent({
      internalId: 'x',
      amountCents: 100,
      currency: 'ARS',
      description: 'd',
    });
    const b = await provider.createIntent({
      internalId: 'x',
      amountCents: 100,
      currency: 'ARS',
      description: 'd',
    });
    expect(a).toEqual(b);
    expect(a.status).toBe('PENDING');
  });

  it('acepta un webhook con firma válida', () => {
    const body = provider.simulateApprovalBody('mock_pay_abc', 'evt_1', 1200);
    const event = provider.verifyWebhook({ 'x-signature': provider.signWebhookBody(body) }, body);
    expect(event.status).toBe('APPROVED');
    expect(event.externalRef).toBe('mock_pay_abc');
    expect(event.externalId).toBe('evt_1');
  });

  it('rechaza firma inválida', () => {
    const body = provider.simulateApprovalBody('mock_pay_abc', 'evt_1');
    expect(() =>
      provider.verifyWebhook({ 'x-signature': hmacHex('otra-clave', body) }, body),
    ).toThrow(/firma de webhook inválida/i);
  });

  it('rechaza sin firma', () => {
    const body = provider.simulateApprovalBody('mock_pay_abc', 'evt_1');
    expect(() => provider.verifyWebhook({}, body)).toThrow();
  });
});
