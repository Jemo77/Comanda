import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import {
  ACCESS_TOKEN_TTL,
  AccessTokenService,
  registerJwt,
} from '../../common/security/token.service';
import { PasswordHasher, TokenService } from '../../common/security/hash';
import type { AppEnv } from '../../config/env';

/**
 * Auth y refresh tokens.
 *
 * `JwtModule` se registra aca, y no en el modulo raiz: `JwtService` solo lo usa auth,
 * y declararlo arriba sin exportarlo hacia abajo hace que este modulo no lo vea.
 *
 * `PasswordHasher` y `TokenService` se construyen con una factory y no con
 * `useValue`: asi los tests pueden inyectar parametros baratos de argon2 (memoria
 * minima) sin duplicar la logica de construccion.
 */
@Global()
@Module({
  imports: [
    RbacModule,
    AuditModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: registerJwt,
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenService,
    {
      // El TTL sale de la config y no de un constante: 15 minutos es el default,
      // pero un local con cortes de internet largos necesita más.
      provide: ACCESS_TOKEN_TTL,
      inject: [ConfigService],
      // `accessTokenTtlSeconds` ya viene normalizado: `ConfigModule.validate` pasa
      // por `loadEnv`, que convierte "15m" a 900 y rechaza el formato invalido.
      useFactory: (config: ConfigService) => config.getOrThrow<number>('accessTokenTtlSeconds'),
    },
    {
      provide: PasswordHasher,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new PasswordHasher(
          config.getOrThrow<string>('PIN_PEPPER'),
          {
            memoryCost: config.get<number>('ARGON2_MEMORY_KB') ?? 65_536,
            timeCost: config.get<number>('ARGON2_TIME_COST') ?? 3,
          },
          {
            memoryCost: config.get<number>('ARGON2_PIN_MEMORY_KB') ?? 131_072,
            timeCost: config.get<number>('ARGON2_PIN_TIME_COST') ?? 5,
          },
        ),
    },
    {
      provide: TokenService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new TokenService(config.get<number>('JWT_REFRESH_TTL_DAYS')! * 86_400_000),
    },
  ],
  exports: [AuthService, AccessTokenService, PasswordHasher, TokenService],
})
export class AuthModule {}

export type { AppEnv };
