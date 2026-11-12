import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { deviceKindEnum, deviceStatusEnum, planEnum, userStatusEnum, venueKindEnum } from './enums';

/**
 * Tenancy: Organization -> Venue -> Device, y el equipo.
 *
 * Toda tabla de negocio lleva `org_id` explicito, incluso cuando se podria
 * deducir por la FK. La RLS necesita la columna para filtrar sin hacer join, y
 * un indice por `org_id` que no necesita predicado cruzado es mucho mas rapido en
 * un `sync/pull` que filtra por organizacion.
 */

const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 120 }).notNull(),
    plan: planEnum('plan').notNull().default('starter'),
    country: varchar('country', { length: 2 }).notNull().default('AR'),
    currency: varchar('currency', { length: 3 }).notNull().default('ARS'),
    timezone: varchar('timezone', { length: 64 })
      .notNull()
      .default('America/Argentina/Buenos_Aires'),
    /** Texto de la razon social que va al comprobante fiscal (Fase 2). */
    legalName: varchar('legal_name', { length: 160 }),
    taxId: varchar('tax_id', { length: 32 }),
    active: boolean('active').notNull().default(true),
    ...auditColumns,
  },
  (table) => [uniqueIndex('organizations_tax_id_key').on(table.taxId)],
);

export const venues = pgTable(
  'venues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    kind: venueKindEnum('kind').notNull().default('bar'),
    address: varchar('address', { length: 300 }),
    timezone: varchar('timezone', { length: 64 })
      .notNull()
      .default('America/Argentina/Buenos_Aires'),
    currency: varchar('currency', { length: 3 }).notNull().default('ARS'),
    /** Ajustes por local (ticket, impresoras, propinas). Fase 1 los consume. */
    settings: jsonb('settings').notNull().default({}),
    active: boolean('active').notNull().default(true),
    ...auditColumns,
  },
  (table) => [index('venues_org_id_idx').on(table.orgId)],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    kind: deviceKindEnum('kind').notNull().default('unknown'),
    status: deviceStatusEnum('status').notNull().default('pending'),
    /**
     * Huella estable del hardware (Android ID, IDFA-derived hash, MAC estable).
     * Permite reconocer el mismo dispositivo que se re-registra tras un reset, en
     * vez de acumular registros huerfanos.
     */
    fingerprint: varchar('fingerprint', { length: 255 }).notNull(),
    /** Rotacion de tokens de dispositivo; se invalida al revocar. */
    tokenVersion: integer('token_version').notNull().default(1),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    ...auditColumns,
  },
  (table) => [
    index('devices_org_id_idx').on(table.orgId),
    index('devices_venue_id_status_idx').on(table.venueId, table.status),
    // Un hardware no se registra dos veces en el mismo local.
    uniqueIndex('devices_venue_fingerprint_key').on(table.venueId, table.fingerprint),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    /** Hash argon2id. Null para usuarios que solo entran con PIN. */
    passwordHash: text('password_hash'),
    /**
     * Hash del PIN con pepper. El pepper no se guarda: vive en el gestor de
     * secretos. Sin el, un dump de la base permite probar los 10.000 PIN
     * posibles en segundos.
     */
    pinHash: text('pin_hash'),
    pinSetAt: timestamp('pin_set_at', { withTimezone: true }),
    status: userStatusEnum('status').notNull().default('active'),
    /** Numero de intentos fallidos consecutivos. Se resetea al 로그uearse. */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    // El email es unico por organizacion, no globalmente: el mismo dueño puede
    // tener dos locales con el mismo gmail y gestionarlos como tenants separados.
    uniqueIndex('users_org_email_key').on(table.orgId, table.email),
    index('users_org_id_idx').on(table.orgId),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * Clave estable. Los roles de sistema (mozo, cajero, encargado, dueno) la
     * tienen; los personalizados usan uuid. Permite que una migracion referencie
     * el rol del Cajero sin depender del id.
     */
    key: varchar('key', { length: 64 }).notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    description: text('description'),
    /** Limites no binarios, como el tope de descuento (ver `RoleConstraints`). */
    constraints: jsonb('constraints').notNull().default({}),
    system: boolean('system').notNull().default(false),
    ...auditColumns,
  },
  (table) => [uniqueIndex('roles_org_key_key').on(table.orgId, table.key)],
);

export const permissions = pgTable('permissions', {
  key: varchar('key', { length: 64 }).primaryKey(),
  description: text('description').notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: varchar('permission_key', { length: 64 })
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (table) => [uniqueIndex('role_permissions_key').on(table.roleId, table.permissionKey)],
);

/**
 * Asignacion de rol con alcance opcional por local.
 *
 * `venue_id` null significa "en todos los locales de la organizacion". Es lo que
 * necesita un dueño con varios locales, y evita duplicar la asignacion por local.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    venueId: uuid('venue_id').references(() => venues.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('user_roles_scope_key').on(table.userId, table.roleId, table.venueId),
    index('user_roles_user_id_idx').on(table.userId),
  ],
);

/**
 * Refresh tokens rotativos.
 *
 * `family_id` es lo que permite detectar robo de tokens: cuando se usa un token
 * ya rotado (el ladrón lo tiene, el usuario ya recibio el suyo), se revoca la
 * familia entera. Guardarlos en Postgres y no en Redis es deliberado (ADR-0003):
 * el estado de sesion tiene que sobrevivir a un reinicio de cache y ser auditable.
 *
 * Solo se guarda el hash del token, nunca el token.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** SHA-256 del token. Es un valor aleatorio de 256 bits, no una contrasena. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Razon de la revocacion: 'rotated', 'reuse', 'logout', 'device_revoked'. */
    revokedReason: varchar('revoked_reason', { length: 32 }),
    /** Donde se creo la sesion, para poder invalidar por origen. */
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('refresh_tokens_hash_key').on(table.tokenHash),
    index('refresh_tokens_user_id_idx').on(table.userId),
    index('refresh_tokens_family_id_idx').on(table.familyId),
    // La limpieza periodica necesita este indice: son filas ya vencidas.
    index('refresh_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  venues: many(venues),
  users: many(users),
  roles: many(roles),
}));

export const venuesRelations = relations(venues, ({ one, many }) => ({
  organization: one(organizations, { fields: [venues.orgId], references: [organizations.id] }),
  devices: many(devices),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, { fields: [users.orgId], references: [organizations.id] }),
  userRoles: many(userRoles),
  refreshTokens: many(refreshTokens),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  rolePermissions: many(rolePermissions),
  userRoles: many(userRoles),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
  venue: one(venues, { fields: [userRoles.venueId], references: [venues.id] }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
  device: one(devices, { fields: [refreshTokens.deviceId], references: [devices.id] }),
}));
