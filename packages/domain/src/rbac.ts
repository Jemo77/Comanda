import { PERMISSION_KEYS, type PermissionKey } from './permissions';

/**
 * Roles por defecto que se crean al ubicar un local.
 *
 * Se derivan de la matriz del PLAN (§6) con dos correcciones deliberadas:
 *
 *  1. El plan marca "Cajero: descuento con limite". Se modela como
 *     `constraints.discountMaxBps` (no como permiso) porque el permiso es binario
 *     y el limite es numerico: el guard lee la constraint, no el permiso.
 *
 *  2. `report.read` lo tienen los cuatro. Un mozo ve el rendimiento de su turno,
 *     que es informacion que necesita para trabajar mejor; el detalle financiero
 *     sigue bloqueado para Encargado salvo `finance.read`.
 *
 * Los roles son editables por el dueño: estos son el punto de partida, no el
 * contrato. Un local que quiera que el Cajero vea costos cambia la matriz sin
 * esperar un deploy.
 */

export const DEFAULT_ROLE_KEYS = ['mozo', 'cajero', 'encargado', 'dueno'] as const;
export type DefaultRoleKey = (typeof DEFAULT_ROLE_KEYS)[number];

export interface RoleConstraints {
  /** Tope de descuento en basis points. 1000 = 10%. */
  discountMaxBps?: number;
  /** Requiere PIN de supervisor para ejecutar la accion. */
  requiresSupervisorPin?: boolean;
  /** Impide que el usuario actue sobre su propia sesion de forma sensible. */
  [key: string]: unknown;
}

export interface DefaultRole {
  key: DefaultRoleKey;
  name: string;
  description: string;
  permissions: readonly PermissionKey[];
  constraints: RoleConstraints;
  /** Un rol de sistema no se puede eliminar ni cambiar de clave. */
  isSystem: true;
}

const ALL: readonly PermissionKey[] = PERMISSION_KEYS;

const MOZO: readonly PermissionKey[] = [
  'auth.login',
  'auth.login.pin',
  'auth.logout',
  'auth.refresh',
  'venue.read',
  // El KDS lo opera quien esta en la cocina, que en un bar chico es el mismo rol que
  // toma el pedido. `kitchen.read` habilita ver los tickets y `kitchen.advance` el
  // unico gesto que se repite en el turno.
  'kitchen.read',
  'kitchen.advance',
  'device.read',
  'category.read',
  'product.read',
  'modifier.read',
  'promotion.read',
  'floor.read',
  'table.read',
  'order.read',
  'order.open',
  'order.item.add',
  'order.transfer',
  'order.merge',
  'order.approve',
  'bill.read',
  'report.read',
  'stock.read',
  'recipe.read',
  'customer.read',
  'loyalty.read',
  'timeEntry.read',
];

const CAJERO: readonly PermissionKey[] = [
  ...MOZO,
  'bill.pay',
  'bill.split',
  'bill.discount',
  'shift.open',
  'shift.close',
  'cash.movement',
  'product.priceChange',
  'bill.reprint',
  'timeEntry.manage',
  'customer.manage',
  'loyalty.redeem',
  'order.approve',
];

const ENCARGADO: readonly PermissionKey[] = [
  ...CAJERO,
  'order.item.void',
  'cash.viewExpected',
  'table.manage',
  'floor.manage',
  'stock.adjust',
  'stock.waste',
  'ingredient.read',
  'ingredient.manage',
  'purchase.read',
  'purchase.manage',
  'recipe.manage',
  'modifier.manage',
  'category.manage',
  'loyalty.redeem',
  'user.read',
  'device.register',
  'invoice.read',
  'costing.read',
  'integration.read',
  'audit.read',
];

const DUENO: readonly PermissionKey[] = ALL;

export const DEFAULT_ROLES: Record<DefaultRoleKey, DefaultRole> = {
  mozo: {
    key: 'mozo',
    name: 'Mozo',
    description: 'Toma pedidos, abre mesas y ve su turno. No cobra ni anula.',
    permissions: MOZO,
    constraints: {},
    isSystem: true,
  },
  cajero: {
    key: 'cajero',
    name: 'Cajero',
    description: 'Cobra, divide cuentas, abre y cierra caja. Descontos con tope.',
    permissions: CAJERO,
    constraints: { discountMaxBps: 1000, requiresSupervisorPin: true },
    isSystem: true,
  },
  encargado: {
    key: 'encargado',
    name: 'Encargado',
    description:
      'Opera el local completo: anula, ajusta stock, ve el arqueo esperado y gestiona compras.',
    permissions: ENCARGADO,
    constraints: { discountMaxBps: 10_000 },
    isSystem: true,
  },
  dueno: {
    key: 'dueno',
    name: 'Dueño',
    description: 'Acceso total, incluidos precios, fiscal, usuarios y roles.',
    permissions: DUENO,
    constraints: { discountMaxBps: 10_000 },
    isSystem: true,
  },
};

export function defaultRoles(): DefaultRole[] {
  return DEFAULT_ROLE_KEYS.map((key) => DEFAULT_ROLES[key]);
}

/**
 * Verifica una constraint numerica de rol.
 * Devuelve `null` si el valor pedido es aceptable, o el motivo del rechazo.
 */
export function checkConstraints(
  constraints: RoleConstraints,
  requested: { discountBps?: number; requiresSupervisorPin?: boolean },
): string | null {
  if (requested.discountBps !== undefined) {
    const limit = constraints.discountMaxBps;
    if (limit === undefined) {
      return 'Este rol no puede aplicar descuentos.';
    }
    if (requested.discountBps > limit) {
      const pct = limit / 100;
      return `Descuento del ${(requested.discountBps / 100).toFixed(1)}% supera el tope de ${pct}% de este rol.`;
    }
  }
  // El resto de constraints (`requiresSupervisorPin`) las resuelve el guard de
  // supervisor en el backend: no son un limite de importe sino una segunda
  // autenticacion, asi que no tienen sentido como "rechazo" aqui.
  return null;
}
