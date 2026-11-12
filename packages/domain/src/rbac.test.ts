import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTIONS_REQUIRING_REASON,
  isSensitive,
  requiresReason,
  SENSITIVE_ACTIONS,
} from './audit';
import { ERROR_CODES, PROBLEM_TYPES, problemDetails } from './api-error';
import {
  can,
  canAll,
  isPermissionKey,
  namespaceOf,
  permissionMatches,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
} from './permissions';
import { DEFAULT_ROLES, checkConstraints, defaultRoles } from './rbac';

describe('catalogo de permisos', () => {
  it('no tiene permisos duplicados', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('todos siguen la convencion recurso.accion', () => {
    for (const key of PERMISSION_KEYS) {
      expect(key, key).toMatch(/^[a-zA-Z]+\.[a-zA-Z.]+$/);
    }
  });

  it('todos tienen etiqueta legible', () => {
    for (const key of PERMISSION_KEYS) {
      expect(PERMISSION_LABELS[key], key).toBeTruthy();
    }
  });

  it('isPermissionKey distingue claves validas', () => {
    expect(isPermissionKey('order.item.add')).toBe(true);
    expect(isPermissionKey('order.item.borrar')).toBe(false);
  });

  it('namespaceOf extrae el recurso', () => {
    expect(namespaceOf('order.item.void')).toBe('order');
    expect(namespaceOf('bill.pay')).toBe('bill');
  });
});

describe('permissionMatches', () => {
  it('resuelve comodines', () => {
    expect(permissionMatches('*', 'anything')).toBe(true);
    expect(permissionMatches('platform.manage', 'platform.*')).toBe(true);
    expect(permissionMatches('platform.manage', '*')).toBe(true);
    expect(permissionMatches('order.read', 'order.*')).toBe(true);
    expect(permissionMatches('ordering.read', 'order.*')).toBe(false);
    expect(permissionMatches('order.read', 'order.write')).toBe(false);
  });
});

describe('can / canAll', () => {
  it('resuelve permisos concedidos', () => {
    const granted = ['order.read', 'bill.pay'];
    expect(can(granted, 'order.read')).toBe(true);
    expect(can(granted, 'order.item.void')).toBe(false);
    expect(canAll(granted, ['order.read', 'bill.pay'])).toBe(true);
    expect(canAll(granted, ['order.read', 'bill.discount'])).toBe(false);
  });
});

describe('roles por defecto', () => {
  const roles = defaultRoles();

  it('son los cuatro del plan', () => {
    expect(roles.map((r) => r.key).sort()).toEqual(['cajero', 'dueno', 'encargado', 'mozo']);
  });

  it('codifican la matriz de permisos del PLAN §6', () => {
    const mozo = DEFAULT_ROLES.mozo.permissions;
    const cajero = DEFAULT_ROLES.cajero.permissions;
    const encargado = DEFAULT_ROLES.encargado.permissions;
    const dueno = DEFAULT_ROLES.dueno.permissions;

    // Mozo: toma pedidos, no cobra ni anula.
    expect(mozo).toContain('order.item.add');
    expect(mozo).not.toContain('bill.pay');
    expect(mozo).not.toContain('order.item.void');
    expect(mozo).not.toContain('shift.open');

    // Cajero: cobra y opera caja, pero no anula ni ve el esperado.
    expect(cajero).toContain('bill.pay');
    expect(cajero).toContain('bill.discount');
    expect(cajero).toContain('shift.open');
    expect(cajero).not.toContain('order.item.void');
    expect(cajero).not.toContain('cash.viewExpected');

    // Encargado: todo lo operativo, sin tocar configuracion de la empresa.
    expect(encargado).toContain('order.item.void');
    expect(encargado).toContain('cash.viewExpected');
    expect(encargado).toContain('stock.adjust');
    expect(encargado).not.toContain('user.create');
    expect(encargado).not.toContain('fiscal.manage');

    // Dueno: todo.
    expect(dueno).toEqual(PERMISSION_KEYS);
  });

  it('mantiene la jerarquia (cada rol contiene los permisos del anterior)', () => {
    for (const key of DEFAULT_ROLES.mozo.permissions) {
      expect(DEFAULT_ROLES.cajero.permissions).toContain(key);
    }
    for (const key of DEFAULT_ROLES.cajero.permissions) {
      expect(DEFAULT_ROLES.encargado.permissions).toContain(key);
    }
  });

  it('no otorga permisos que no existen en el catalogo', () => {
    const known = new Set<string>(PERMISSION_KEYS);
    for (const role of roles) {
      for (const permission of role.permissions) {
        expect(known.has(permission), `${role.key}: ${permission}`).toBe(true);
      }
    }
  });
});

describe('checkConstraints', () => {
  it('rechaza descuentos por encima del tope del rol', () => {
    const result = checkConstraints({ discountMaxBps: 1000 }, { discountBps: 1500 });
    expect(result).toMatch(/supera el tope/);
  });

  it('acepta descuentos dentro del tope', () => {
    expect(checkConstraints({ discountMaxBps: 1000 }, { discountBps: 1000 })).toBeNull();
  });

  it('rechaza cualquier descuento en un rol sin tope', () => {
    expect(checkConstraints({}, { discountBps: 100 })).toMatch(/no puede aplicar/);
  });

  it('no molesta cuando no se pide descuento', () => {
    expect(checkConstraints({}, {})).toBeNull();
  });
});

describe('auditoria', () => {
  it('no tiene acciones duplicadas', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('las acciones que exigen motivo son acciones validas del catalogo', () => {
    const known = new Set<string>(AUDIT_ACTIONS);
    for (const action of AUDIT_ACTIONS_REQUIRING_REASON) {
      expect(known.has(action), action).toBe(true);
    }
  });

  it('las acciones sensibles exigen motivo', () => {
    for (const action of SENSITIVE_ACTIONS) {
      expect(requiresReason(action), action).toBe(true);
    }
  });

  it('marca correctamente las acciones sensibles', () => {
    expect(isSensitive('order.item_voided')).toBe(true);
    expect(requiresReason('order.item_voided')).toBe(true);
    expect(isSensitive('device.revoked')).toBe(false);
    expect(requiresReason('device.revoked')).toBe(true);
    expect(isSensitive('order.opened')).toBe(false);
    expect(requiresReason('bill.paid')).toBe(false);
  });
});

describe('problemDetails (RFC 7807)', () => {
  it('deduce el tipo a partir del codigo', () => {
    const p = problemDetails({
      status: 403,
      code: ERROR_CODES.FORBIDDEN,
      detail: 'Tu rol no puede anular items.',
    });
    expect(p.type).toBe(PROBLEM_TYPES.forbidden);
    expect(p.title).toBe('Sin permiso');
    expect(p.code).toBe('FORBIDDEN');
  });

  it('incluye el detalle de validacion cuando existe', () => {
    const p = problemDetails({
      status: 422,
      code: ERROR_CODES.VALIDATION_FAILED,
      detail: 'Revisa los campos marcados.',
      errors: [{ path: 'email', message: 'Formato de email invalido' }],
    });
    expect(p.errors).toHaveLength(1);
    expect(p.errors![0]!.path).toBe('email');
  });

  it('omite errors vacio', () => {
    const p = problemDetails({ status: 500, code: ERROR_CODES.INTERNAL, detail: 'x', errors: [] });
    expect('errors' in p).toBe(false);
  });

  it('mapea cada codigo a un status coherente', () => {
    const statuses = {
      VALIDATION_FAILED: 422,
      UNAUTHENTICATED: 401,
      INVALID_CREDENTIALS: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      RATE_LIMITED: 429,
      INTERNAL: 500,
    } as const;
    for (const [code, status] of Object.entries(statuses)) {
      const p = problemDetails({ status, code: code as never, detail: 'x' });
      expect(p.status).toBe(status);
      expect(p.title).not.toBe('Error');
    }
  });
});
