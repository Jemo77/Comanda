import { z } from 'zod';
import { uuidSchema } from './tenancy';

/**
 * Auditoria: catalogo de acciones y forma del registro.
 *
 * La tabla es append-only a nivel de base de datos (trigger que aborta UPDATE y
 * DELETE mas revoked grants), asi que el codigo no necesita defenderse: solo
 * escribe. Lo que si controla es la taxonomia, para que los reportes puedan
 * filtrar "todo lo que se anularon" sin depender del texto libre.
 */

export const AUDIT_ACTIONS = [
  // Sesion
  'auth.login',
  'auth.login.failed',
  'auth.logout',
  'auth.logout.all',
  'auth.token.refreshed',
  'auth.token.reuse_detected',
  'auth.pin.changed',
  'auth.pin.reset',
  'auth.password.changed',
  'auth.supervisor.override',

  // Tenancy
  'org.created',
  'org.updated',
  'venue.created',
  'venue.updated',
  'device.registered',
  'device.approved',
  'device.revoked',

  // Equipo
  'user.created',
  'user.updated',
  'user.deactivated',
  'role.created',
  'role.updated',

  // Catalogo y precios
  'category.created',
  'category.updated',
  'product.created',
  'product.updated',
  'product.price_changed',
  'product.availability_changed',
  'modifier.created',
  'modifier.updated',

  // Promociones
  'promotion.created',
  'promotion.updated',

  // Salon
  'floor.created',
  'floor.updated',
  'table.created',
  'table.updated',

  // Comandas
  'order.opened',
  'order.item_added',
  'order.item_updated',
  'order.item_voided',
  'order.transferred',
  'order.merged',
  'order.closed',

  // Cocina
  'kitchen.ticket_status_changed',

  // Cobro
  'bill.discount_applied',
  'bill.split',
  'bill.paid',
  'bill.reprinted',

  // Caja
  'shift.opened',
  'shift.cash_movement',
  'shift.closed',

  // Inventario
  'stock.adjusted',
  'stock.waste_registered',
  'stock.counted',
  'ingredient.created',
  'ingredient.updated',
  'recipe.updated',
  'purchase_order.created',
  'purchase_order.closed',
  'goods_received',

  // Cliente
  'customer.created',
  'loyalty.redeemed',

  // Fichaje
  'time_entry.clocked_in',
  'time_entry.clocked_out',

  // Fiscal y finanzas
  'invoice.issued',
  'invoice.failed',
  'fiscal.configured',

  // Integraciones
  'integration.configured',
  'integration.webhook_received',

  // Plataforma
  'platform.seed',
] as const;

export const AuditAction = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditAction>;

/**
 * Acciones que exigen motivo escrito. Sin motivo no se puede ejecutar la accion:
 * el motivo va en el registro, no en un log aparte, para que no se pueda anular
 * sin dejar rastro de por que.
 */
export const AUDIT_ACTIONS_REQUIRING_REASON: ReadonlySet<string> = new Set<string>([
  'auth.pin.reset',
  'auth.password.changed',
  'device.revoked',
  'user.deactivated',
  'product.price_changed',
  'order.item_voided',
  'bill.discount_applied',
  'bill.reprinted',
  'shift.cash_movement',
  'stock.adjusted',
  'stock.waste_registered',
  'auth.supervisor.override',
]);

/** Acciones que disparan override con PIN de supervisor. */
export const SENSITIVE_ACTIONS: ReadonlySet<string> = new Set<string>([
  'order.item_voided',
  'bill.discount_applied',
  'bill.reprinted',
  'product.price_changed',
  'stock.adjusted',
  'shift.cash_movement',
  'auth.pin.reset',
]);

export function requiresReason(action: string): boolean {
  return AUDIT_ACTIONS_REQUIRING_REASON.has(action);
}

export function isSensitive(action: string): boolean {
  return SENSITIVE_ACTIONS.has(action);
}

export const auditEntrySchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  venueId: uuidSchema.nullable(),
  actorId: uuidSchema.nullable(),
  actorName: z.string().nullable(),
  deviceId: uuidSchema.nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  action: z.string().min(1),
  entity: z.string().min(1),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditEntryInputSchema = z.object({
  action: z.string().min(1),
  entity: z.string().min(1),
  entityId: z.string().nullable().default(null),
  before: z.unknown().nullable().default(null),
  after: z.unknown().nullable().default(null),
  reason: z.string().max(300).nullable().default(null),
  ip: z.string().nullable().default(null),
  userAgent: z.string().max(500).nullable().default(null),
});
export type AuditEntryInput = z.infer<typeof auditEntryInputSchema>;

/** Filtros del endpoint de lectura de auditoria. */
export const auditQuerySchema = z.object({
  action: z.string().optional(),
  entity: z.string().optional(),
  entityId: z.string().optional(),
  actorId: uuidSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
