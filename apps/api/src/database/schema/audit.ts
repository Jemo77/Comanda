import { index, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Auditoria append-only.
 *
 * La inmutabilidad NO se garantiza en el codigo, se garantiza en la base:
 *
 *  - `REVOKE UPDATE, DELETE, TRUNCATE` para `comanda_app` (ver init SQL).
 *  - trigger `BEFORE UPDATE OR DELETE` que lanza excepcion, que cubre incluso al
 *    owner de la tabla y a un administrador con acceso directo.
 *
 * El codigo solo escribe. Un `UPDATE audit_log` no compila contra el rol de la
 * aplicacion, y si alguien se equivoca de rol tampoco puede.
 *
 * `prev_hash`/`hash` encadenan los registros: si alguienInserta un registro
 * falso o borra uno del medio (por ejemplo, restaurando un dump), la cadena no
 * cierra y se detecta. Opcional en el plan, incluido aca porque retrofitearlo
 * despues con datos reales es imposible.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    venueId: uuid('venue_id'),
    /** Null en acciones del sistema (seeds, jobs) que no tienen actor humano. */
    actorId: uuid('actor_id'),
    /** Se desnormaliza el nombre para que el registro siga siendo legible si el
     *  usuario se borra: "el usuario X hizo esto" importa mas que el id. */
    actorName: varchar('actor_name', { length: 120 }),
    deviceId: uuid('device_id'),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 500 }),

    /** Clave del catalogo de `AUDIT_ACTIONS` del paquete de dominio. */
    action: varchar('action', { length: 64 }).notNull(),
    /** Tipo de entidad afectada: 'order', 'device', 'product'... */
    entity: varchar('entity', { length: 64 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }),

    /** Estado anterior y posterior, para que un cambio sea explicable sin diff externo. */
    before: jsonb('before'),
    after: jsonb('after'),
    /** Obligatorio para las acciones sensibles. */
    reason: varchar('reason', { length: 300 }),

    /** Hash del registro anterior en la misma organizacion. */
    prevHash: varchar('prev_hash', { length: 64 }),
    /** SHA-256 de (prev_hash + campos del registro). */
    hash: varchar('hash', { length: 64 }),

    /**
     * Fecha en que la recibio el servidor, distinta de `created_at`.
     * Los reportes usan esta: el reloj del dispositivo puede estar desfasado.
     */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    serverReceivedAt: timestamp('server_received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // El indice de lectura por defecto: "que paso en este local, lo mas reciente".
    index('audit_log_org_created_at_idx').on(table.orgId, table.createdAt),
    // Consulta tipica de la pantalla de auditoria: filtrar por entidad.
    index('audit_log_org_entity_idx').on(table.orgId, table.entity, table.entityId),
    index('audit_log_org_action_idx').on(table.orgId, table.action),
    // Particionado mensual futuro: se particiona por created_at, asi que el
    // indice tiene que incluir la columna de particion.
    index('audit_log_org_actor_idx').on(table.orgId, table.actorId),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
