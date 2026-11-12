import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { DatabaseService } from '../../database/database.service';
import type { RequestWithPrincipal } from '../authz/principal';

/**
 * Interceptor que envuelve cada request en una transaccion con contexto de tenant.
 *
 * Por que una transaccion y no un `SET` suelto:
 *
 *  - `SET LOCAL` tiene efecto hasta el fin de la transaccion. Con un `SET` normal,
 *    la conexion vuelve al pool con `app.current_org` del local anterior y la
 *    siguiente peticion de otro local leeria datos ajenos.
 *  - La transaccion tambien da atomicidad: si un handler escribe en varias tablas y
 *    falla a mitad, no queda nada a medias.
 *
 * El contexto se deriva del token verificado, NUNCA de headers del cliente: un
 * `X-Org-Id` enviado por el navegador no se trusts.
 *
 * El commit ocurre cuando el flujo **termina**, no cuando el handler devuelve:
 * cerrarlo antes haria que la segunda escritura de un handler quedara fuera de la
 * transaccion y el rollback ya no la deshara.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(@Inject('DATABASE') private readonly db: DatabaseService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;

    // Endpoints publicos (menu QR, webhooks, login) no tienen principal: corren sin
    // contexto y la RLS les deja ver cero filas, que es lo correcto.
    if (!principal) {
      return next.handle();
    }

    return this.db.runInTenantStream(
      {
        orgId: principal.orgId,
        venueId: principal.venueId,
        userId: principal.userId,
        deviceId: principal.deviceId,
      },
      () => next.handle(),
    );
  }
}
