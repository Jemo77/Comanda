import { describe, expect, it } from 'vitest';
import { promotionRuleSchema, promotionsResponseSchema } from './schema';

/** Regla tal como la devuelve `GET /promotions`. */
const rule = {
  id: 'rule-1',
  name: 'Happy Hour',
  venueId: null,
  type: 'PERCENT',
  scope: 'PRODUCT',
  scopeId: '11111111-1111-4111-8111-111111111111',
  schedule: null,
  params: { bps: 1000 },
  priority: 0,
  stackable: false,
  active: true,
};

describe('promotionRuleSchema', () => {
  it('valida una regla completa tal como la devuelve la API', () => {
    const parsed = promotionRuleSchema.parse(rule);

    expect(parsed.id).toBe('rule-1');
    expect(parsed.params.bps).toBe(1000);
    expect(parsed.scopeId).toBe(rule.scopeId);
  });

  it('rellena los defaults para una regla minima', () => {
    const parsed = promotionRuleSchema.parse({
      id: 'rule-2',
      type: 'BOGO',
      scope: 'ORDER',
    });

    expect(parsed.name).toBe('Promocion');
    expect(parsed.venueId).toBeNull();
    expect(parsed.scopeId).toBeNull();
    expect(parsed.schedule).toBeNull();
    expect(parsed.params).toEqual({});
    expect(parsed.priority).toBe(0);
    expect(parsed.stackable).toBe(false);
    expect(parsed.active).toBe(true);
  });

  it('rechaza ORDER con scopeId y PRODUCT sin scopeId', () => {
    // La coherencia scope/scopeId no es un detalle de forma: una
    // regla PRODUCT sin scopeId nunca aplicaria, y una ORDER con
    // scopeId es un error de escritura que hay que ver, no ignorar.
    expect(
      promotionRuleSchema.safeParse({ ...rule, scope: 'ORDER', scopeId: rule.scopeId })
        .success,
    ).toBe(false);
    expect(
      promotionRuleSchema.safeParse({ ...rule, scopeId: null }).success,
    ).toBe(false);
  });

  it('rechaza un tipo inexistente y un horario invalido', () => {
    expect(
      promotionRuleSchema.safeParse({ ...rule, type: 'DISCOUNT' }).success,
    ).toBe(false);
    expect(
      promotionRuleSchema.safeParse({
        ...rule,
        schedule: {
          daysOfWeek: [1],
          from: '25:00',
          to: '26:00',
          timezone: 'America/Argentina/Buenos_Aires',
        },
      }).success,
    ).toBe(false);
  });

  it('valida la respuesta de GET /promotions', () => {
    const parsed = promotionsResponseSchema.parse({ rules: [rule] });

    expect(parsed.rules).toHaveLength(1);
  });
});
