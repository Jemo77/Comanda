import { z } from 'zod';
import { PROMOTION_SCOPES, PROMOTION_TYPES } from './types';

/**
 * Esquema de una regla de promocion tal como viaja por la red.
 *
 * La API valida lo que **recibe** con sus propios esquemas
 * (`apps/api/src/modules/promotions`); este es el contrato de
 * **lectura** para los clientes. El POS lo usa para no escribir en su
 * replica una promo que no sabria evaluar, y como el mismo paquete es
 * el que despues la evalua, la forma que valida es exactamente la forma
 * que corre: no hay una regla que valide de un lado y se interprete de
 * otro.
 *
 * Los `default` existen porque el lector no debe fallar por un campo
 * opcional ausente: rellena y sigue. La coherencia (scope/scopeId) se
 * rechaza, porque una regla incoherente no es una regla: es un error de
 * escritura que el servidor deberia haber atrapado.
 */

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

export const promotionRuleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120).default('Promocion'),
    venueId: z.string().nullable().default(null),
    type: z.enum(PROMOTION_TYPES),
    scope: z.enum(PROMOTION_SCOPES),
    scopeId: z.string().nullable().default(null),
    schedule: scheduleSchema.nullable().default(null),
    params: z
      .object({
        bps: z.number().int().min(0).max(10_000).optional(),
        cents: z.number().int().min(0).optional(),
        n: z.number().int().min(1).optional(),
        m: z.number().int().min(0).optional(),
        priceCents: z.number().int().min(0).optional(),
      })
      .default({}),
    priority: z.number().int().min(-100).max(100).default(0),
    stackable: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .superRefine(validateRuleShape);

export type PromotionRuleDto = z.infer<typeof promotionRuleSchema>;

/** Respuesta de `GET /promotions`. */
export const promotionsResponseSchema = z.object({
  rules: z.array(promotionRuleSchema),
});
export type PromotionsResponse = z.infer<typeof promotionsResponseSchema>;

/** PRODUCT/CATEGORY exigen scopeId; ORDER lo prohibe. */
function validateRuleShape(
  v: { scope: string; scopeId: string | null },
  ctx: z.RefinementCtx,
): void {
  if (v.scope === 'ORDER' && v.scopeId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeId'],
      message: 'ORDER no lleva scopeId.',
    });
  }
  if ((v.scope === 'PRODUCT' || v.scope === 'CATEGORY') && !v.scopeId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeId'],
      message: 'Falta el producto o la categoria.',
    });
  }
}
