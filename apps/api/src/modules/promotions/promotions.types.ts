import { z } from 'zod';
import { PROMOTION_SCOPES, PROMOTION_TYPES } from '@comanda/pricing-engine';

/** HH:mm en hora local del local. */
const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Se esperaba HH:mm (00:00 a 23:59)');

export const scheduleSchema = z.object({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
  from: hhmm,
  to: hhmm,
  timezone: z.string().min(1).max(64),
  startsOn: z.string().datetime({ offset: true }).optional(),
  endsOn: z.string().datetime({ offset: true }).optional(),
});

export const paramsSchema = z.object({
  bps: z.number().int().min(0).max(10_000).optional(),
  cents: z.number().int().min(0).optional(),
  n: z.number().int().min(1).optional(),
  m: z.number().int().min(0).optional(),
  priceCents: z.number().int().min(0).optional(),
});

const baseRule = {
  name: z.string().min(1).max(120),
  type: z.enum(PROMOTION_TYPES),
  scope: z.enum(PROMOTION_SCOPES),
  scopeId: z.string().uuid().nullable().optional(),
  venueId: z.string().uuid().nullable().optional(),
  schedule: scheduleSchema.nullable().optional(),
  params: paramsSchema.default({}),
  priority: z.number().int().min(-100).max(100).default(0),
  stackable: z.boolean().default(false),
  active: z.boolean().default(true),
};

export const createRuleSchema = z
  .object(baseRule)
  .superRefine(validateRuleShape)
  .superRefine(validateParamsForType);

export const updateRuleSchema = z
  .object({
    name: baseRule.name.optional(),
    type: baseRule.type.optional(),
    scope: baseRule.scope.optional(),
    scopeId: baseRule.scopeId,
    venueId: baseRule.venueId,
    schedule: baseRule.schedule,
    params: paramsSchema.optional(),
    priority: baseRule.priority.optional(),
    stackable: baseRule.stackable.optional(),
    active: baseRule.active.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'No hay ningun campo para actualizar.',
  });

/** PRODUCT/CATEGORY exigen scopeId; ORDER lo prohibe. */
function validateRuleShape(
  v: { type?: string; scope?: string; scopeId?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (v.scope === 'ORDER' && v.scopeId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeId'], message: 'ORDER no lleva scopeId.' });
  }
  if ((v.scope === 'PRODUCT' || v.scope === 'CATEGORY') && !v.scopeId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeId'], message: 'Falta el producto o la categoria.' });
  }
}

/** Cada tipo exige sus parametros: un PERCENT sin bps no descuenta nada, en silencio. */
function validateParamsForType(
  v: { type?: string; params?: Record<string, number | undefined> },
  ctx: z.RefinementCtx,
): void {
  const p = v.params ?? {};
  const need = (...keys: string[]) => {
    for (const k of keys) {
      if (p[k] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['params', k], message: `Falta params.${k} para ${v.type}` });
      }
    }
  };
  switch (v.type) {
    case 'PERCENT':
      need('bps');
      break;
    case 'FIXED':
      need('cents');
      break;
    case 'PRICE_OVERRIDE':
      need('priceCents');
      break;
    case 'NXM':
      need('n', 'm');
      break;
    case 'BOGO':
      break;
  }
}

export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
