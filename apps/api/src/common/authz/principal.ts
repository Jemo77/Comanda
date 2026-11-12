import type { RoleConstraints } from '@comanda/domain';
import type { Request } from 'express';

/**
 * Sesion del request.
 *
 * Es lo unico que un handler necesita saber para trabajar: quien es, en que local
 * esta y que puede hacer. Los permisos vienen ya resueltos desde la base, con el
 * filtro de local aplicado.
 */
export interface SessionPrincipal {
  userId: string;
  orgId: string;
  venueId: string;
  roleIds: string[];
  roleKeys: string[];
  /** Permisos efectivos de esta sesion, ya deduplicados. */
  permissions: string[];
  /** Limites no binarios del rol mas restrictivo que aplica. */
  constraints: RoleConstraints;
  /** Dispositivo desde el que entro la sesion, si hubo login por dispositivo. */
  deviceId: string | null;
  /** `jti` del token de acceso, para correlacionar con la auditoria. */
  sessionId: string;
  /** Metodo con el que se autentico esta sesion. */
  authMethod: 'password' | 'pin' | 'refresh' | 'supervisor';
}

/** Request de Express con la sesion adjunta por el middleware de auth. */
export interface RequestWithPrincipal extends Request {
  principal?: SessionPrincipal;
}

/**
 * Une constraints de varios roles tomando el mas restrictivo.
 *
 * Un usuario con dos roles (por ejemplo, Cajero en un local y Encargado en otro)
 * no puedeCombinarlos para saltarse el tope de descuento: el minimo gana. La
 * logica es "el permiso mas alto, la constraint mas restrictiva".
 */
export function mergeConstraints(constraints: RoleConstraints[]): RoleConstraints {
  const merged: RoleConstraints = {};

  const discounts = constraints
    .map((c) => c.discountMaxBps)
    .filter((value): value is number => typeof value === 'number');

  if (discounts.length > 0) {
    merged.discountMaxBps = Math.min(...discounts);
  }

  // Si algun rol exige PIN de supervisor, se exige: es una segunda autenticacion
  // para acciones sensibles, y que uno de los roles la pida es motivo de sobra.
  if (constraints.some((c) => c.requiresSupervisorPin === true)) {
    merged.requiresSupervisorPin = true;
  }

  return merged;
}
