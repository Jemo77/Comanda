import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_ROLES,
  ERROR_CODES,
  problemDetails,
  type Device,
  type DeviceRegistration,
  type Organization,
  type Venue,
} from '@comanda/domain';
import type { Database } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { RbacService } from '../rbac/rbac.service';
import type { ResolvedDevice } from './tenancy.controller';

/**
 * Tenancy: organizaciones, locales y dispositivos.
 *
 * Todas las lecturas y escrituras pasan por el contexto de tenant que el
 * interceptor ya puso en la transaccion (`SET LOCAL app.current_org`). Por eso
 * ningun metodo de este servicio filtra por `org_id` a mano: la RLS lo hace, y
 * si el filtro manual se olvidara en uno, la base sigue siendo el filtro.
 */
@Injectable()
export class TenancyService {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  /** La organizacion de la sesion actual. */
  async getOrganization(orgId: string): Promise<Organization | null> {
    const result = await this.db.query<{
      id: string;
      name: string;
      plan: string;
      country: string;
      currency: string;
      timezone: string;
      created_at: string;
    }>(
      `SELECT id, name, plan, country, currency, timezone, created_at
        FROM organizations WHERE id = $1`,
      [orgId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      plan: row.plan as Organization['plan'],
      country: row.country,
      currency: row.currency,
      timezone: row.timezone,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async listVenues(orgId: string): Promise<Venue[]> {
    const result = await this.db.query<{
      id: string;
      org_id: string;
      name: string;
      kind: string;
      address: string | null;
      timezone: string;
      currency: string;
      active: boolean;
      created_at: string;
    }>(
      `SELECT id, org_id, name, kind, address, timezone, currency, active, created_at
       FROM venues WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      kind: row.kind as Venue['kind'],
      address: row.address,
      timezone: row.timezone,
      currency: row.currency,
      isActive: row.active,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async getVenue(orgId: string, venueId: string): Promise<Venue | null> {
    const venues = await this.listVenues(orgId);
    return venues.find((v) => v.id === venueId) ?? null;
  }

  async createVenue(
    orgId: string,
    input: {
      name: string;
      kind: string;
      address: string | null;
      timezone: string;
      currency: string;
    },
    actor: { userId: string; name: string },
  ): Promise<Venue> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO venues (org_id, name, kind, address, timezone, currency)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orgId, input.name, input.kind, input.address, input.timezone, input.currency],
    );

    const created = await this.getVenue(orgId, result.rows[0]!.id);

    await this.audit.record({
      orgId,
      actorId: actor.userId,
      actorName: actor.name,
      action: 'venue.created',
      entity: 'venue',
      entityId: created?.id ?? null,
      after: created,
    });

    if (!created) {
      throw new NotFoundException('No se pudo leer el local recien creado');
    }
    return created;
  }

  async listDevices(orgId: string, venueId?: string): Promise<Device[]> {
    const result = venueId
      ? await this.db.query(
          `SELECT * FROM devices WHERE org_id = $1 AND venue_id = $2 ORDER BY created_at`,
          [orgId, venueId],
        )
      : await this.db.query(`SELECT * FROM devices WHERE org_id = $1 ORDER BY created_at`, [orgId]);

    return result.rows.map((row) => this.toDevice(row));
  }

  /**
   * Registra un dispositivo. Queda `pending` hasta que el dueno lo aprueba.
   *
   * El estado inicial NO es `active` a proposito: un dispositivo aprobado de
   * entrada permitiria que cualquiera con la tablet del local se loguee con un
   * PIN. La aprobacion es una decision consciente.
   */
  async registerDevice(
    orgId: string,
    input: DeviceRegistration,
    actor: { userId: string; name: string },
  ): Promise<Device> {
    const existing = await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM devices WHERE org_id = $1 AND venue_id = $2 AND fingerprint = $3`,
      [orgId, input.venueId, input.fingerprint],
    );

    if (existing.rows.length > 0) {
      const found = existing.rows[0]!;
      // Un dispositivo revocado que se re-registra vuelve a `pending`: la
      // revocacion anterior no se borra, pero la nueva requiere aprobacion.
      if (found.status === 'revoked') {
        await this.db.query(
          `UPDATE devices SET status = 'pending', revoked_at = NULL, revoked_by = NULL
           WHERE id = $1`,
          [found.id],
        );
      }
      const device = await this.getDevice(orgId, found.id);
      if (!device) throw new NotFoundException('Dispositivo no encontrado');
      return device;
    }

    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO devices (org_id, venue_id, name, kind, fingerprint, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
      [orgId, input.venueId, input.name, input.kind, input.fingerprint],
    );

    const device = await this.getDevice(orgId, inserted.rows[0]!.id);

    await this.audit.record({
      orgId,
      venueId: input.venueId,
      actorId: actor.userId,
      actorName: actor.name,
      action: 'device.registered',
      entity: 'device',
      entityId: input.fingerprint,
      after: { name: input.name, kind: input.kind, status: 'pending' },
    });

    if (!device) throw new NotFoundException('Dispositivo no encontrado');
    return device;
  }

  async getDevice(orgId: string, deviceId: string): Promise<Device | null> {
    const result = await this.db.query(`SELECT * FROM devices WHERE org_id = $1 AND id = $2`, [
      orgId,
      deviceId,
    ]);
    return result.rows[0] ? this.toDevice(result.rows[0]) : null;
  }

  /**
   * Resuelve un dispositivo por huella para el POS, sin sesion.
   *
   * Delega en `auth_resolve_device_by_fingerprint`, una funcion `SECURITY DEFINER`
   * (migracion 0008). Hace falta porque todavia no hay `app.current_org` que poner y
   * `devices`, `venues` y `organizations` estan protegidas por RLS: una consulta
   * normal con el rol `comanda_app` no veria ni una fila y devolveria siempre cero
   * resultados.
   *
   * La funcion no acepta `org_id` de entrada (lo deduce de la huella), no escribe
   * nada y no devuelve credenciales. Es la misma disciplina que las del login.
   */
  async resolveDeviceForPos(fingerprint: string): Promise<ResolvedDevice | null> {
    const result = await this.db.query<{
      device_id: string;
      device_name: string;
      device_kind: string;
      device_status: string;
      venue_id: string;
      venue_name: string;
      venue_kind: string;
      org_id: string;
      org_name: string;
      currency: string;
      timezone: string;
    }>(`SELECT * FROM auth_resolve_device_by_fingerprint($1)`, [fingerprint]);

    const row = result.rows[0];
    if (!row) return null;

    return {
      device: {
        id: row.device_id,
        name: row.device_name,
        kind: row.device_kind,
        status: row.device_status,
      },
      venue: { id: row.venue_id, name: row.venue_name, kind: row.venue_kind },
      org: {
        id: row.org_id,
        name: row.org_name,
        currency: row.currency,
        timezone: row.timezone,
      },
    };
  }

  /** Aprueba un dispositivo: recien ahora puede usarse para entrar con PIN. */
  async approveDevice(
    orgId: string,
    deviceId: string,
    actor: { userId: string; name: string },
  ): Promise<Device> {
    const result = await this.db.query(
      `UPDATE devices SET status = 'active', approved_at = now(), token_version = token_version + 1
       WHERE org_id = $1 AND id = $2 AND status = 'pending'`,
      [orgId, deviceId],
    );

    if (result.rowCount === 0) {
      throw new ConflictException(
        problemDetails({
          status: 409,
          code: ERROR_CODES.CONFLICT,
          detail: 'Ese dispositivo no esta pendiente de aprobacion.',
        }),
      );
    }

    const device = await this.getDevice(orgId, deviceId);

    await this.audit.record({
      orgId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId,
      action: 'device.approved',
      entity: 'device',
      entityId: deviceId,
      before: { status: 'pending' },
      after: { status: 'active' },
    });

    if (!device) throw new NotFoundException('Dispositivo no encontrado');
    return device;
  }

  /**
   * Revoca un dispositivo.
   *
   * Exige motivo: revocar la tablet del mozo sin saber por que deja al local sin
   * cobrar en el mostrador. El motivo va al registro de auditoria.
   *
   * El `token_version` sube para que cualquier token emitido antes deje de valer,
   * y las familias de refresh quedan revocadas.
   */
  async revokeDevice(
    orgId: string,
    deviceId: string,
    reason: string,
    actor: { userId: string; name: string },
  ): Promise<Device> {
    const current = await this.getDevice(orgId, deviceId);
    if (!current) {
      throw new NotFoundException(
        problemDetails({
          status: 404,
          code: ERROR_CODES.NOT_FOUND,
          detail: 'Ese dispositivo no existe en este local.',
        }),
      );
    }

    if (current.status === 'revoked') {
      throw new ConflictException(
        problemDetails({
          status: 409,
          code: ERROR_CODES.CONFLICT,
          detail: 'Ese dispositivo ya estaba revocado.',
        }),
      );
    }

    await this.db.query(
      `UPDATE devices
       SET status = 'revoked', revoked_at = now(), revoked_by = $3, token_version = token_version + 1
       WHERE org_id = $1 AND id = $2`,
      [orgId, deviceId, actor.userId],
    );

    // Las sesiones vivas del dispositivo se cierran: si no, el acceso token ya
    // emitido seguiria sirviendo hasta expirar.
    await this.db.query(
      `UPDATE refresh_tokens
       SET revoked_at = now(), revoked_reason = 'device_revoked'
       WHERE device_id = $1 AND revoked_at IS NULL`,
      [deviceId],
    );

    const device = await this.getDevice(orgId, deviceId);

    await this.audit.record({
      orgId,
      venueId: device?.orgId ?? orgId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId,
      action: 'device.revoked',
      entity: 'device',
      entityId: deviceId,
      before: { status: current.status, name: current.name },
      after: { status: 'revoked' },
      reason,
    });

    if (!device) throw new NotFoundException('Dispositivo no encontrado');
    return device;
  }

  /**
   * Alta de una organizacion con sus roles por defecto.
   *
   * Todo en una transaccion: una organizacion sin roles deja al dueno sin poder
   * hacer nada, y un rollback parcial no lo arregla.
   *
   * El contexto de RLS se pone con `set_config` apenas existe la fila de
   * `organizations`: sin el, las policies de `roles` no dejarian insertar.
   */
  async createOrganization(params: {
    name: string;
    country: string;
    currency: string;
    timezone: string;
    plan?: string;
  }): Promise<{ org: Organization; ownerRoleId: string }> {
    return this.db.transaction(async (tx) => {
      const orgResult = await tx.query<{ id: string }>(
        `INSERT INTO organizations (name, plan, country, currency, timezone)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [params.name, params.plan ?? 'starter', params.country, params.currency, params.timezone],
      );
      const orgId = orgResult.rows[0]!.id;

      // A partir de aca ya existe una fila de organizations, asi que el contexto
      // de tenant es valido y las policies de las demas tablas lo aceptan.
      await tx.query(`SELECT set_config('app.current_org', $1, true)`, [orgId]);

      for (const role of Object.values(DEFAULT_ROLES)) {
        const roleResult = await tx.query<{ id: string }>(
          `INSERT INTO roles (org_id, key, name, description, constraints, system)
           VALUES ($1::uuid, $2, $3, $4, $5::jsonb, true) RETURNING id`,
          [orgId, role.key, role.name, role.description, JSON.stringify(role.constraints)],
        );

        for (const permission of role.permissions) {
          await tx.query(
            `INSERT INTO role_permissions (org_id, role_id, permission_key)
             VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT DO NOTHING`,
            [orgId, roleResult.rows[0]!.id, permission],
          );
        }
      }

      const ownerRole = await tx.query<{ id: string }>(
        `SELECT id FROM roles WHERE org_id = $1::uuid AND key = 'dueno'`,
        [orgId],
      );

      return {
        org: {
          id: orgId,
          name: params.name,
          plan: (params.plan ?? 'starter') as Organization['plan'],
          country: params.country,
          currency: params.currency,
          timezone: params.timezone,
          createdAt: new Date().toISOString(),
        },
        ownerRoleId: ownerRole.rows[0]!.id,
      };
    });
  }

  private toDevice(row: Record<string, unknown>): Device {
    return {
      id: row.id as string,
      orgId: row.org_id as string,
      venueId: row.venue_id as string,
      name: row.name as string,
      kind: row.kind as Device['kind'],
      status: row.status as Device['status'],
      fingerprint: row.fingerprint as string,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at as string).toISOString() : null,
      approvedAt: row.approved_at ? new Date(row.approved_at as string).toISOString() : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : null,
      createdAt: new Date(row.created_at as string).toISOString(),
    };
  }
}
