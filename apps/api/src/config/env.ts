import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Configuracion por entorno, validada al arrancar.
 *
 * Falla temprano y con un mensaje claro: un `JWT_ACCESS_SECRET` ausente tiene que
 * romper el deploy, no aparecer como un 500 en el primer login de un local.
 */

const Duration = z.string().regex(/^\d+[smhd]$/, 'Se espera un valor tipo "15m", "7d", "30s"');

function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`Duracion invalida: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const seconds = { s: 1, m: 60, h: 3600, d: 86_400 }[unit];
  return amount * seconds;
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),
  DATABASE_MIGRATIONS_URL: z.string().min(1).optional(),

  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres'),
  JWT_ISSUER: z.string().default('comanda'),
  JWT_AUDIENCE: z.string().default('comanda-api'),
  JWT_ACCESS_TTL: Duration.default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  PIN_PEPPER: z.string().min(16, 'PIN_PEPPER debe tener al menos 16 caracteres'),

  ARGON2_MEMORY_KB: z.coerce.number().int().min(8_192).max(1_048_576).default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).max(10).default(3),
  /**
   * El PIN tiene mucho menos espacio de busqueda que una contrasena (10^4 a 10^6
   * combinaciones frente a 2^128), asi que usa el doble de esfuerzo. Ademas lleva
   * pepper: sin el, un dump de la base alcanza para un ataque trivial por fuerza
   * bruta offline.
   */
  ARGON2_PIN_MEMORY_KB: z.coerce.number().int().min(8_192).max(1_048_576).default(131_072),
  ARGON2_PIN_TIME_COST: z.coerce.number().int().min(1).max(10).default(5),

  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default('comanda'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),

  SEED_OWNER_PASSWORD: z.string().default('Comanda1234!'),

  /**
   * Firma de los tokens QR de mesa. En desarrollo vale el default; en
   * produccion hay que setearlo (rotar las mesas reimprime el QR y firma
   * con el nuevo). El default contiene "dev-only" para que el chequeo de
   * produccion lo rechace: un QR firmado con un secreto de ejemplo es una
   * mesa abierta.
   */
  QR_TOKEN_SECRET: z.string().min(16).default('dev-only-qr-token-secret-cambiar-0000'),
  /**
   * Secreto HMAC del webhook del proveedor de pagos. Distinto del
   * QR_TOKEN_SECRET: uno autentica al cliente (QR impreso), el otro al
   * proveedor (servidor a servidor).
   */
  PAYMENT_WEBHOOK_SECRET: z.string().min(16).default('dev-only-webhook-secret-cambiar-00'),

  /**
   * Cada cuanto el worker intenta las facturas pendientes. En tests se pone en
   * "off": los tests llaman `processDueInvoices` a mano. Mantenerlo configurable
   * evita dormir el pipeline mientras corre la suite.
   */
  FISCAL_WORKER_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  FISCAL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
});

export type AppEnv = z.infer<typeof schema> & {
  /** `JWT_ACCESS_TTL` convertido a segundos. */
  accessTokenTtlSeconds: number;
  /** Refresh tokens en dias, ya derivado a milisegundos. */
  refreshTokenTtlMs: number;
};

function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuracion invalida:\n${details}`);
  }

  // Los secretos por defecto que vienen en `.env.example` sirven para desarrollo y
  // no pueden sobrevivir a un despliegue real.
  if (parsed.data.NODE_ENV === 'production') {
    const suspicious = [
      ['JWT_ACCESS_SECRET', parsed.data.JWT_ACCESS_SECRET],
      ['PIN_PEPPER', parsed.data.PIN_PEPPER],
      ['QR_TOKEN_SECRET', parsed.data.QR_TOKEN_SECRET],
      ['PAYMENT_WEBHOOK_SECRET', parsed.data.PAYMENT_WEBHOOK_SECRET],
    ] as const;
    for (const [key, value] of suspicious) {
      if (value.includes('dev-only')) {
        throw new Error(`${key} sigue con el valor de ejemplo de .env.example`);
      }
    }
  }

  return {
    ...parsed.data,
    accessTokenTtlSeconds: parseDuration(parsed.data.JWT_ACCESS_TTL),
    refreshTokenTtlMs: parsed.data.JWT_REFRESH_TTL_DAYS * 86_400_000,
  };
}

/**
 * Carga el `.env` de la raiz del repositorio.
 *
 * El README dice `cp .env.example .env`, asi que ese archivo tiene que leerse de
 * verdad. `ConfigModule` lo hace para Nest, pero `main.ts`, las migraciones y el
 * seed llaman a `loadEnv()` **antes** de que arranque Nest, asi que necesitan
 * cargarlo ellos.
 *
 * `process.loadEnvFile` viene en Node 20.6+ y no suma una dependencia. Se prueban
 * las dos rutas porque los scripts corren desde `apps/api` y el `.env` esta en la
 * raiz del monorepo. Las variables ya presentes en el entorno ganan: en CI y en
 * Docker el `.env` no existe y todo llega por variable.
 */
export function loadDotEnv(): void {
  const candidates = ['.env', '../../.env'];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
    } catch {
      // Un `.env` con formato raro no debe impedir arrancar: las variables de
      // entorno reales tienen prioridad de todos modos.
    }
    return;
  }
}

export { loadEnv, parseDuration, schema as envSchema };
