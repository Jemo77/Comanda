import Dexie, { type EntityTable } from 'dexie';
import type { ProductWithModifiers, TableStatus } from '@comanda/domain';
import type { PromotionRule } from '@comanda/pricing-engine';

/**
 * Replica local del POS.
 *
 * El POS tiene que funcionar sin internet: por eso la replica local no es una
 * cache sino la fuente de verdad durante el turno. El servidor es quien reconcilia.
 *
 * `id` es UUIDv7 en todas las tablas: el orden temporal del id coincide con el
 * orden de insercion, que es lo que hace que "traeme lo que cambio desde X" sea un
 * range scan en vez de un filtro.
 */

export interface LocalVenue {
  id: string;
  orgId: string;
  name: string;
  currency: string;
}

export interface LocalUser {
  id: string;
  name: string;
  /** Hash del PIN, para poder validar offline. Nunca el PIN en claro. */
  pinHash: string | null;
  roleKeys: string[];
  permissions: string[];
}

export interface LocalDevice {
  id: string;
  venueId: string;
  name: string;
  kind: string;
  fingerprint: string;
}

/**
 * Estacion de trabajo.
 *
 * Decide a que KDS o impresora va cada producto. El POS solo la lee: el ruteo es
 * del dueno, y por eso `stationId` es nullable en el producto (un producto de
 * mostrador no lo necesita).
 */
export interface LocalStation {
  id: string;
  venueId: string;
  name: string;
  kind: 'bar' | 'cocina' | 'cafe';
  printerTarget: string | null;
  sort: number;
  active: boolean;
}

export interface LocalCategory {
  id: string;
  name: string;
  sort: number;
}

/**
 * Producto de la carta, con sus grupos de modificadores ya anidados.
 *
 * La forma es exactamente `productWithModifiersSchema` del dominio: el POS no
 * reensambla el arbol con joins en memoria porque entonces el codigo que decide
 * "este producto tiene configurables" seria distinto del codigo que valido la
 * respuesta de la API.
 */
export interface LocalProduct extends ProductWithModifiers {
  categoryId: string;
  name: string;
  /** Centavos. Los importes viven en enteros en TODAS las capas, incluido el POS. */
  priceCents: number;
  taxRate: number;
  stationId: string | null;
  available: boolean;
}

/** Sector del salon. */
export interface LocalFloor {
  id: string;
  name: string;
  sort: number;
}

/**
 * Mesa del salon, con la geometria del plano.
 *
 * `x/y/w/h` son unidades de grilla, no pixeles: el mismo plano tiene que verse
 * igual en una tablet de 8" y en la pantalla de la barra.
 */
export interface LocalFloorTable {
  id: string;
  floorId: string;
  label: string;
  seats: number;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: 'rect' | 'round' | 'square';
  status: TableStatus;
  /** Cuándo se ocupó. El temporizador del mapa sale de acá. */
  occupiedSince: string | null;
  orderId: string | null;
  orderNumberLabel: string | null;
}

/** Comanda abierta. El POS puede tener varias (varias mesas abiertas). */
export interface LocalOrder {
  id: string;
  venueId: string;
  tableId: string | null;
  tableLabel: string | null;
  numberLabel: string;
  channel: 'POS' | 'QR' | 'TAKEAWAY' | 'DELIVERY';
  status: 'OPEN' | 'PEDIDO_CUENTA' | 'CLOSED' | 'CANCELLED';
  openedAt: string;
  openedBy: string;
  guests: number;
  /** Snapshot de los parametros de cobro, no del total. Ver `orderTotals()`. */
  discountCents: number;
  serviceBps: number;
}

export interface LocalOrderItemModifier {
  modifierId: string | null;
  name: string;
  priceDeltaCents: number;
}

export interface LocalOrderItem {
  id: string;
  orderId: string;
  productId: string | null;
  /** Snapshot del nombre: el catalogo puede cambiar y el ticket no. */
  name: string;
  quantity: number;
  /** Precio unitario al momento de agregar: es un snapshot, no una referencia. */
  unitPriceCents: number;
  /** Snapshot de las reglas aplicadas, para poder explicar el precio meses despues. */
  appliedRules: unknown;
  status: 'ACTIVE' | 'VOIDED';
  course: number;
  seat: number | null;
  note: string | null;
  modifiers: LocalOrderItemModifier[];
  /** Motivo de la anulacion. Obligatorio: sin el, "cuanto se descontó" no tiene respuesta. */
  voidReason: string | null;
  voidedAt: string | null;
  addedAt: string;
}

/**
 * Ticket de cocina en la replica local.
 *
 * El KDS lee de acá y no de la red: una cocina sin cable sigue sacando tickets, y
 * un ticket que se ve tarde es un plato que sale tarde.
 */
export interface LocalKitchenTicket {
  id: string;
  stationId: string;
  stationName: string;
  orderId: string;
  orderNumberLabel: string;
  tableLabel: string | null;
  status: 'NEW' | 'PREPARING' | 'READY' | 'SERVED';
  priority: number;
  createdAt: string;
  lines: LocalKitchenLine[];
}

export interface LocalKitchenLine {
  itemId: string;
  name: string;
  quantity: number;
  note: string | null;
  modifiers: string[];
  course: number;
}

/**
 * Base de la replica del POS: carta, salon, comandas locales y cocina.
 *
 * El nombre es **distinto** del de la cola del motor de sync (`comanda`), y no es
 * cosmetico: son dos bases con dos esquemas distintos, y Dexie abre la base una sola
 * vez con el primer esquema que la reclama. Con el mismo nombre, la segunda apertura
 * revienta con `Object store not found` segun cual de las dos se monte primero, y el
 * sintoma es una pantalla en blanco en el mostrador.
 *
 * La division viene del diseño: la cola y la replica se pueden reescribir por
 * completo (al cambiar de local, al cerrar sesion) sin tocar la otra. Ver la nota de
 * `SyncStorage` en `@comanda/sync-client`.
 */
export const POS_DB_NAME = import.meta.env.VITE_POS_DB_NAME ?? 'comanda-replica';

/**
 * Replica del POS.
 *
 * **No tiene `outbox`, y no es una omision.** La cola de eventos vive en la base
 * del motor de sync (`ComandaDexie`, en `data/sync.ts`) y es lo unico que manda
 * sobre ella. Declarar aca una segunda `outbox` era ademas un error que rompia el
 * arranque: el indice compuesto `[deviceId+status]` que traia el esquema viejo es
 * sintaxis de Dexie que el motor de indices de Chromium no acepta, asi que
 * `createIndex` tiraba `SyntaxError` y las dos bases no llegaban a abrir. Solo
 * nunca se habia visto porque las dos bases compartian nombre y la segunda
 * apertura no ejecutaba el upgrade.
 *
 * La regla es la misma que dice `SyncStorage`: la replica y la outbox son cosas
 * distintas, y confundirlas es como se pierde una comanda.
 */
/**
 * Refresh token de la sesion.
 *
 * Vive en su propia tabla y no en la `outbox`, que es donde estaba antes como un
 * evento de tipo `auth.refresh` con `status: 'done'`. Haciasolo para no perder el
 * token al cerrar la app, y era un error de tres formas: la outbox se vacia en cada
 * logout y al confirmar el push, la cuenta de "eventos pendientes" lo contaba si el
 * estado se desfasaba, y un token de sesion mezclado con eventos de venta es
 * exactamente el tipo de acoplamiento que hace que borrar la cola borre la sesion.
 */
export interface LocalRefreshToken {
  /** Id del usuario: hay un token por sesion iniciada. */
  userId: string;
  token: string;
}

/**
 * Regla de promo tal como la hidrata el POS.
 *
 * Es `PromotionRule` del motor (el mismo tipo que evalua el
 * servidor) mas el nombre y el local, que son lo unico que necesita
 * la pantalla para mostrarla. Replica de `price_rules` para que el
 * motor (`@comanda/pricing-engine`) corra offline. La fila se
 * escribe igual que la que guarda el servidor, y el mismo paquete
 * la evalua en los dos lados: no hay segunda implementacion del
 * Happy Hour que despues diverja.
 */
export interface LocalPriceRule extends PromotionRule {
  name: string;
  venueId: string | null;
}

export class ComandaDatabase extends Dexie {
  venues!: EntityTable<LocalVenue, 'id'>;
  users!: EntityTable<LocalUser, 'id'>;
  refreshTokens!: EntityTable<LocalRefreshToken, 'userId'>;
  devices!: EntityTable<LocalDevice, 'id'>;
  stations!: EntityTable<LocalStation, 'id'>;
  categories!: EntityTable<LocalCategory, 'id'>;
  products!: EntityTable<LocalProduct, 'id'>;
  floors!: EntityTable<LocalFloor, 'id'>;
  floorTables!: EntityTable<LocalFloorTable, 'id'>;
  orders!: EntityTable<LocalOrder, 'id'>;
  orderItems!: EntityTable<LocalOrderItem, 'id'>;
  kitchenTickets!: EntityTable<LocalKitchenTicket, 'id'>;
  priceRules!: EntityTable<LocalPriceRule, 'id'>;

  constructor() {
    super(POS_DB_NAME);

    // v1: carta y comandas. La v2 agrega salon, estaciones y cocina.
    //
    // El indice compuesto de la `outbox` que estaba en v1 se elimino. No hacia falta
    // aca (la cola es del motor de sync) y Chrome no lo acepta: Dexie traduce
    // `[deviceId+status]` a `createIndex` con un key path que el motor de indices
    // rechaza, y `createIndex` tira `SyntaxError` dentro del upgrade. Como el error
    // aparece en un `onupgradeneeded` asincronico, Dexie lo envuelve en
    // `DatabaseClosedError` y la base queda cerrada: el POS abre y muestra una
    // pantalla en blanco, sin decir por que.
    this.version(1).stores({
      venues: 'id, orgId',
      users: 'id',
      refreshTokens: 'userId',
      devices: 'id, venueId, fingerprint',
      categories: 'id, sort',
      products: 'id, categoryId, available',
      orders: 'id, venueId, status, openedAt',
      orderItems: 'id, orderId, status',
    });

    // `floorTables` y no `tables`: `tables` es un getter interno de Dexie que
    // devuelve los esquemas de la base, y declararlo pisa el getter. Dexie revienta
    // al abrir con un `db.tables.forEach is not a Function`, que es el error mas
    // confuso que se pueden ver en un POS. El mismo nombre esta descartado por
    // comentario en `ComandaDexie` de `@comanda/sync-client`.
    this.version(2).stores({
      venues: 'id, orgId',
      users: 'id',
      refreshTokens: 'userId',
      devices: 'id, venueId, fingerprint',
      stations: 'id, venueId, sort',
      categories: 'id, sort',
      products: 'id, categoryId, available, stationId',
      floors: 'id, sort',
      floorTables: 'id, floorId, status',
      orders: 'id, venueId, status, openedAt, tableId',
      orderItems: 'id, orderId, status',
      kitchenTickets: 'id, stationId, status, createdAt',
    });

    // v3: la replica de las reglas de precio para el motor offline.
    this.version(3).stores({
      venues: 'id, orgId',
      users: 'id',
      refreshTokens: 'userId',
      devices: 'id, venueId, fingerprint',
      stations: 'id, venueId, sort',
      categories: 'id, sort',
      products: 'id, categoryId, available, stationId',
      floors: 'id, sort',
      floorTables: 'id, floorId, status',
      orders: 'id, venueId, status, openedAt, tableId',
      orderItems: 'id, orderId, status',
      kitchenTickets: 'id, stationId, status, createdAt',
      priceRules: 'id, active, scope, scopeId',
    });
  }
}

export const db = new ComandaDatabase();

/** Borra la replica local. Se usa al cerrar sesion y al cambiar de local. */
export async function clearReplica(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.venues,
      db.users,
      db.refreshTokens,
      db.devices,
      db.stations,
      db.categories,
      db.products,
      db.floors,
      db.floorTables,
      db.orders,
      db.orderItems,
      db.kitchenTickets,
      db.priceRules,
    ],
    async () => {
      await Promise.all([
        db.venues.clear(),
        db.users.clear(),
        db.refreshTokens.clear(),
        db.devices.clear(),
        db.stations.clear(),
        db.categories.clear(),
        db.products.clear(),
        db.floors.clear(),
        db.floorTables.clear(),
        db.orders.clear(),
        db.orderItems.clear(),
        db.kitchenTickets.clear(),
        db.priceRules.clear(),
      ]);
    },
  );
}
