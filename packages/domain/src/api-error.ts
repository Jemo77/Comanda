import { z } from 'zod';

/**
 * Errores en RFC 7807 ("application/problem+json").
 *
 * El motivo de usar un formato unico: el POS es una PWA que cachea respuestas y
 * un cliente necesita distinguir "no tenes permiso" de "el servidor se cayo" para
 * decidir si reintenta, si pide PIN de supervisor o si muestra un error de red.
 * Un `{ message: "error" }` no alcanza para eso.
 */

export const PROBLEM_TYPES = {
  validation: 'https://comanda.app/problems/validation-error',
  unauthorized: 'https://comanda.app/problems/unauthorized',
  forbidden: 'https://comanda.app/problems/forbidden',
  notFound: 'https://comanda.app/problems/not-found',
  conflict: 'https://comanda.app/problems/conflict',
  rateLimited: 'https://comanda.app/problems/rate-limited',
  invalidCredentials: 'https://comanda.app/problems/invalid-credentials',
  deviceNotApproved: 'https://comanda.app/problems/device-not-approved',
  supervisorRequired: 'https://comanda.app/problems/supervisor-required',
  internal: 'https://comanda.app/problems/internal',
} as const;

export type ProblemType = (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES];

/** Codigos de error estables: el texto puede cambiar, el codigo no. */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  FORBIDDEN: 'FORBIDDEN',
  SUPERVISOR_REQUIRED: 'SUPERVISOR_REQUIRED',
  DEVICE_NOT_APPROVED: 'DEVICE_NOT_APPROVED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string().optional(),
  code: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

const TITLES: Record<string, string> = {
  [PROBLEM_TYPES.validation]: 'Datos invalidos',
  [PROBLEM_TYPES.unauthorized]: 'Sesion vencida',
  [PROBLEM_TYPES.forbidden]: 'Sin permiso',
  [PROBLEM_TYPES.notFound]: 'No encontrado',
  [PROBLEM_TYPES.conflict]: 'Conflicto',
  [PROBLEM_TYPES.rateLimited]: 'Demasiados intentos',
  [PROBLEM_TYPES.invalidCredentials]: 'Credenciales invalidas',
  [PROBLEM_TYPES.deviceNotApproved]: 'Dispositivo no aprobado',
  [PROBLEM_TYPES.supervisorRequired]: 'Requiere autorizacion',
  [PROBLEM_TYPES.internal]: 'Error interno',
};

export interface ProblemOptions {
  status: number;
  code: ErrorCode;
  detail: string;
  type?: string;
  errors?: Array<{ path: string; message: string }>;
  instance?: string;
}

/**
 * Construye un problem+json. `detail` va escrito para la persona que lo lee en el
 * mostrador ("Este dispositivo aun no fue aprobado por el dueno"), nunca con nombres
 * de codigo internos.
 */
export function problemDetails(options: ProblemOptions): ProblemDetails {
  const type = options.type ?? inferType(options.code);
  return {
    type,
    title: TITLES[type] ?? 'Error',
    status: options.status,
    detail: options.detail,
    code: options.code,
    ...(options.errors && options.errors.length > 0 ? { errors: options.errors } : {}),
    ...(options.instance ? { instance: options.instance } : {}),
  };
}

function inferType(code: ErrorCode): string {
  switch (code) {
    case 'VALIDATION_FAILED':
      return PROBLEM_TYPES.validation;
    case 'UNAUTHENTICATED':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_REUSE_DETECTED':
      return PROBLEM_TYPES.unauthorized;
    case 'INVALID_CREDENTIALS':
      return PROBLEM_TYPES.invalidCredentials;
    case 'FORBIDDEN':
      return PROBLEM_TYPES.forbidden;
    case 'SUPERVISOR_REQUIRED':
      return PROBLEM_TYPES.supervisorRequired;
    case 'DEVICE_NOT_APPROVED':
    case 'DEVICE_REVOKED':
      return PROBLEM_TYPES.deviceNotApproved;
    case 'NOT_FOUND':
      return PROBLEM_TYPES.notFound;
    case 'CONFLICT':
    case 'CONSTRAINT_VIOLATION':
      return PROBLEM_TYPES.conflict;
    case 'RATE_LIMITED':
      return PROBLEM_TYPES.rateLimited;
    default:
      return PROBLEM_TYPES.internal;
  }
}
