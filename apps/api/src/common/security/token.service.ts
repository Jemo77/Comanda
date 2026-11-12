import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtModuleOptions, type JwtSignOptions } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { AccessTokenClaims } from '@comanda/domain';

/**
 * Vida del access token, inyectada desde la config.
 *
 * Va declarado antes de la clase que lo inyecta: `const` es block-scoped, asi que
 * referenciarlo desde arriba es un error de compilacion que no aparece hasta que se
 * mueve el codigo.
 */
export const ACCESS_TOKEN_TTL = 'ACCESS_TOKEN_TTL';

/**
 * Tokens de acceso (JWT de corta duracion).
 *
 * Claims minimos: identidad (`sub`), tenant (`org`), local (`venue`) y la sesion
 * (`jti`). **Los permisos no van en el token**, a proposito:
 *
 *  - El token dura 15 minutos, pero revocar un permiso tiene que tener efecto
 *    inmediato. Con los permisos embebidos, al Encargado que le revocan
 *    `stock.adjust` le quedaria el permiso hasta que expire su token.
 *  - Un JWT con 80 permisos dentro tambien es largo de leer en cada request.
 *
 * La autorizacion real se resuelve contra la base en cada request, con el contexto
 * de tenant ya puesto: ademas de ser correcta, garantiza que el permiso sea el de
 * ESE local y no el de otro.
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ACCESS_TOKEN_TTL) private readonly ttlSeconds: number,
  ) {}

  sign(input: { userId: string; orgId: string; venueId: string; roleKeys: readonly string[] }): {
    token: string;
    expiresIn: number;
  } {
    const token = this.jwt.sign(
      {
        org: input.orgId,
        venue: input.venueId,
        roles: input.roleKeys,
      },
      {
        subject: input.userId,
        // El `jti` permite revocar un token concreto y aparece en la auditoria para
        // correlacionar una accion con su sesion.
        jwtid: randomUUID(),
        expiresIn: this.ttlSeconds,
      },
    );
    return { token, expiresIn: this.ttlSeconds };
  }

  async verify(token: string): Promise<AccessTokenClaims & { roles?: string[] }> {
    return this.jwt.verifyAsync(token) as Promise<AccessTokenClaims & { roles?: string[] }>;
  }

  /** Vida del access token en segundos. */
  ttl(): number {
    return this.ttlSeconds;
  }
}

/**
 * Opciones de firma y verificacion.
 *
 * El algoritmo se fija en HS256 de forma explicita: dejar el default aceptaria
 * `alg: none` y abriria la puerta a confusiones HS/RS. Un token firmado con otro
 * algoritmo tiene que rechazarse, no "verificarse de alguna manera".
 */
export function jwtOptions(env: {
  JWT_ACCESS_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
}): JwtModuleOptions {
  return {
    secret: env.JWT_ACCESS_SECRET,
    signOptions: {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithm: 'HS256',
    } satisfies JwtSignOptions,
    verifyOptions: {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
      // Margen de 5s para tolerancia de reloj entre cliente y servidor.
      clockTolerance: 5,
    },
  };
}

/**
 * Registra `JwtModule` con las opciones del proyecto.
 *
 * Vive aca y no en el modulo raiz porque `JwtService` solo lo usa auth: registrarlo
 * en el `AppModule` sin exportarlo hacia abajo hace que `AuthModule` no lo vea y
 * falle con "can't resolve dependencies of the AccessTokenService".
 */
export function registerJwt(config: ConfigService): JwtModuleOptions {
  return jwtOptions({
    JWT_ACCESS_SECRET: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    JWT_ISSUER: config.get<string>('JWT_ISSUER') ?? 'comanda',
    JWT_AUDIENCE: config.get<string>('JWT_AUDIENCE') ?? 'comanda-api',
  });
}

@Global()
@Module({
  providers: [AccessTokenService],
  exports: [AccessTokenService],
})
export class SecurityModule {}
