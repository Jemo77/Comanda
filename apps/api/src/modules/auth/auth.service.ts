import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ERROR_CODES, problemDetails, type SessionUser } from '@comanda/domain';
import { DatabaseService, type TenantContext } from '../../database/database.service';
import { PasswordHasher, TokenService, hashToken } from '../../common/security/hash';
import { RbacService } from '../rbac/rbac.service';
import { AuditService } from '../audit/audit.service';
import { mergeConstraints, type SessionPrincipal } from '../../common/authz/principal';

/**
 * Login, refresh y cierre de sesion.
 *
 * Dos caminos con reglas distintas a proposito:
 *
 *  - email + contrasena: para dueno y encargado, en un navegador que uno recuerda.
 *  - PIN numerico: para el mozo en la tablet. Solo funciona en dispositivos ya
 *    registrados y aprobados. La combinacion (dispositivo conocido + PIN) es la que
 *    evita que un PIN de 4 digitos sea atacable desde cualquier lado.
 *
 * Todo lo que ocurre ANTES de saber la organizacion del usuario va por las funciones
 * `auth_*` (SECURITY DEFINER), porque sin `app.current_org` la RLS no deja leer
 * nada. Todo lo que ocurre DESPUES va dentro de `withTenant`, con el contexto puesto.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject('DATABASE') private readonly db: DatabaseService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Login con email y contrasena.
   *
   * Todos los fallos responden el mismo mensaje: si el sistema distinguiera "no
   * existe ese correo" de "contrasena incorrecta", daria un oraculo para enumerar
   * cuentas.
   */
  async loginWithPassword(params: {
    email: string;
    password: string;
    deviceId?: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<SessionResult> {
    const email = params.email.trim().toLowerCase();
    const user = await this.findUserByEmail(email);

    if (!user || !user.password_hash) {
      // Se registra igual que un fallo real: un atacante que prueba correos
      // inexistentes deja el mismo rastro que uno que prueba contrasenas.
      await this.audit.recordLoginFailed({
        orgId: user?.org_id ?? null,
        email,
        deviceId: params.deviceId ?? null,
        ip: params.ip,
        userAgent: params.userAgent,
        reason: 'correo inexistente o usuario sin contrasena',
      });
      throw this.invalidCredentials();
    }

    const valid = await this.hasher.verifyPassword(user.password_hash, params.password);
    if (!valid) {
      await this.recordFailure(user, email, params, 'contrasena incorrecta');
      throw this.invalidCredentials();
    }

    this.assertActive(user.status);

    const venueId = params.deviceId
      ? await this.venueForDevice(params.deviceId, user.org_id)
      : await this.defaultVenue(user.org_id);

    if (!venueId) {
      throw this.unauthenticated('UNAUTHENTICATED', 'Esta cuenta no tiene ningun local asignado.');
    }

    await this.db.withTenant(this.ctx(user.org_id, venueId), (client) =>
      this.clearFailedLogins(client, user.id),
    );

    return this.establishSession({
      user,
      venueId,
      deviceId: params.deviceId ?? null,
      params,
      authMethod: 'password',
    });
  }

  /**
   * Login con PIN en un dispositivo registrado.
   *
   * Se verifica el dispositivo **antes** de tocar ningun hash: si esta revocado o
   * nunca fue aprobado, el intento se rechaza sin decir nada sobre el PIN.
   */
  async loginWithPin(params: {
    deviceId: string;
    pin: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<SessionResult> {
    const device = await this.lookupDevice(params.deviceId);

    if (!device) {
      await this.audit.recordLoginFailed({
        orgId: null,
        email: null,
        deviceId: params.deviceId,
        ip: params.ip,
        userAgent: params.userAgent,
        reason: 'dispositivo no registrado',
      });
      throw this.deviceProblem(
        'DEVICE_NOT_APPROVED',
        'Este dispositivo no esta registrado. Pedile al dueno que lo apruebe.',
      );
    }

    if (device.status !== 'active') {
      await this.audit.recordLoginFailed({
        orgId: device.org_id,
        email: null,
        deviceId: params.deviceId,
        ip: params.ip,
        userAgent: params.userAgent,
        reason: `dispositivo en estado ${device.status}`,
      });
      throw this.deviceProblem(
        device.status === 'revoked' ? 'DEVICE_REVOKED' : 'DEVICE_NOT_APPROVED',
        device.status === 'revoked'
          ? 'Este dispositivo fue revocado.'
          : 'Este dispositivo aun no fue aprobado por el dueno.',
      );
    }

    const candidates = await this.pinCandidates(device.org_id, device.venue_id);
    const now = new Date();

    for (const candidate of candidates) {
      // Una cuenta bloqueada ni se verifica: seguirle dando material al atacante
      // seria regalarle el tiempo de calculo de argon2.
      if (candidate.locked_until && new Date(candidate.locked_until) > now) {
        continue;
      }

      const matches = await this.hasher.verifyPin(candidate.pin_hash, params.pin, candidate.id);
      if (!matches) continue;

      await this.db.withTenant(this.ctx(device.org_id, device.venue_id), async (client) => {
        await this.clearFailedLogins(client, candidate.id);
        await client.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [device.id]);
      });

      return this.establishSession({
        user: { id: candidate.id, org_id: device.org_id, name: candidate.name },
        venueId: device.venue_id,
        deviceId: device.id,
        params,
        authMethod: 'pin',
      });
    }

    // Ningun PIN coincidio. Se incrementa el contador de TODOS los candidatos: no se
    // sabe de quien era el intento, y bloquear solo a uno dejaria al resto de
    // usuarios del local expuestos al mismo ataque.
    await this.db.withTenant(this.ctx(device.org_id, device.venue_id), async (client) => {
      for (const candidate of candidates) {
        await this.incrementFailedLogins(client, candidate.id);
      }
    });

    await this.audit.recordLoginFailed({
      orgId: device.org_id,
      email: null,
      deviceId: params.deviceId,
      ip: params.ip,
      userAgent: params.userAgent,
      reason: 'PIN incorrecto',
    });

    throw this.unauthorized('INVALID_CREDENTIALS', 'El PIN no coincide.');
  }

  /**
   * Renueva la sesion con refresh rotativo.
   *
   * Cada refresh emite un token nuevo y revoca el anterior. Si llega un token ya
   * revocado, alguien copio uno de los dos: se revoca la FAMILIA completa y se
   * fuerza un login nuevo.
   */
  async refresh(params: {
    token: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<SessionResult> {
    const hash = hashToken(params.token);

    // El refresh corre sin sesion: no hay principal todavia, asi que no hay
    // `app.current_org` y la RLS dejaria la fila invisible. La funcion devuelve la
    // org, y desde ahi todo se trabaja con contexto.
    const record = await this.db.query<{
      id: string;
      org_id: string;
      user_id: string;
      device_id: string | null;
      family_id: string;
      expires_at: string;
      revoked_at: string | null;
    }>(`SELECT * FROM auth_lookup_refresh_token($1)`, [hash]);

    const row = record.rows[0];
    if (!row) {
      throw this.unauthenticated('UNAUTHENTICATED', 'Tu sesion no es valida. Volve a entrar.');
    }

    if (row.revoked_at) {
      await this.revokeFamily(row.org_id, row.family_id, 'reuse');
      await this.audit.record({
        orgId: row.org_id,
        actorId: row.user_id,
        deviceId: row.device_id,
        ip: params.ip,
        userAgent: params.userAgent,
        action: 'auth.token.reuse_detected',
        entity: 'refresh_token',
        entityId: row.id,
        reason: 'Se uso un refresh token ya rotado; se revoco la familia completa.',
      });
      throw this.unauthorized(
        'TOKEN_REUSE_DETECTED',
        'Tu sesion se cerro por seguridad. Volve a entrar.',
      );
    }

    if (new Date(row.expires_at) <= new Date()) {
      throw this.unauthorized('TOKEN_EXPIRED', 'Tu sesion vencio. Volve a entrar.');
    }

    const venueId = row.device_id
      ? await this.venueForDevice(row.device_id, row.org_id)
      : await this.defaultVenue(row.org_id);

    if (!venueId) {
      throw this.unauthenticated('UNAUTHENTICATED', 'No hay ningun local activo para esta sesion.');
    }

    const ctx = this.ctx(row.org_id, venueId, row.user_id, row.device_id);

    // El token nuevo se genera antes de la transaccion y se devuelve por closure.
    // Declararlo en el scope del metodo y no a nivel de modulo es lo que evita que
    // dos refresh concurrentes se pisen el valor.
    const next = this.tokens.generate();

    await this.db.withTenant(ctx, async (client) => {
      // Si el dispositivo fue revocado mientras la sesion estaba viva, el refresh es
      // la oportunidad de cortar: sin esto, el atacante conserva el acceso hasta
      // que expira el access token.
      if (row.device_id) {
        const device = await client.query<{ status: string }>(
          `SELECT status FROM devices WHERE id = $1`,
          [row.device_id],
        );
        if (device.rows[0]?.status === 'revoked') {
          await client.query(
            `UPDATE refresh_tokens
             SET revoked_at = now(), revoked_reason = 'device_revoked'
             WHERE family_id = $1 AND revoked_at IS NULL`,
            [row.family_id],
          );
          throw this.unauthorized('DEVICE_REVOKED', 'Este dispositivo fue revocado.');
        }
      }

      // `last_seen_at` se actualiza en el token viejo, que es la sesion que acaba de
      // usarlo: asi "ultimo uso" no queda congelado en la creacion.
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = now(), revoked_reason = 'rotated', last_seen_at = now()
         WHERE id = $1`,
        [row.id],
      );

      await client.query(
        `INSERT INTO refresh_tokens
           (org_id, user_id, device_id, token_hash, family_id, expires_at, ip, user_agent)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8)`,
        [
          row.org_id,
          row.user_id,
          row.device_id,
          next.hash,
          row.family_id,
          new Date(Date.now() + this.tokens.getTtlMs()),
          params.ip,
          params.userAgent,
        ],
      );
    });

    const principal = await this.resolvePrincipal({
      userId: row.user_id,
      orgId: row.org_id,
      venueId,
      sessionId: '',
      authMethod: 'refresh',
      deviceId: row.device_id,
    });

    await this.audit.record({
      orgId: row.org_id,
      venueId,
      actorId: row.user_id,
      deviceId: row.device_id,
      ip: params.ip,
      userAgent: params.userAgent,
      action: 'auth.token.refreshed',
      entity: 'session',
      entityId: row.id,
    });

    return { principal, refreshToken: next.token, expiresIn: 0 };
  }

  /** Cierra todas las sesiones vivas del usuario. */
  async logout(params: {
    userId: string;
    orgId: string;
    name: string;
    venueId?: string | null;
    deviceId?: string | null;
    ip: string | null;
    userAgent: string | null;
  }): Promise<void> {
    const closed = await this.db.withTenant(
      this.ctx(params.orgId, params.venueId ?? null, params.userId),
      async (client) => {
        const result = await client.query(
          `UPDATE refresh_tokens
         SET revoked_at = now(), revoked_reason = 'logout'
         WHERE user_id = $1 AND revoked_at IS NULL`,
          [params.userId],
        );
        return result.rowCount ?? 0;
      },
    );

    await this.audit.recordLogout({
      orgId: params.orgId,
      actorId: params.userId,
      actorName: params.name,
      venueId: params.venueId ?? null,
      deviceId: params.deviceId ?? null,
      ip: params.ip,
      userAgent: params.userAgent,
      sessionsClosed: closed,
      // Mas de una sesion cerrada significa que el usuario salio de varios
      // dispositivos: es una decision distinta y el registro la distingue.
      scope: closed > 1 ? 'all' : 'session',
    });
  }

  /**
   * Reconstruye el principal de una sesion ya autenticada.
   *
   * Los permisos se resuelven contra la base en cada request, no se leen del token:
   * revocar `stock.adjust` tiene que surtir efecto en la proxima peticion, no
   * cuando expire el JWT. Ademas, resolver aca con el `venue_id` del token garantiza
   * que los permisos sean los de ESE local.
   */
  async resolvePrincipal(input: {
    userId: string;
    orgId: string;
    venueId: string;
    sessionId: string;
    authMethod: SessionPrincipal['authMethod'];
    deviceId?: string | null;
  }): Promise<SessionPrincipal> {
    const [permissions, roles, user] = await Promise.all([
      this.rbac.resolvePermissions(input.orgId, input.userId, input.venueId),
      this.rbac.resolveRoles(input.orgId, input.userId, input.venueId),
      this.userRow(input.userId, input.orgId),
    ]);

    if (!user) {
      throw this.unauthenticated('UNAUTHENTICATED', 'La cuenta de esta sesion ya no existe.');
    }
    this.assertActive(user.status);

    return {
      userId: input.userId,
      orgId: input.orgId,
      venueId: input.venueId,
      roleIds: roles.map((role) => role.id),
      roleKeys: roles.map((role) => role.key),
      permissions,
      constraints: mergeConstraints(roles.map((role) => role.constraints)),
      deviceId: input.deviceId ?? user.last_device_id ?? null,
      sessionId: input.sessionId,
      authMethod: input.authMethod,
    };
  }

  /** Nombre y email del usuario, para la respuesta de login y `/me`. */
  async userProfile(
    userId: string,
    orgId: string,
  ): Promise<{ name: string; email: string } | null> {
    const row = await this.userRow(userId, orgId);
    return row ? { name: row.name, email: row.email } : null;
  }

  /** Sesiones activas del usuario, para la pantalla "mis dispositivos". */
  async activeSessions(
    userId: string,
    orgId: string,
  ): Promise<
    Array<{
      id: string;
      deviceId: string | null;
      deviceName: string | null;
      createdAt: string;
      lastSeen: string;
    }>
  > {
    const result = await this.db.withTenant(this.ctx(orgId, null, userId), (client) =>
      client.query<{
        id: string;
        device_id: string | null;
        device_name: string | null;
        created_at: string;
        last_seen_at: string | null;
      }>(
        `SELECT rt.id, rt.device_id, d.name AS device_name, rt.created_at,
                COALESCE(rt.last_seen_at, rt.created_at) AS last_seen_at
         FROM refresh_tokens rt
         LEFT JOIN devices d ON d.id = rt.device_id
         WHERE rt.user_id = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()
         ORDER BY last_seen_at DESC`,
        [userId],
      ),
    );

    return result.rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      createdAt: new Date(row.created_at).toISOString(),
      lastSeen: new Date(row.last_seen_at ?? row.created_at).toISOString(),
    }));
  }

  // --- lookups previos al tenant (funciones SECURITY DEFINER) -----------------

  private async findUserByEmail(email: string) {
    const result = await this.db.query<{
      id: string;
      org_id: string;
      name: string;
      email: string;
      password_hash: string | null;
      status: string;
    }>(`SELECT * FROM auth_lookup_user_by_email($1)`, [email]);
    return result.rows[0] ?? null;
  }

  private async lookupDevice(deviceId: string) {
    const result = await this.db.query<{
      id: string;
      org_id: string;
      venue_id: string;
      name: string;
      status: string;
      token_version: number;
    }>(`SELECT * FROM auth_lookup_device($1)`, [deviceId]);
    return result.rows[0] ?? null;
  }

  private async pinCandidates(orgId: string, venueId: string) {
    const result = await this.db.query<{
      id: string;
      org_id: string;
      name: string;
      pin_hash: string;
      status: string;
      failed_login_count: number;
      locked_until: string | null;
    }>(`SELECT * FROM auth_pin_candidates($1::uuid, $2::uuid)`, [orgId, venueId]);
    return result.rows;
  }

  // --- helpers con contexto de tenant ----------------------------------------

  private async defaultVenue(orgId: string): Promise<string | null> {
    const result = await this.db.withTenant(this.ctx(orgId), (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM venues WHERE org_id = $1::uuid AND active ORDER BY created_at LIMIT 1`,
        [orgId],
      ),
    );
    return result.rows[0]?.id ?? null;
  }

  private async venueForDevice(deviceId: string, orgId: string): Promise<string | null> {
    const device = await this.lookupDevice(deviceId);
    if (!device || device.org_id !== orgId) return null;
    return device.venue_id;
  }

  /**
   * Fila del usuario.
   *
   * Va dentro de `withTenant`: `users` esta protegida por RLS, asi que una consulta
   * sin `app.current_org` no devolveria nada y toda sesion pareceria expirada.
   */
  private async userRow(userId: string, orgId: string) {
    const result = await this.db.withTenant(this.ctx(orgId), (client) =>
      client.query<{
        id: string;
        org_id: string;
        name: string;
        email: string;
        status: string;
        last_device_id: string | null;
      }>(
        `SELECT u.id, u.org_id, u.name, u.email, u.status,
                (SELECT rt.device_id FROM refresh_tokens rt
                 WHERE rt.user_id = u.id AND rt.revoked_at IS NULL
                 ORDER BY rt.created_at DESC LIMIT 1) AS last_device_id
         FROM users u WHERE u.id = $1`,
        [userId],
      ),
    );
    return result.rows[0] ?? null;
  }

  private ctx(
    orgId: string,
    venueId: string | null = null,
    userId: string | null = null,
    deviceId: string | null = null,
  ): TenantContext {
    return { orgId, venueId, userId, deviceId };
  }

  /**
   * Bloqueo por intentos fallidos: 5 intentos, 15 minutos de espera.
   *
   * Agresivo a proposito: un mozo que se equivoca tres veces sigue entrando, y un
   * atacante automatizado se frena antes de probar una fraccion del espacio.
   */
  private async incrementFailedLogins(client: PoolLike, userId: string): Promise<void> {
    await client.query(
      `UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes'
             ELSE locked_until
           END
       WHERE id = $1`,
      [userId],
    );
  }

  private async clearFailedLogins(client: PoolLike, userId: string): Promise<void> {
    await client.query(
      `UPDATE users
       SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
       WHERE id = $1`,
      [userId],
    );
  }

  private async revokeFamily(orgId: string, familyId: string, reason: string): Promise<void> {
    await this.db.withTenant(this.ctx(orgId), (client) =>
      client.query(
        `UPDATE refresh_tokens
         SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $2
         WHERE family_id = $1::uuid`,
        [familyId, reason],
      ),
    );
  }

  private async recordFailure(
    user: { id: string; org_id: string },
    email: string,
    params: { deviceId?: string; ip: string | null; userAgent: string | null },
    reason: string,
  ): Promise<void> {
    await this.db.withTenant(this.ctx(user.org_id), (client) =>
      this.incrementFailedLogins(client, user.id),
    );
    await this.audit.recordLoginFailed({
      orgId: user.org_id,
      email,
      deviceId: params.deviceId ?? null,
      ip: params.ip,
      userAgent: params.userAgent,
      reason,
    });
  }

  // --- sesion ----------------------------------------------------------------

  private async establishSession(params: {
    user: { id: string; org_id: string; name: string };
    venueId: string;
    deviceId: string | null;
    params: { ip: string | null; userAgent: string | null };
    authMethod: 'password' | 'pin';
  }): Promise<SessionResult> {
    const principal = await this.resolvePrincipal({
      userId: params.user.id,
      orgId: params.user.org_id,
      venueId: params.venueId,
      sessionId: '',
      authMethod: params.authMethod,
      deviceId: params.deviceId,
    });

    const refresh = this.tokens.generate();
    await this.db.withTenant(
      this.ctx(params.user.org_id, params.venueId, params.user.id, params.deviceId),
      (client) =>
        client.query(
          `INSERT INTO refresh_tokens
           (org_id, user_id, device_id, token_hash, family_id, expires_at, ip, user_agent)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, gen_random_uuid(), $5, $6, $7)`,
          [
            params.user.org_id,
            params.user.id,
            params.deviceId,
            refresh.hash,
            new Date(Date.now() + this.tokens.getTtlMs()),
            params.params.ip,
            params.params.userAgent,
          ],
        ),
    );

    await this.audit.record({
      orgId: params.user.org_id,
      venueId: params.venueId,
      actorId: params.user.id,
      actorName: params.user.name,
      deviceId: params.deviceId,
      ip: params.params.ip,
      userAgent: params.params.userAgent,
      action: 'auth.login',
      entity: 'session',
      entityId: null,
      after: { method: params.authMethod, venueId: params.venueId },
    });

    return { principal, refreshToken: refresh.token, expiresIn: 0 };
  }

  private assertActive(status: string): void {
    if (status !== 'active') {
      throw this.unauthenticated('UNAUTHENTICATED', INACTIVE_ACCOUNT);
    }
  }

  private unauthorized(code: ErrorCode, detail: string): UnauthorizedException {
    return new UnauthorizedException(problemDetails({ status: 401, code, detail }));
  }

  private unauthenticated(code: ErrorCode, detail: string): UnauthorizedException {
    return this.unauthorized(code, detail);
  }

  /**
   * Un solo mensaje para todos los fallos de credenciales: distinguir "el correo
   * no existe" de "la contrasena esta mal" seria un oraculo para enumerar cuentas.
   */
  private invalidCredentials(): UnauthorizedException {
    return this.unauthorized('INVALID_CREDENTIALS', 'El correo o la contrasena no coinciden.');
  }

  private deviceProblem(code: 'DEVICE_NOT_APPROVED' | 'DEVICE_REVOKED', detail: string) {
    return new UnauthorizedException(problemDetails({ status: 401, code, detail }));
  }

  toSessionUser(principal: SessionPrincipal, name: string, email: string): SessionUser {
    return {
      id: principal.userId,
      name,
      email,
      orgId: principal.orgId,
      venueId: principal.venueId,
      roleKeys: principal.roleKeys,
      permissions: principal.permissions,
      constraints: principal.constraints,
      deviceId: principal.deviceId,
    };
  }
}

/** Cliente de pg dentro de una transaccion abierta. */
interface PoolLike {
  query: <T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface SessionResult {
  principal: SessionPrincipal;
  refreshToken: string;
  /** Lo completa el controller al firmar el access token. */
  expiresIn: number;
}

type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Mensaje unico de cuenta desactivada, para que no cambie entre pantallas. */
const INACTIVE_ACCOUNT = 'Esta cuenta esta desactivada. Habla con el dueno del local.';
