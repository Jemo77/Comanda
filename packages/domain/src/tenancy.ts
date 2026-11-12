import { z } from 'zod';

/**
 * Esquemas de tenancy compartidos. Los mismos objetos validan el input en el borde
 * de la API (Zod) y se usan como contratos en los clientes.
 */

export const PLANS = ['starter', 'pro', 'enterprise'] as const;
export const Plan = z.enum(PLANS);
export type Plan = z.infer<typeof Plan>;

export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'El codigo de moneda debe ser ISO 4217 en mayusculas');

export const countrySchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'El codigo de pais debe ser ISO 3166-1 alpha-2 en mayusculas');

export const timeZoneSchema = z.string().min(1).max(64);

export const uuidSchema = z.string().uuid();

export const organizationSchema = z.object({
  id: uuidSchema,
  name: z.string().min(2).max(120),
  plan: Plan,
  country: countrySchema,
  currency: currencySchema,
  timezone: timeZoneSchema,
  createdAt: z.string().datetime(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const organizationInputSchema = z.object({
  name: z.string().min(2, 'El nombre es obligatorio').max(120),
  plan: Plan.optional(),
  country: countrySchema.optional(),
  currency: currencySchema.optional(),
  timezone: timeZoneSchema.optional(),
});
export type OrganizationInput = z.infer<typeof organizationInputSchema>;

export const VENUE_KINDS = ['bar', 'cafe', 'restaurante', 'kiosco', 'confiteria'] as const;
export const VenueKind = z.enum(VENUE_KINDS);

export const venueSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  name: z.string().min(2).max(120),
  kind: VenueKind,
  address: z.string().max(300).nullable(),
  timezone: timeZoneSchema,
  currency: currencySchema,
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
});
export type Venue = z.infer<typeof venueSchema>;

export const venueInputSchema = z.object({
  name: z.string().min(2).max(120),
  kind: VenueKind.default('bar'),
  address: z.string().max(300).nullable().default(null),
  timezone: timeZoneSchema.default('America/Argentina/Buenos_Aires'),
  currency: currencySchema.default('ARS'),
  isActive: z.boolean().default(true),
});
export type VenueInput = z.infer<typeof venueInputSchema>;

export const DEVICE_KINDS = ['tablet', 'pos', 'kiosk', 'printer', 'kds', 'unknown'] as const;
export const DeviceKind = z.enum(DEVICE_KINDS);

export const DEVICE_STATUSES = ['pending', 'active', 'revoked'] as const;
export const DeviceStatus = z.enum(DEVICE_STATUSES);

/**
 * `status` separado de `revokedAt`: una consulta de "dispositivos revocados" con
 * indice sobre `revoked_at IS NOT NULL` no usa indice si el filtro es
 * `status = 'revoked'` sobre una columna derivable.
 */
export const deviceSchema = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  venueId: uuidSchema,
  name: z.string().min(1).max(80),
  kind: DeviceKind,
  status: DeviceStatus,
  /** Huella estable del hardware, permite re-registrar el mismo dispositivo. */
  fingerprint: z.string().min(8).max(255),
  lastSeenAt: z.string().datetime().nullable(),
  approvedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Device = z.infer<typeof deviceSchema>;

export const deviceRegistrationSchema = z.object({
  venueId: uuidSchema,
  name: z.string().min(1).max(80),
  kind: DeviceKind.default('tablet'),
  fingerprint: z.string().min(8).max(255),
});
export type DeviceRegistration = z.infer<typeof deviceRegistrationSchema>;

/** Resultado de pedir un PIN de supervisor para una accion sensible. */
export const supervisorPinSchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, 'El PIN debe tener entre 4 y 8 digitos'),
});
export type SupervisorPin = z.infer<typeof supervisorPinSchema>;
