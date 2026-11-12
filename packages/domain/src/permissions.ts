/**
 * Catalogo de permisos finos.
 *
 * El permiso es la unidad de autorizacion real: los guards del backend verifican
 * claves, nunca nombres de rol. Los roles son solo agrupadores de permisos, y un
 * local puede crear roles propios sin tocar el codigo.
 *
 * Convencion de nombres: `<recurso>.<accion>`. El orden de las acciones dentro de
 * un grupo sigue el flujo real del mozo, no el alfabetico, para que la matriz de
 * roles sea legible.
 */

export const PERMISSION_KEYS = [
  // --- Autenticacion y sesion ---
  'auth.login',
  'auth.login.pin',
  'auth.logout',
  'auth.refresh',

  // --- Tenancy / configuracion del local ---
  'org.read',
  'org.update',
  'venue.read',
  'venue.update',
  'device.read',
  'device.register',
  'device.revoke',

  // --- Equipo y roles ---
  'user.read',
  'user.create',
  'user.update',
  'user.deactivate',
  'user.resetPin',
  'role.read',
  'role.manage',

  // --- Catalogo ---
  'category.read',
  'category.manage',
  'product.read',
  'product.manage',
  'product.priceChange',
  'modifier.read',
  'modifier.manage',

  // --- Promociones ---
  'promotion.read',
  'promotion.manage',

  // --- Salon, mesas y reservas ---
  'floor.read',
  'floor.manage',
  'table.read',
  'table.manage',

  // --- Comandas ---
  'order.read',
  'order.open',
  'order.item.add',
  'order.item.void',
  'order.transfer',
  'order.merge',
  'order.close',
  'order.approve',

  // --- Cuenta y cobro ---
  'bill.read',
  'bill.pay',
  'bill.split',
  'bill.discount',
  'bill.reprint',

  // --- Cocina (KDS) ---
  'kitchen.read',
  'kitchen.advance',

  // --- Caja y turnos ---
  'shift.open',
  'shift.close',
  'cash.movement',
  'cash.viewExpected',

  // --- Inventario ---
  'ingredient.read',
  'ingredient.manage',
  'recipe.read',
  'recipe.manage',
  'stock.read',
  'stock.adjust',
  'stock.waste',
  'purchase.read',
  'purchase.manage',

  // --- Cliente final y fidelizacion ---
  'customer.read',
  'customer.manage',
  'loyalty.read',
  'loyalty.redeem',

  // --- Fichaje ---
  'timeEntry.read',
  'timeEntry.manage',

  // --- Finanzas y fiscal ---
  'invoice.read',
  'invoice.issue',
  'fiscal.manage',
  'finance.read',
  'costing.read',

  // --- Reportes y exportes ---
  'report.read',
  'report.export',

  // --- Integraciones ---
  'integration.read',
  'integration.manage',

  // --- Auditoria ---
  'audit.read',

  // --- Administracion de la plataforma ---
  'platform.manage',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  'auth.login': 'Iniciar sesión',
  'auth.login.pin': 'Iniciar sesión con PIN',
  'auth.logout': 'Cerrar sesión',
  'auth.refresh': 'Renovar token',

  'org.read': 'Ver la organización',
  'org.update': 'Editar la organización',
  'venue.read': 'Ver locales',
  'venue.update': 'Editar locales',
  'device.read': 'Ver dispositivos',
  'device.register': 'Registrar dispositivos',
  'device.revoke': 'Revocar dispositivos',

  'user.read': 'Ver usuarios',
  'user.create': 'Crear usuarios',
  'user.update': 'Editar usuarios',
  'user.deactivate': 'Desactivar usuarios',
  'user.resetPin': 'Restablecer PIN',
  'role.read': 'Ver roles',
  'role.manage': 'Administrar roles',

  'category.read': 'Ver categorías',
  'category.manage': 'Administrar categorías',
  'product.read': 'Ver productos',
  'product.manage': 'Administrar productos',
  'product.priceChange': 'Cambiar precios',
  'modifier.read': 'Ver modificadores',
  'modifier.manage': 'Administrar modificadores',

  'promotion.read': 'Ver promociones',
  'promotion.manage': 'Administrar promociones',

  'floor.read': 'Ver sectores',
  'floor.manage': 'Administrar sectores',
  'table.read': 'Ver mesas',
  'table.manage': 'Administrar mesas',

  'order.read': 'Ver comandas',
  'order.open': 'Abrir comanda',
  'order.item.add': 'Agregar ítems',
  'order.item.void': 'Anular ítems',
  'order.transfer': 'Transferir comanda',
  'order.merge': 'Unir comandas',
  'order.close': 'Cerrar comanda',
  'order.approve': 'Aprobar comandas del autopedido QR',

  'bill.read': 'Ver la cuenta',
  'bill.pay': 'Cobrar',
  'bill.split': 'Dividir la cuenta',
  'bill.discount': 'Aplicar descuentos',
  'bill.reprint': 'Reimprimir tickets',

  'shift.open': 'Abrir caja',
  'shift.close': 'Cerrar caja',
  'kitchen.read': 'Ver la pantalla de cocina',
  'kitchen.advance': 'Avanzar el estado de un ticket de cocina',

  'cash.movement': 'Movimientos de efectivo',
  'cash.viewExpected': 'Ver el esperado del arqueo',

  'ingredient.read': 'Ver insumos',
  'ingredient.manage': 'Administrar insumos',
  'recipe.read': 'Ver escandallos',
  'recipe.manage': 'Administrar escandallos',
  'stock.read': 'Ver stock',
  'stock.adjust': 'Ajustar stock',
  'stock.waste': 'Registrar merma',
  'purchase.read': 'Ver compras',
  'purchase.manage': 'Administrar compras',

  'customer.read': 'Ver clientes',
  'customer.manage': 'Administrar clientes',
  'loyalty.read': 'Ver fidelización',
  'loyalty.redeem': 'Canjear puntos',

  'timeEntry.read': 'Ver fichajes',
  'timeEntry.manage': 'Administrar fichajes',

  'invoice.read': 'Ver facturas',
  'invoice.issue': 'Emitir facturas',
  'fiscal.manage': 'Administrar configuración fiscal',
  'finance.read': 'Ver finanzas',
  'costing.read': 'Ver costos y márgenes',

  'report.read': 'Ver reportes',
  'report.export': 'Exportar reportes',

  'integration.read': 'Ver integraciones',
  'integration.manage': 'Administrar integraciones',

  'audit.read': 'Ver auditoría',

  'platform.manage': 'Administrar la plataforma',
};

/**
 * Patron de permiso, posiblemente con comodin final.
 * El backend lo usa para rangos ("platform.*"); la UI casi siempre pide claves
 * exactas del catalogo.
 */
export type PermissionPattern = `${string}.*` | '*' | PermissionKey;

export const PERMISSION_KEY_SET: ReadonlySet<string> = new Set<string>(PERMISSION_KEYS);

/** Namespace agrupa permisos por recurso. Se usa para pintar la UI de permisos. */
export const PERMISSION_NAMESPACES = [
  'auth',
  'org',
  'venue',
  'device',
  'user',
  'role',
  'category',
  'product',
  'modifier',
  'promotion',
  'floor',
  'table',
  'order',
  'bill',
  // La cocina es un recurso propio y no parte de `order`: el permiso decide quien
  // puede ver la pantalla de tickets y quien puede hacerlos avanzar. Mezclarlo con
  // `order.*` haria que "anular un item" ( Encargado) y "marcar un ticket listo"
  // (cualquiera que cocine) fueran la misma decision.
  'kitchen',
  'shift',
  'cash',
  'ingredient',
  'recipe',
  'stock',
  'purchase',
  'customer',
  'loyalty',
  'timeEntry',
  'invoice',
  'fiscal',
  'finance',
  'costing',
  'report',
  'integration',
  'audit',
  'platform',
] as const;

export type PermissionNamespace = (typeof PERMISSION_NAMESPACES)[number];

/** Extrae el namespace de una clave de permiso. */
export function namespaceOf(key: PermissionKey): PermissionNamespace {
  return key.split('.')[0] as PermissionNamespace;
}

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}

/**
 * Compara un permiso concedido contra un patron con comodines.
 * `granted` siempre viene de la base (una clave del catalogo), `required` puede
 * traer comodines porque lo escribe el codigo del guard.
 */
export function permissionMatches(granted: string, required: string): boolean {
  if (granted === '*') return true;
  if (required === '*') return true;
  if (required.endsWith('*')) {
    const prefix = required.slice(0, -1);
    return granted === prefix || granted.startsWith(prefix);
  }
  return granted === required;
}

/**
 * Verifica si un conjunto de permisos concedido satisface un requisito.
 * Se usa en el guard del backend y en la UI (que solo refleja).
 */
export function can(granted: readonly string[], required: string): boolean {
  return granted.some((g) => permissionMatches(g, required));
}

/** Verifica todos los requisitos (AND). */
export function canAll(granted: readonly string[], required: readonly string[]): boolean {
  return required.every((r) => can(granted, r));
}
