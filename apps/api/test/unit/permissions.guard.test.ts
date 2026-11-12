// `Reflect.defineMetadata`, que usa `SetMetadata`, viene del polyfill que carga
// Nest en la app. En el test hay que importarlo explicitamente.
import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS_KEY,
  PermissionsGuard,
  RequirePermissions,
  RequireSession,
} from '../../src/common/authz/permissions.guard';
import { mergeConstraints, type SessionPrincipal } from '../../src/common/authz/principal';

/**
 * Guard de permisos.
 *
 * Lo que se verifica aca es lo que no se ve en la app: que un endpoint sin
 * permisos declarados quede cerrado, que los permisos se exijan todos, y que la
 * sesion no pueda "subir" de rol en el camino.
 */

function principal(overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
  return {
    userId: 'u1',
    orgId: 'o1',
    venueId: 'v1',
    roleIds: ['r1'],
    roleKeys: ['cajero'],
    permissions: ['order.read', 'order.item.add', 'bill.pay'],
    constraints: {},
    deviceId: null,
    sessionId: 'jti',
    authMethod: 'password',
    ...overrides,
  };
}

/** Guard con los metadatos de permisos fijos. */
function guardRequiring(required: string[] | undefined): PermissionsGuard {
  const reflector = {
    getAllAndOverride: () => required,
  } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

/** Request de prueba, con o sin principal. */
function contextWith(who: SessionPrincipal | undefined): ExecutionContext {
  const request: { principal?: SessionPrincipal } = {};
  if (who) request.principal = who;
  return {
    getHandler: () => undefined as never,
    getClass: () => undefined as never,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * Lanza la accion y devuelve el `detail` del problem+json.
 *
 * `HttpException.message` es siempre "Forbidden Exception" cuando el payload es un
 * objeto: el texto real esta en `getResponse().detail`.
 */
function detailOf(run: () => boolean): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ForbiddenException) {
      const response = error.getResponse() as { detail: string };
      return response.detail;
    }
    throw error;
  }
  throw new Error('Se esperaba un ForbiddenException y no se lanzo ninguna');
}

describe('PermissionsGuard', () => {
  it('permite cuando el usuario tiene todos los permisos', () => {
    expect(guardRequiring(['order.read', 'bill.pay']).canActivate(contextWith(principal()))).toBe(
      true,
    );
  });

  it('rechaza si falta uno de los varios permisos', () => {
    const detail = detailOf(() =>
      guardRequiring(['order.read', 'bill.discount']).canActivate(contextWith(principal())),
    );
    expect(detail).toContain('cajero');
  });

  it('exige TODOS los permisos, no cualquiera', () => {
    // Si un endpoint pide dos permisos y el usuario tiene uno, no alcanza: un OR
    // implicito es la forma tipica de dejar un endpoint mas abierto de lo que se
    // creia.
    expect(guardRequiring(['bill.pay', 'order.read']).canActivate(contextWith(principal()))).toBe(
      true,
    );
    expect(() =>
      guardRequiring(['bill.pay', 'order.item.void']).canActivate(contextWith(principal())),
    ).toThrow(ForbiddenException);
  });

  it('un endpoint sin permisos declarados queda cerrado', () => {
    // Olvidar el decorador tiene que ser un fallo de desarrollo visible, no un
    // endpoint abierto por omision.
    expect(detailOf(() => guardRequiring(undefined).canActivate(contextWith(principal())))).toMatch(
      /no declara permisos/,
    );
  });

  it('exige sesion aunque no pida permisos concretos', () => {
    expect(guardRequiring([]).canActivate(contextWith(principal()))).toBe(true);
    expect(detailOf(() => guardRequiring([]).canActivate(contextWith(undefined)))).toMatch(
      /No hay sesion activa/,
    );
  });

  it('no acepta un principal vacio como sesion valida', () => {
    expect(() => guardRequiring([]).canActivate(contextWith(undefined))).toThrow(
      ForbiddenException,
    );
  });
});

describe('decoradores', () => {
  // Se aplican sobre una clase real: `Reflect.defineMetadata` necesita un target
  // valido, y los decoradores de Nest se disenan para eso.
  class Controlador {
    @RequirePermissions('order.read', 'bill.pay')
    cobrar() {}

    @RequireSession()
    yo() {}
  }

  const metadataOf = (method: 'cobrar' | 'yo'): unknown =>
    Reflect.getMetadata(PERMISSIONS_KEY, (Controlador.prototype as never)[method]);

  it('RequirePermissions guarda la lista de permisos en el handler', () => {
    expect(metadataOf('cobrar')).toEqual(['order.read', 'bill.pay']);
  });

  it('RequireSession deja la lista vacia (autenticado, sin permiso concreto)', () => {
    expect(metadataOf('yo')).toEqual([]);
  });

  it('cada handler tiene sus propios permisos', () => {
    // Si los metadatos se compartieran entre handlers, un endpoint abierto
    // heredaria los permisos del vecino.
    expect(metadataOf('yo')).not.toEqual(metadataOf('cobrar'));
  });
});

describe('mergeConstraints', () => {
  it('toma el tope de descuento mas restrictivo', () => {
    // Un usuario con dos roles no puede combinarlos para saltarse el tope.
    expect(
      mergeConstraints([{ discountMaxBps: 1000 }, { discountMaxBps: 10_000 }]).discountMaxBps,
    ).toBe(1000);
    expect(
      mergeConstraints([{ discountMaxBps: 10_000 }, { discountMaxBps: 1000 }]).discountMaxBps,
    ).toBe(1000);
  });

  it('un rol sin tope de descuento no relaja al otro', () => {
    expect(mergeConstraints([{ discountMaxBps: 1000 }, {}]).discountMaxBps).toBe(1000);
  });

  it('exige PIN de supervisor si algun rol lo pide', () => {
    // Que uno de los roles pida segunda autenticacion es motivo de sobra.
    expect(mergeConstraints([{}, { requiresSupervisorPin: true }]).requiresSupervisorPin).toBe(
      true,
    );
    expect(mergeConstraints([{}, {}]).requiresSupervisorPin).toBeUndefined();
  });

  it('una lista vacia no impone nada', () => {
    expect(mergeConstraints([])).toEqual({});
  });
});
