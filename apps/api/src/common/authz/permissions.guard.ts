import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, canAll, type PermissionPattern } from '@comanda/domain';
import type { SessionPrincipal } from './principal';

/**
 * Autorizacion.
 *
 * El permiso se verifica **siempre en el backend**. La UI lo refleja (oculta
 * botones, deshabilita acciones) pero nunca decide: un boton oculto no es una
 * medida de seguridad, es cortesia.
 *
 * Uso:
 *   @RequirePermissions('order.item.void', 'bill.discount')
 *   @Post('orders/:id/void')
 */
export const PERMISSIONS_KEY = 'comanda:permissions';

/**
 * Decorador de permisos.
 *
 * Acepta varios permisos y exige TODOS. Para "cualquiera de estos", el endpoint
 * se implementa con un guard propio: la ambiguedad de un OR implicito es la
 * forma tipica de dejar un endpoint mas abierto de lo que se creia.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Indica que el endpoint requiere sesion, sin permiso en particular.
 * Un array vacio significa "autenticado": el guard no puede pasar sin principal,
 * pero no exige ninguna clave concreta.
 */
export const RequireSession = () => SetMetadata(PERMISSIONS_KEY, []);

/** Marca el endpoint como publico: el guard lo deja pasar sin sesion ni permisos. */
export const PUBLIC_KEY = 'comanda:public';

/**
 * Endpoint publico.
 *
 * Existe porque el guard falla cuando un endpoint no declara permisos, y eso esta
 * bien para un endpoint de negocio pero no para `/health`: un liveness probe sin
 * sesion tiene que responder 200, o el orquestador reinicia un proceso sano.
 *
 * Se marca de forma explicita y no por ausencia de anotaciones: "publico" es una
 * decision, y una decision invisible es una decision que nadie revisa.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required === undefined) {
      // El endpoint no declaro permisos: es un fallo de desarrollo, no un permiso
      // implícito. Se corta acá para que no quede un endpoint abierto por olvido.
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        detail: 'Este endpoint no declara permisos. Agregá @RequirePermissions().',
      });
    }

    const request = context.switchToHttp().getRequest<{ principal?: SessionPrincipal }>();
    const principal = request.principal;

    if (!principal) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        detail: 'No hay sesion activa.',
      });
    }

    // Sin permisos declarados basta con estar autenticado.
    if (required.length === 0) {
      return true;
    }

    if (!canAll(principal.permissions, required)) {
      const missing = required.filter((p) => !principal.permissions.includes(p));
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        detail: `Tu rol (${principal.roleKeys.join(', ') || 'sin rol'}) no puede hacer esto.`,
        // Se devuelven los faltantes: es lo que la UI necesita para explicar el
        // boton deshabilitado sin inventar mensajes.
        missing,
      });
    }

    return true;
  }
}

/**
 * Inyecta la sesion en un handler.
 *
 * El contexto de tenant (`org`, `venue`, `user`, `device`) ya fue puesto en la
 * transaccion por el middleware, asi que los handlers pueden ir directo a la base
 * sin volver a filtrar por organizacion.
 */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionPrincipal => {
    const request = context.switchToHttp().getRequest<{ principal?: SessionPrincipal }>();
    if (!request.principal) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        detail: 'No hay sesion activa.',
      });
    }
    return request.principal;
  },
);

/** Reexportado para los tests del guard. */
export type { PermissionPattern };
