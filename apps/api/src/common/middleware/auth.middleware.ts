import { Inject, Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES, problemDetails } from '@comanda/domain';
import { AccessTokenService } from '../security/token.service';
import { AuthService } from '../../modules/auth/auth.service';
import type { SessionPrincipal } from '../authz/principal';

/**
 * Middleware de autenticacion.
 *
 * Verifica el access token y arma el `SessionPrincipal` con los permisos
 * resueltos **contra la base**, no contra lo que dice el token. Esa es la razon de
 * que los permisos no viajen en el JWT: revocar un permiso tiene que surtir efecto
 * en la proxima request, no cuando expire el token.
 *
 * Los `@Inject` son explicitos a proposito: los tipos de los parametros se borran al
 * compilar, asi que sin ellos Nest no tiene con que resolver y el arranque falla con
 * "can't resolve dependencies of the AuthMiddleware (?, Function)".
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    @Inject(AccessTokenService) private readonly tokens: AccessTokenService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        problemDetails({
          status: 401,
          code: ERROR_CODES.UNAUTHENTICATED,
          detail: 'Falta el token de sesion.',
        }),
      );
    }

    const token = header.slice('Bearer '.length);

    let claims: { sub: string; org: string; venue: string; jti?: string };
    try {
      claims = await this.tokens.verify(token);
    } catch (error) {
      // Se distingue "expirado" de "invalido" porque la UI reacciona distinto: un
      // token expirado se renueva solo, uno invalido obliga a login.
      const expired =
        error instanceof Error &&
        (error.name === 'TokenExpiredError' || error.message.includes('expired'));

      throw new UnauthorizedException(
        problemDetails({
          status: 401,
          code: expired ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.UNAUTHENTICATED,
          detail: expired ? 'Tu sesion vencio. Renovando…' : 'La sesion no es valida.',
        }),
      );
    }

    // El org y el venue salen del token firmado, nunca de un header del cliente.
    const principal = await this.auth.resolvePrincipal({
      userId: claims.sub,
      orgId: claims.org,
      venueId: claims.venue,
      sessionId: claims.jti ?? '',
      authMethod: 'refresh',
    });

    (req as Request & { principal?: SessionPrincipal }).principal = principal;
    next();
  }
}
