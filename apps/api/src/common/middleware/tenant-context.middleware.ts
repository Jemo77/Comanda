import { Inject, Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES, problemDetails } from '@comanda/domain';
import type { Database, TenantContext } from '../../database/database.service';

/**
 * Middleware que setea el contexto de tenant.
 *
 * Corre en cada request autenticado y lo hace **dentro de la transaccion** de la
 * peticion. `SET LOCAL` vive hasta el COMMIT/ROLLBACK, asi que el contexto se
 * descarta solo: si se usara `SET` (sin LOCAL), una conexion devuelta al pool
 * conservaria el tenant anterior y la siguiente peticion de otro local leeria
 * datos ajenos. Es la fuga clasica de un multi-tenant con pool de conexiones.
 *
 * En Nest, la transaccion se abre en un interceptor y este middleware solo deja
 * el contexto disponible en `AsyncLocalStorage`. Por eso el interceptor es el que
 * hace el `set_config`: tiene que estar DENTRO de la transaccion.
 */

/** Storage local de Nest para propagar el contexto sin firmarlo por el request. */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(@Inject('DATABASE') private readonly db: Database) {}

  /**
   * Verifica que el contexto que trae el request sea coherente con la sesion.
   *
   * Un header `X-Org-Id` de un cliente no se trusts: el org sale SIEMPRE del token.
   * Este middleware solo se asegura de que las variables de sesion queden listas
   * para los handlers.
   */
  use(req: Request & { tenantContext?: TenantContext }, _res: Response, next: NextFunction): void {
    const principal = (
      req as {
        principal?: { orgId: string; venueId: string; userId: string; deviceId: string | null };
      }
    ).principal;

    if (!principal) {
      next();
      return;
    }

    req.tenantContext = {
      orgId: principal.orgId,
      venueId: principal.venueId,
      userId: principal.userId,
      deviceId: principal.deviceId,
    };

    next();
  }

  /**
   * Helper para tests y para jobs: setea el contexto en una transaccion.
   * Se expone aca (y no en el service) para que el unico lugar que conoce el
   * contrato de nombres sea este modulo.
   */
  static async applyTo(
    tx: {
      execute: (sql: string) => Promise<unknown>;
    },
    ctx: TenantContext,
  ): Promise<void> {
    await tx.execute(`SELECT set_config('app.current_org', '${ctx.orgId}', true)`);
    if (ctx.venueId) {
      await tx.execute(`SELECT set_config('app.current_venue', '${ctx.venueId}', true)`);
    }
    if (ctx.userId) {
      await tx.execute(`SELECT set_config('app.current_user', '${ctx.userId}', true)`);
    }
    if (ctx.deviceId) {
      await tx.execute(`SELECT set_config('app.current_device', '${ctx.deviceId}', true)`);
    }
  }

  problem(status: number, detail: string, code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES]) {
    return problemDetails({ status, code, detail });
  }
}
