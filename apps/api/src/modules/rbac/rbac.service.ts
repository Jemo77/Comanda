import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, PERMISSION_LABELS, PERMISSION_KEYS, problemDetails } from '@comanda/domain';
import type { Database } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

/**
 * RBAC: catalogo de permisos, roles y resolucion de permisos efectivos.
 *
 * La unidad de autorizacion es la clave de permiso (`order.item.void`), no el rol.
 * Los roles son agrupadores y cada local puede crear los suyos sin esperar un
 * deploy; por eso `resolvePermissions` no lee un rol sino el conjunto de claves.
 */
@Injectable()
export class RbacService {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sincroniza el catalogo global de permisos.
   *
   * La base es lo que se consulta en cada request (es la FK de
   * `role_permissions`), asi que tiene que estar sincronizada con el paquete de
   * dominio, que es la fuente de verdad en codigo. Idempotente: se puede llamar en
   * cada arranque y en cada seed.
   */
  async syncPermissionCatalog(): Promise<number> {
    for (const key of PERMISSION_KEYS) {
      await this.db.query(
        `INSERT INTO permissions (key, description)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
        [key, PERMISSION_LABELS[key]],
      );
    }
    return PERMISSION_KEYS.length;
  }

  /**
   * Crea los roles por defecto de una organizacion, si no existen.
   *
   * Solo crea los que faltan: si el dueno edito los permisos del Cajero, una
   * segunda llamada no los pisa. Los roles de sistema se pueden editar; lo que no
   * se puede es perderlos.
   */
  async ensureDefaultRoles(
    orgId: string,
    defaults: ReadonlyArray<{
      key: string;
      name: string;
      description: string;
      permissions: readonly string[];
      constraints: Record<string, unknown>;
    }>,
  ): Promise<Map<string, string>> {
    const created = new Map<string, string>();

    for (const role of defaults) {
      const existing = await this.db.withTenant({ orgId }, (client) =>
        client.query<{ id: string }>(`SELECT id FROM roles WHERE org_id = $1::uuid AND key = $2`, [
          orgId,
          role.key,
        ]),
      );

      if (existing.rows.length > 0) {
        created.set(role.key, existing.rows[0]!.id);
        continue;
      }

      const inserted = await this.db.withTenant({ orgId }, (client) =>
        client.query<{ id: string }>(
          `INSERT INTO roles (org_id, key, name, description, constraints, system)
           VALUES ($1::uuid, $2, $3, $4, $5::jsonb, true)
           RETURNING id`,
          [orgId, role.key, role.name, role.description, JSON.stringify(role.constraints)],
        ),
      );
      const roleId = inserted.rows[0]!.id;

      for (const permission of role.permissions) {
        await this.db.withTenant({ orgId }, (client) =>
          client.query(
            `INSERT INTO role_permissions (org_id, role_id, permission_key)
             VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT DO NOTHING`,
            [orgId, roleId, permission],
          ),
        );
      }

      created.set(role.key, roleId);
    }

    return created;
  }

  /**
   * Permisos efectivos de un usuario en un local.
   *
   * Incluye las asignaciones globales (`venue_id` NULL) y las de ESE local. Una
   * asignacion a otro local no aparece nunca, que es justamente el aislamiento que
   * un Encargado de un bar no debe poder cruzar.
   */
  async resolvePermissions(orgId: string, userId: string, venueId: string): Promise<string[]> {
    const result = await this.db.withTenant({ orgId }, (client) =>
      client.query<{ permission_key: string }>(
        `SELECT DISTINCT rp.permission_key
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = $1::uuid
           AND (ur.venue_id IS NULL OR ur.venue_id = $2::uuid)
         ORDER BY rp.permission_key`,
        [userId, venueId],
      ),
    );
    return result.rows.map((row) => row.permission_key);
  }

  /** Roles (id, clave y constraints) de un usuario en un local. */
  async resolveRoles(
    orgId: string,
    userId: string,
    venueId: string,
  ): Promise<Array<{ id: string; key: string; constraints: Record<string, unknown> }>> {
    const result = await this.db.withTenant({ orgId }, (client) =>
      client.query<{ id: string; key: string; constraints: Record<string, unknown> }>(
        `SELECT r.id, r.key, r.constraints
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1::uuid
           AND (ur.venue_id IS NULL OR ur.venue_id = $2::uuid)
         ORDER BY r.key`,
        [userId, venueId],
      ),
    );
    return result.rows;
  }

  /** Asigna un rol a un usuario, global o en un local concreto. */
  async assignRole(params: {
    orgId: string;
    userId: string;
    roleId: string;
    venueId: string | null;
    grantedBy: string;
  }): Promise<void> {
    const result = await this.db.withTenant({ orgId: params.orgId }, (client) =>
      client.query(
        `INSERT INTO user_roles (org_id, user_id, role_id, venue_id, granted_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)
         ON CONFLICT DO NOTHING`,
        [params.orgId, params.userId, params.roleId, params.venueId, params.grantedBy],
      ),
    );

    if (result.rowCount === 0) {
      // La asignacion ya existia. No es un error, pero el usuario tiene que saber
      // que no cambio nada en vez de creer que si.
      throw new ConflictException(
        problemDetails({
          status: 409,
          code: ERROR_CODES.CONFLICT,
          detail: 'Ese usuario ya tiene ese rol en ese local.',
        }),
      );
    }

    await this.audit.record({
      orgId: params.orgId,
      actorId: params.grantedBy,
      action: 'role.updated',
      entity: 'user',
      entityId: params.userId,
      after: { roleId: params.roleId, venueId: params.venueId },
    });
  }

  /**
   * Lee la auditoria con los filtros de la pantalla.
   *
   * Pagina por cursor (`created_at` + `id`) y no por offset: la tabla crece de
   * forma continua, y con OFFSET la pagina 500 se vuelve cada vez mas lenta
   * porque tiene que descartar las 499 anteriores.
   */
  async listAudit(
    orgId: string,
    query: {
      action?: string;
      entity?: string;
      entityId?: string;
      actorId?: string;
      from?: string;
      to?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const limit = Math.min(query.limit ?? 50, 200);
    const conditions: string[] = ['org_id = $1::uuid'];
    const params: unknown[] = [orgId];

    const addCondition = (column: string, value: string | undefined, cast = ''): void => {
      if (value === undefined) return;
      params.push(value);
      conditions.push(`${column} = $${params.length}${cast}`);
    };

    addCondition('action', query.action);
    addCondition('entity', query.entity);
    addCondition('entity_id', query.entityId);
    addCondition('actor_id', query.actorId, '::uuid');
    addCondition('created_at >=', query.from, '::timestamptz');
    addCondition('created_at <=', query.to, '::timestamptz');

    if (query.cursor) {
      const separator = query.cursor.indexOf('|');
      if (separator > 0) {
        params.push(query.cursor.slice(0, separator));
        params.push(query.cursor.slice(separator + 1));
        // Comparacion por tupla: trae los registros mas viejos que el cursor, en
        // el mismo orden de la columna de desempate.
        conditions.push(
          `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
    }

    // `limit + 1` para saber si hay pagina siguiente sin un COUNT extra.
    params.push(limit + 1);

    const result = await this.db.withTenant({ orgId }, (client) =>
      client.query<{
        id: string;
        action: string;
        entity: string;
        entity_id: string | null;
        actor_id: string | null;
        actor_name: string | null;
        device_id: string | null;
        venue_id: string | null;
        ip: string | null;
        before: unknown;
        after: unknown;
        reason: string | null;
        created_at: string;
        hash: string | null;
      }>(
        `SELECT id, action, entity, entity_id, actor_id, actor_name, device_id,
              venue_id, ip, before, after, reason, created_at, hash
       FROM audit_log
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
        params,
      ),
    );

    const hasMore = result.rows.length > limit;
    const items = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = items[items.length - 1] as { created_at: string; id: string } | undefined;

    return {
      items,
      nextCursor: hasMore && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null,
    };
  }

  /**
   * Verifica la constraint de descuento de un rol.
   * Vive en la base (no solo en memoria) para que el limite sobreviva a un reinicio
   * y para que el seed y el codigo de aplicacionCoincidan.
   */
  async checkDiscountAllowed(
    orgId: string,
    roleIds: readonly string[],
    bps: number,
  ): Promise<string | null> {
    if (roleIds.length === 0 || bps === 0) return null;

    const result = await this.db.withTenant({ orgId }, (client) =>
      client.query<{ constraints: Record<string, unknown> }>(
        `SELECT constraints FROM roles WHERE id = ANY($1::uuid[])`,
        [[...roleIds]],
      ),
    );

    const limits = result.rows
      .map((row) => row.constraints.discountMaxBps)
      .filter((value): value is number => typeof value === 'number');

    if (limits.length === 0) {
      return 'Tu rol no puede aplicar descuentos.';
    }
    // Varios roles: el mas restrictivo gana, para que combinar roles no sirva
    // para saltarse el tope.
    const max = Math.min(...limits);
    if (bps > max) {
      return `El descuento supera el ${max / 100}% que permite tu rol.`;
    }
    return null;
  }
}
