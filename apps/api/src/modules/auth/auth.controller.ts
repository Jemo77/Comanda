import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  ERROR_CODES,
  loginSchema,
  problemDetails,
  refreshTokenSchema,
  type LoginInput,
  type LoginResponse,
  type SessionUser,
} from '@comanda/domain';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { AccessTokenService } from '../../common/security/token.service';
import { CurrentSession, Public, RequireSession } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

/**
 * Endpoints de autenticacion.
 *
 * Publicos a proposito: son la puerta de entrada. Lo que los protege es el
 * rate limiting (ver `app.module.ts`) y el bloqueo por intentos, no un permiso.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly access: AccessTokenService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión con email y contraseña o con PIN de dispositivo' })
  @ApiResponse({ status: 200, description: 'Sesion iniciada', type: Object })
  @ApiResponse({ status: 401, description: 'Credenciales invalidas o dispositivo no aprobado' })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
  ): Promise<LoginResponse> {
    const ip = clientIp(req);
    const userAgent = headerValue(req, 'user-agent');

    const result =
      body.method === 'password'
        ? await this.auth.loginWithPassword({
            email: body.email,
            password: body.password,
            deviceId: body.deviceId,
            ip,
            userAgent,
          })
        : await this.auth.loginWithPin({
            deviceId: body.deviceId,
            pin: body.pin,
            ip,
            userAgent,
          });

    return this.buildResponse(
      result,
      await this.auth.userProfile(result.principal.userId, result.principal.orgId),
    );
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renovar la sesión con refresh rotativo' })
  @ApiResponse({ status: 200, description: 'Token renovado' })
  @ApiResponse({ status: 401, description: 'Token expirado o reuso detectado' })
  async refresh(
    @Body(new ZodValidationPipe(refreshTokenSchema)) body: { refreshToken: string },
    @Req() req: Request,
  ): Promise<LoginResponse> {
    const result = await this.auth.refresh({
      token: body.refreshToken,
      ip: clientIp(req),
      userAgent: headerValue(req, 'user-agent'),
    });

    // El access token se firma aca: `AuthService` no conoce el `JwtService`, y
    // mantener esa dependencia en un solo lado deja el refresh testeable sin
    // levantar el modulo de Nest.
    const access = this.access.sign({
      userId: result.principal.userId,
      orgId: result.principal.orgId,
      venueId: result.principal.venueId,
      roleKeys: result.principal.roleKeys,
    });

    return this.buildResponse(
      {
        principal: result.principal,
        refreshToken: result.refreshToken,
        expiresIn: access.expiresIn,
      },
      await this.auth.userProfile(result.principal.userId, result.principal.orgId),
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSession()
  @ApiOperation({ summary: 'Cerrar la sesión actual' })
  @ApiResponse({ status: 204, description: 'Sesion cerrada' })
  async logout(@CurrentSession() session: SessionPrincipal, @Req() req: Request): Promise<void> {
    await this.auth.logout({
      userId: session.userId,
      orgId: session.orgId,
      name: session.roleKeys[0] ?? 'sesion',
      venueId: session.venueId,
      deviceId: session.deviceId,
      ip: clientIp(req),
      userAgent: headerValue(req, 'user-agent'),
    });
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @RequireSession()
  @ApiOperation({ summary: 'Cerrar todas las sesiones en todos los dispositivos' })
  async logoutEverywhere(
    @CurrentSession() session: SessionPrincipal,
    @Req() req: Request,
  ): Promise<{ closed: number }> {
    // `logout` ya revoca todas las filas vivas del usuario, no solo las del
    // dispositivo: por eso no hay un metodo separado que haga casi lo mismo.
    await this.auth.logout({
      userId: session.userId,
      orgId: session.orgId,
      name: session.roleKeys[0] ?? 'sesion',
      venueId: session.venueId,
      deviceId: session.deviceId,
      ip: clientIp(req),
      userAgent: headerValue(req, 'user-agent'),
    });
    const sessions = await this.auth.activeSessions(session.userId, session.orgId);
    return { closed: sessions.length };
  }

  @Get('me')
  @RequireSession()
  @ApiOperation({ summary: 'Sesión actual: usuario, local, roles y permisos' })
  async me(@CurrentSession() session: SessionPrincipal): Promise<{ user: SessionUser }> {
    const profile = await this.auth.userProfile(session.userId, session.orgId);
    if (!profile) {
      throw new Error('Sesion sin usuario');
    }
    return { user: this.auth.toSessionUser(session, profile.name, profile.email) };
  }

  @Get('sessions')
  @RequireSession()
  @ApiOperation({ summary: 'Sesiones activas del usuario' })
  async sessions(@CurrentSession() session: SessionPrincipal): Promise<{ sessions: unknown[] }> {
    return { sessions: await this.auth.activeSessions(session.userId, session.orgId) };
  }

  private async buildResponse(
    result: { principal: SessionPrincipal; refreshToken: string; expiresIn: number },
    profile: { name: string; email: string } | null,
  ): Promise<LoginResponse> {
    const access = this.access.sign({
      userId: result.principal.userId,
      orgId: result.principal.orgId,
      venueId: result.principal.venueId,
      roleKeys: result.principal.roleKeys,
    });

    return {
      accessToken: access.token,
      refreshToken: result.refreshToken,
      expiresIn: access.expiresIn,
      user: this.auth.toSessionUser(result.principal, profile?.name ?? '', profile?.email ?? ''),
    };
  }
}

/**
 * IP del cliente.
 *
 * Detras de un balanceador, `req.ip` es la del proxy. Se toma la primera entrada
 * de `X-Forwarded-For` que no sea una IP privada: es la del cliente real, y es la
 * que va a la auditoria.
 */
export function clientIp(req: Request): string | null {
  const forwarded = headerValue(req, 'x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first && !isPrivateAddress(first)) return first;
  }
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function headerValue(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isPrivateAddress(address: string): boolean {
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    address.startsWith('127.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    address.startsWith('::1') ||
    address.startsWith('fc') ||
    address.startsWith('fd')
  );
}

export { ERROR_CODES, problemDetails };
