import { describe, expect, it } from 'vitest';
import { loadEnv, parseDuration } from '../../src/config/env';

const base = {
  DATABASE_URL: 'postgresql://comanda_app:x@localhost:5432/comanda',
  JWT_ACCESS_SECRET: 'un-secreto-que-tiene-al-menos-32-caracteres-de-lo-mas',
  PIN_PEPPER: 'un-pepper-de-al-menos-16-chars',
  QR_TOKEN_SECRET: 'un-secreto-qr-de-al-menos-16-chars',
  PAYMENT_WEBHOOK_SECRET: 'un-secreto-wh-de-al-menos-16-chars',
} as NodeJS.ProcessEnv;

/**
 * Configuracion por entorno.
 *
 * Falla temprano y con un mensaje claro: un secreto ausente tiene que romper el
 * deploy, no aparecer como un 500 en el primer login de un local.
 */
describe('loadEnv', () => {
  it('acepta una configuracion minima y aplica defaults', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'test' });
    expect(env.API_PORT).toBe(3000);
    expect(env.JWT_ACCESS_TTL).toBe('15m');
    expect(env.JWT_REFRESH_TTL_DAYS).toBe(30);
    expect(env.CORS_ORIGINS).toContain('localhost:5173');
  });

  it('convierte la duracion del access token a segundos', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).accessTokenTtlSeconds).toBe(900);
    expect(
      loadEnv({ ...base, NODE_ENV: 'test', JWT_ACCESS_TTL: '30s' }).accessTokenTtlSeconds,
    ).toBe(30);
    expect(loadEnv({ ...base, NODE_ENV: 'test', JWT_ACCESS_TTL: '2h' }).accessTokenTtlSeconds).toBe(
      7200,
    );
  });

  it('convierte los dias de refresh a milisegundos', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'test', JWT_REFRESH_TTL_DAYS: '7' });
    expect(env.refreshTokenTtlMs).toBe(7 * 86_400_000);
  });

  it('falla si falta DATABASE_URL', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'test', DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('falla si el secreto de JWT es corto', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'test', JWT_ACCESS_SECRET: 'corto' })).toThrow(
      /al menos 32 caracteres/,
    );
  });

  it('falla si el pepper es corto', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'test', PIN_PEPPER: 'corto' })).toThrow(
      /al menos 16 caracteres/,
    );
  });

  it('falla con una duracion mal formada', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'test', JWT_ACCESS_TTL: '15 minutos' })).toThrow(
      /15m/,
    );
  });

  it('el mensaje de error lista TODOS los problemas, no solo el primero', () => {
    // Un despliegue con dos variables malas deberia ver las dos de una vez.
    let message = '';
    try {
      loadEnv({ ...base, NODE_ENV: 'test', JWT_ACCESS_SECRET: 'corto', PIN_PEPPER: 'corto' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).toContain('PIN_PEPPER');
  });

  it('rechaza los secretos de ejemplo en produccion', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'dev-only-access-secret-cambiar-en-produccion-0000',
        PIN_PEPPER: 'dev-only-pin-pepper-cambiar-en-produccion-00',
      }),
    ).toThrow(/sigue con el valor de ejemplo/);
  });

  it('rechaza los secretos de cliente (QR, webhook) de ejemplo en produccion', () => {
    // El QR y el webhook son credenciales de la misma estatura que el
    // JWT: un default de ejemplo en produccion es una mesa abierta y
    // un webhook que cualquiera puede firmar.
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        QR_TOKEN_SECRET: 'dev-only-qr-token-secret-cambiar-0000',
        PAYMENT_WEBHOOK_SECRET: 'dev-only-webhook-secret-cambiar-00',
      }),
    ).toThrow(/sigue con el valor de ejemplo/);
  });

  it('acepta secretos propios en produccion', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).not.toThrow();
  });

  it('rechaza un puerto invalido', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'test', API_PORT: '99999' })).toThrow();
  });
});

describe('parseDuration', () => {
  it('convierte las unidades soportadas', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('2h')).toBe(7200);
    expect(parseDuration('7d')).toBe(604_800);
  });

  it('lanza con algo que no es una duracion', () => {
    expect(() => parseDuration('pronto')).toThrow();
  });
});
