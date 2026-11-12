import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AppEnv } from '../../config/env';
import type { Database } from '../../database/database.service';
import type { RecordAuditParams } from './audit.types';

/**
 * Escritura en `audit_log`.
 *
 * `audit_log` es append-only a nivel de base (trigger + revoked), asi que este
 * servicio solo escribe y no hace falta defenderse de UPDATE ni DELETE.
 *
 * Que lo controle la base y no el codigo importa por una razon concreta: el
 * historico tiene que sobrevivir a un error de la aplicacion, a un `psql` mal
 * usado y a un dump restaurado a medias. Un trigger no se puede esquivar por
 * error.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject('DATABASE') private readonly db: Database,
    @Inject('APP_ENV') private readonly env: AppEnv,
  ) {}

  /**
   * Registra una accion.
   *
   * Se escribe en su propia transaccion con el contexto de tenant puesto, y **no
   * propaga el error**: una auditoria fallida no puede tumbar la accion de negocio
   * que la origino (el POS no puede quedarse sin poder cobrar porque no se pudo
   * escribir un log). El fallo si queda en el logger, que es donde hay que mirar
   * cuando falta un registro.
   *
   * La transaccion propia es necesaria: la RLS de `audit_log` exige que
   * `org_id` coincida con `app.current_org`. Sin este contexto, el INSERT se
   * rechazaria y no se auditaria nada.
   */
  async record(entry: RecordAuditParams): Promise<void> {
    try {
      await this.db.withTenant({ orgId: entry.orgId }, async (client) => {
        await client.query(
          `INSERT INTO audit_log (
             org_id, venue_id, actor_id, actor_name, device_id, ip, user_agent,
             action, entity, entity_id, before, after, reason
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8, $9, $10,
                     $11::jsonb, $12::jsonb, $13)`,
          [
            entry.orgId,
            entry.venueId ?? null,
            entry.actorId ?? null,
            entry.actorName ?? null,
            entry.deviceId ?? null,
            entry.ip ?? null,
            entry.userAgent ?? null,
            entry.action,
            entry.entity,
            entry.entityId ?? null,
            entry.before === undefined ? null : JSON.stringify(entry.before),
            entry.after === undefined ? null : JSON.stringify(entry.after),
            entry.reason ?? null,
          ],
        );
      });
    } catch (error) {
      this.logger.error(
        `No se pudo registrar la auditoría ${entry.action} de ${entry.entity}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Registra un intento de login fallido.
   *
   * No lleva `actor_id` porque todavia no sabemos de quien es: se registra el email
   * intentado y la IP. Es exactamente el registro que sirve para detectar un ataque
   * de fuerza bruta contra un PIN o una contrasena.
   *
   * `orgId` puede ser NULL cuando no se sabe a que organizacion pertenece el
   * intento (correo inexistente, dispositivo desconocido). Ese caso lo cubre una
   * policy de INSERT especifica y acotada: sin ella, un ataque con correos
   * inventados no dejaria ninguna rastro, que es justo lo que hay que detectar.
   */
  async recordLoginFailed(params: {
    orgId: string | null;
    email: string | null;
    deviceId: string | null;
    ip: string | null;
    userAgent: string | null;
    reason: string;
  }): Promise<void> {
    try {
      await this.db.transaction(async (client) => {
        if (params.orgId) {
          await client.query(`SELECT set_config('app.current_org', $1, true)`, [params.orgId]);
        }
        await client.query(
          `INSERT INTO audit_log (
             org_id, venue_id, actor_id, actor_name, device_id, ip, user_agent,
             action, entity, entity_id, before, after, reason
           ) VALUES ($1::uuid, null, null, null, $2::uuid, $3, $4,
                     'auth.login.failed', 'user', $5, $6::jsonb, null, $7)`,
          [
            params.orgId,
            params.deviceId,
            params.ip,
            params.userAgent,
            params.email,
            JSON.stringify({ attemptedEmail: params.email, deviceId: params.deviceId }),
            params.reason,
          ],
        );
      });
    } catch (error) {
      this.logger.error(
        `No se pudo registrar el intento fallido: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Registra el cierre de sesion.
   *
   * `scope` distingue "salir de este dispositivo" de "salir de todos": son dos
   * decisiones con consecuencias muy distintas y el registro las tiene que separar.
   */
  async recordLogout(params: {
    orgId: string;
    actorId: string;
    actorName: string;
    venueId?: string | null;
    deviceId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    sessionsClosed: number;
    scope: 'session' | 'all';
  }): Promise<void> {
    await this.record({
      orgId: params.orgId,
      venueId: params.venueId ?? null,
      actorId: params.actorId,
      actorName: params.actorName,
      deviceId: params.deviceId ?? null,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      action: params.scope === 'all' ? 'auth.logout.all' : 'auth.logout',
      entity: 'session',
      entityId: null,
      before: { sessionsClosed: params.sessionsClosed },
    });
  }

  isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}
