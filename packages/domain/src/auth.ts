import { z } from 'zod';
import { uuidSchema } from './tenancy';

/**
 * Contratos de autenticacion.
 *
 * Dos caminos, con reglas distintas a proposito:
 *
 *  - email + password: para dueño y Encargado, en un navegador que uno recuerda.
 *  - PIN numerico: para el mozo en la tablet. Solo funciona en dispositivos ya
 *    registrados y aprobados; la combinacion (dispositivo conocido + PIN) es la
 *    que evita que un PIN de 4 digitos sea atacable desde cualquier lado.
 */

export const passwordSchema = z
  .string()
  .min(12, 'La contrasena debe tener al menos 12 caracteres')
  .max(200)
  .refine((v) => /[a-z]/.test(v), 'Falta una letra minuscula')
  .refine((v) => /[A-Z]/.test(v), 'Falta una letra mayuscula')
  .refine((v) => /[0-9]/.test(v), 'Falta un digito');

/**
 * El PIN es de baja entropia por diseno (se tipea 40 veces por turno), asi que se
 * limita a 4-6 digitos pero el hash usa argon2id con pepper.
 */
export const pinSchema = z.string().regex(/^\d{4,6}$/, 'El PIN debe tener entre 4 y 6 digitos');

export const emailSchema = z
  .string()
  .max(254)
  // El trim y el lowercase van ANTES de validar: si se validara primero, un
  // "  dueño@cafe.test " con espacios seria rechazado aunque el usuario lo
  // escriba sin querer.
  .trim()
  .toLowerCase()
  .email('Formato de email invalido');

export const AUTH_METHODS = ['password', 'pin', 'refresh'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const loginWithPasswordSchema = z.object({
  method: z.literal('password'),
  email: emailSchema,
  password: z.string().min(1).max(200),
  deviceId: uuidSchema.optional(),
});
export type LoginWithPassword = z.infer<typeof loginWithPasswordSchema>;

/**
 * El PIN nunca viaja solo: se exige el id del dispositivo registrado. Asi el
 * servidor puede rechazar el intento antes de siquiera tocar el hash.
 */
export const loginWithPinSchema = z.object({
  method: z.literal('pin'),
  deviceId: uuidSchema,
  pin: pinSchema,
});
export type LoginWithPin = z.infer<typeof loginWithPinSchema>;

export const loginSchema = z.discriminatedUnion('method', [
  loginWithPasswordSchema,
  loginWithPinSchema,
]);
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(20).max(500),
});

/** Claims del access token. Corto a proposito: los permisos NO van aqui. */
export const accessTokenClaimsSchema = z.object({
  sub: uuidSchema,
  org: uuidSchema,
  /** Venue activa de la sesion; un mismo usuario opera en varios locales. */
  venue: uuidSchema,
  /** Rol asumida en esta sesion, si el usuario tiene varias. */
  role: z.string().min(1).optional(),
  jti: z.string().min(1),
  iss: z.string(),
  aud: z.string(),
  iat: z.number(),
  exp: z.number(),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export const sessionUserSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  email: z.string(),
  orgId: uuidSchema,
  venueId: uuidSchema,
  roleKeys: z.array(z.string()),
  permissions: z.array(z.string()),
  constraints: z.record(z.unknown()),
  deviceId: uuidSchema.nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(),
  user: sessionUserSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Verificacion de PIN de supervisor: authorize contra una sesion distinta. */
export const supervisorVerifySchema = z.object({
  pin: pinSchema,
  action: z.string().min(1),
  reason: z.string().min(3).max(300),
});
export type SupervisorVerify = z.infer<typeof supervisorVerifySchema>;
