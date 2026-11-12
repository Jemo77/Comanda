import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/database/database.service';
import { PasswordHasher, TokenService } from '../../src/common/security/hash';
import { AuthService } from '../../src/modules/auth/auth.service';
import { RbacService } from '../../src/modules/rbac/rbac.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { TEST_SECRETS, type TestDatabase } from '../support/env';
import { createTestDatabase, truncateAuditLog } from '../support/db';
import { assignRole, seedDefaultRoles, seedDevice, seedUser } from '../support/fixtures';
import { loadEnv } from '../../src/config/env';

/**
 * Lee el `detail` de un problem+json.
 *
 * `HttpException.message` es siempre "Unauthorized Exception" cuando el payload es un
 * objeto: el texto que ve la persona esta en `getResponse().detail`. Un test que
 * mira `.message` no comprobaria nada.
 */
function detailOf(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null && 'detail' in response) {
      return String((response as { detail: string }).detail);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** Ejecuta y devuelve el `detail` del problem+json, o falla si no hubo error. */
async function detailOfRejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return detailOf(error);
  }
  throw new Error('Se esperaba un error y la promesa resolvio');
}

/**
 * Auth contra una base real.
 *
 * Los hashes son argon2 de verdad y la sesion se persiste de verdad: un doble de
 * test aca no comprobaria ni el costo de un hash mal elegido ni que la deteccion de
 * reuso de token funcione sobre los datos reales.
 */
describe('Auth: login, PIN, refresh rotativo y auditoria', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let auth: AuthService;
  let hasherRef: PasswordHasher;

  const PASSWORD = 'Comanda1234!';
  const PIN = '4821';

  const luna = { orgId: '', venueId: '' };
  const orion = { orgId: '', venueId: '' };

  const ids = {
    lunaOwner: '',
    lunaWaiter: '',
    lunaDevice: '',
    lunaDeviceRevocable: '',
    orionOwner: '',
    orionDevice: '',
  };

  beforeAll(async () => {
    harness = await createTestDatabase();

    const env = loadEnv({
      ...process.env,
      DATABASE_URL: harness.url,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: TEST_SECRETS.JWT_ACCESS_SECRET,
      PIN_PEPPER: TEST_SECRETS.PIN_PEPPER,
    });

    db = new DatabaseService(env);

    // Argon2 con parametros baratos: los tests verifican correctitud, no costo. En
    // produccion los valores vienen de la config (64MB/3 para password, 128MB/5
    // para PIN).
    const hasher = new PasswordHasher(
      TEST_SECRETS.PIN_PEPPER,
      { memoryCost: 8_192, timeCost: 1 },
      { memoryCost: 8_192, timeCost: 1 },
    );
    hasherRef = hasher;
    const tokens = new TokenService(30 * 86_400_000);

    const audit = new AuditService(db, env);
    const rbac = new RbacService(db, audit);
    auth = new AuthService(db, hasher, tokens, rbac, audit);

    await rbac.syncPermissionCatalog();

    // --- Fixture: Cafe Luna
    const lunaOrg = await harness.createOrg('Cafe Luna');
    luna.orgId = lunaOrg.orgId;
    luna.venueId = lunaOrg.venueId;

    const lunaRoles = await seedDefaultRoles(harness, luna.orgId);

    ids.lunaOwner = await seedUser(harness, {
      orgId: luna.orgId,
      name: 'Valeria',
      email: 'valeria@luna.test',
      password: { plain: PASSWORD, hasher },
      pin: { plain: PIN, hasher },
    });
    ids.lunaWaiter = await seedUser(harness, {
      orgId: luna.orgId,
      name: 'Nico',
      email: 'nico@luna.test',
      pin: { plain: '1357', hasher },
    });

    await assignRole(harness, {
      orgId: luna.orgId,
      userId: ids.lunaOwner,
      roleId: lunaRoles.get('dueno')!,
      venueId: luna.venueId,
    });
    await assignRole(harness, {
      orgId: luna.orgId,
      userId: ids.lunaWaiter,
      roleId: lunaRoles.get('mozo')!,
      venueId: luna.venueId,
    });

    ids.lunaDevice = await seedDevice(harness, {
      orgId: luna.orgId,
      venueId: luna.venueId,
      name: 'Tablet Barra',
      fingerprint: 'luna-tablet-001',
    });
    // Dispositivo aparte para el test de revocacion: revocar el compartido romperia
    // los tests que corren despues.
    ids.lunaDeviceRevocable = await seedDevice(harness, {
      orgId: luna.orgId,
      venueId: luna.venueId,
      name: 'Tablet Terraza',
      fingerprint: 'luna-tablet-terraza',
    });

    // --- Fixture: Bar Orion
    const orionOrg = await harness.createOrg('Bar Orion');
    orion.orgId = orionOrg.orgId;
    orion.venueId = orionOrg.venueId;

    const orionRoles = await seedDefaultRoles(harness, orion.orgId);
    ids.orionOwner = await seedUser(harness, {
      orgId: orion.orgId,
      name: 'Bruno',
      email: 'bruno@orion.test',
      password: { plain: PASSWORD, hasher },
    });
    await assignRole(harness, {
      orgId: orion.orgId,
      userId: ids.orionOwner,
      roleId: orionRoles.get('dueno')!,
      venueId: orion.venueId,
    });
    ids.orionDevice = await seedDevice(harness, {
      orgId: orion.orgId,
      venueId: orion.venueId,
      name: 'Tablet Mostrador',
      fingerprint: 'orion-tablet-001',
    });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
    for (const org of [luna.orgId, orion.orgId]) {
      if (!org) continue;
      await truncateAuditLog(harness, org);
      for (const table of [
        'refresh_tokens',
        'user_roles',
        'role_permissions',
        'roles',
        'users',
        'devices',
        'venues',
      ]) {
        await harness.adminQuery(`DELETE FROM ${table} WHERE org_id = $1::uuid`, [org]);
      }
      await harness.adminQuery(`DELETE FROM organizations WHERE id = $1::uuid`, [org]);
    }
    await harness.close();
  });

  describe('login con email y contrasena', () => {
    it('acepta credenciales correctas y devuelve sesion', async () => {
      const result = await auth.loginWithPassword({
        email: 'valeria@luna.test',
        password: PASSWORD,
        ip: '203.0.113.10',
        userAgent: 'vitest',
      });

      expect(result.principal.orgId).toBe(luna.orgId);
      expect(result.principal.venueId).toBe(luna.venueId);
      expect(result.principal.roleKeys).toContain('dueno');
      expect(result.refreshToken).toHaveLength(43);
      // El Dueño tiene el catalogo completo.
      expect(result.principal.permissions).toContain('platform.manage');
      expect(result.principal.permissions).toContain('bill.pay');
    });

    it('normaliza el email', async () => {
      await expect(
        auth.loginWithPassword({
          email: '  VALERIA@LUNA.TEST ',
          password: PASSWORD,
          ip: null,
          userAgent: null,
        }),
      ).resolves.toBeTruthy();
    });

    it('rechaza una contrasena incorrecta con un mensaje util', async () => {
      expect(
        await detailOfRejection(() =>
          auth.loginWithPassword({
            email: 'valeria@luna.test',
            password: 'NoEsLaCorrecta123',
            ip: null,
            userAgent: null,
          }),
        ),
      ).toMatch(/correo o la contrasena no coinciden/i);
    });

    it('un correo inexistente da el mismo mensaje que una contrasena mala', async () => {
      // Distinguir los dos casos seria un oraculo para enumerar cuentas.
      const inexistente = await detailOfRejection(() =>
        auth.loginWithPassword({
          email: 'nadie@luna.test',
          password: 'LoQueSea123!',
          ip: null,
          userAgent: null,
        }),
      );
      const malaClave = await detailOfRejection(() =>
        auth.loginWithPassword({
          email: 'valeria@luna.test',
          password: 'LoQueSea123!',
          ip: null,
          userAgent: null,
        }),
      );

      expect(inexistente).toBe(malaClave);
    });

    it('los intentos fallidos quedan auditados con la IP', async () => {
      await expect(
        auth.loginWithPassword({
          email: 'valeria@luna.test',
          password: 'Incorrecta123',
          ip: '198.51.100.77',
          userAgent: 'vitest',
        }),
      ).rejects.toThrow();

      const rows = await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q<{ action: string; reason: string; ip: string }>(
          `SELECT action, reason, ip FROM audit_log
           WHERE action = 'auth.login.failed' ORDER BY created_at DESC LIMIT 1`,
        ),
      );
      expect(rows.rows[0]!.ip).toBe('198.51.100.77');
      expect(rows.rows[0]!.reason).toContain('contrasena incorrecta');
    });

    it('bloquea la cuenta tras cinco intentos fallidos', async () => {
      // Usuario propio para este test: si se usara a la Dueña, el bloqueo
      // dejaria inservibles los tests que corren despues.
      const candado = await seedUser(harness, {
        orgId: luna.orgId,
        name: 'Candado',
        email: 'candado@luna.test',
        password: { plain: PASSWORD, hasher: hasherRef },
      });

      for (let i = 0; i < 5; i++) {
        await expect(
          auth.loginWithPassword({
            email: 'candado@luna.test',
            password: `Intento${i}123!`,
            ip: null,
            userAgent: null,
          }),
        ).rejects.toThrow();
      }

      const locked = await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q<{ locked_until: string | null }>(`SELECT locked_until FROM users WHERE id = $1::uuid`, [
          candado,
        ]),
      );
      expect(locked.rows[0]!.locked_until).toBeTruthy();
    });

    it('no acumula intentos cuando el usuario no tiene contrasena', async () => {
      // Nico solo entra con PIN: un login por contrasena contra su cuenta no es un
      // intento fallido de credencial, y no debe poder bloquearle el PIN.
      await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q(
          `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = 'nico@luna.test'`,
        ),
      );

      for (let i = 0; i < 6; i++) {
        await expect(
          auth.loginWithPassword({
            email: 'nico@luna.test',
            password: 'LoQueSea123!',
            ip: null,
            userAgent: null,
          }),
        ).rejects.toThrow();
      }

      const state = await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q<{ failed_login_count: number }>(
          `SELECT failed_login_count FROM users WHERE email = 'nico@luna.test'`,
        ),
      );
      expect(state.rows[0]!.failed_login_count).toBe(0);
    });
  });

  describe('login con PIN en dispositivo registrado', () => {
    it('acepta el PIN correcto del usuario correcto', async () => {
      const result = await auth.loginWithPin({
        deviceId: ids.lunaDevice,
        pin: PIN,
        ip: null,
        userAgent: null,
      });
      expect(result.principal.userId).toBe(ids.lunaOwner);
      expect(result.principal.roleKeys).toContain('dueno');
    });

    it('acepta el PIN de otro usuario del mismo local', async () => {
      // El PIN identifica a la persona, no a la cuenta: en un turno el mismo
      // dispositivo lo usan varios mozos.
      const result = await auth.loginWithPin({
        deviceId: ids.lunaDevice,
        pin: '1357',
        ip: null,
        userAgent: null,
      });
      expect(result.principal.userId).toBe(ids.lunaWaiter);
      expect(result.principal.roleKeys).toEqual(['mozo']);
    });

    it('el mozo puede tomar pedidos pero no cobra ni anula', async () => {
      const { principal } = await auth.loginWithPin({
        deviceId: ids.lunaDevice,
        pin: '1357',
        ip: null,
        userAgent: null,
      });
      expect(principal.permissions).toContain('order.item.add');
      expect(principal.permissions).not.toContain('bill.pay');
      expect(principal.permissions).not.toContain('order.item.void');
      // La matriz del PLAN §6.
      expect(principal.permissions).not.toContain('shift.open');
    });

    it('rechaza un PIN incorrecto', async () => {
      expect(
        await detailOfRejection(() =>
          auth.loginWithPin({ deviceId: ids.lunaDevice, pin: '0000', ip: null, userAgent: null }),
        ),
      ).toMatch(/PIN no coincide/i);
    });

    it('rechaza un dispositivo inexistente sin buscar usuarios', async () => {
      expect(
        await detailOfRejection(() =>
          auth.loginWithPin({
            deviceId: '11111111-2222-4333-8444-555555555555',
            pin: PIN,
            ip: null,
            userAgent: null,
          }),
        ),
      ).toMatch(/no esta registrado/i);
    });

    it('un dispositivo pendiente de aprobacion no deja entrar', async () => {
      const pending = await seedDevice(harness, {
        orgId: luna.orgId,
        venueId: luna.venueId,
        name: 'Tablet Nueva',
        fingerprint: 'luna-tablet-nueva',
        status: 'pending',
      });

      expect(
        await detailOfRejection(() =>
          auth.loginWithPin({ deviceId: pending, pin: PIN, ip: null, userAgent: null }),
        ),
      ).toMatch(/aun no fue aprobado/i);
    });

    it('un dispositivo revocado no deja entrar', async () => {
      await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q(`UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1::uuid`, [
          ids.lunaDeviceRevocable,
        ]),
      );

      expect(
        await detailOfRejection(() =>
          auth.loginWithPin({
            deviceId: ids.lunaDeviceRevocable,
            pin: PIN,
            ip: null,
            userAgent: null,
          }),
        ),
      ).toMatch(/revocado/i);
    });

    it('el PIN de un local no funciona en otro local', async () => {
      // El mismo PIN numerico esta en las dos organizaciones: si el servidor no
      // filtra por local, un PIN de 4 digitos seria adivinable desde cualquier
      // dispositivo del sistema entero.
      expect(
        await detailOfRejection(() =>
          auth.loginWithPin({ deviceId: ids.orionDevice, pin: PIN, ip: null, userAgent: null }),
        ),
      ).toMatch(/PIN no coincide/i);
    });
  });

  describe('refresh rotativo', () => {
    it('renueva la sesion y rota el token', async () => {
      const login = await auth.loginWithPassword({
        email: 'valeria@luna.test',
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });

      const refreshed = await auth.refresh({
        token: login.refreshToken,
        ip: null,
        userAgent: null,
      });

      expect(refreshed.refreshToken).not.toBe(login.refreshToken);
      expect(refreshed.principal.orgId).toBe(luna.orgId);

      const revoked = await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q<{ revoked_reason: string }>(
          `SELECT revoked_reason FROM refresh_tokens
           WHERE revoked_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        ),
      );
      expect(revoked.rows[0]!.revoked_reason).toBe('rotated');
    });

    it('detecta el reuso y revoca la familia completa', async () => {
      // El ladron copia el token, la Duena lo usa primero y el ladron despues. Cuando
      // llega el segundo uso, se cae la sesion de los dos: es la unica defensa
      // razonable sin firma de dispositivo.
      const login = await auth.loginWithPassword({
        email: 'valeria@luna.test',
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });

      const first = await auth.refresh({
        token: login.refreshToken,
        ip: null,
        userAgent: null,
      });

      expect(
        await detailOfRejection(() =>
          auth.refresh({ token: login.refreshToken, ip: null, userAgent: null }),
        ),
      ).toMatch(/cerro por seguridad/i);

      // El token que la Duena recibio tampoco sirve mas: cae toda la familia.
      expect(
        await detailOfRejection(() =>
          auth.refresh({ token: first.refreshToken, ip: null, userAgent: null }),
        ),
      ).toMatch(/cerro por seguridad/i);

      const reuso = await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q<{ action: string }>(
          `SELECT action FROM audit_log WHERE action = 'auth.token.reuse_detected'`,
        ),
      );
      expect(reuso.rows.length).toBeGreaterThan(0);
    });

    it('rechaza un token que no existe', async () => {
      expect(
        await detailOfRejection(() =>
          auth.refresh({ token: 'token-inventado-que-no-existe', ip: null, userAgent: null }),
        ),
      ).toMatch(/no es valida/i);
    });

    it('cierra la sesion de un dispositivo revocado al intentar renovar', async () => {
      // Dispositivo propio: el de la revocacion de arriba ya quedo revocado y este
      // test necesita poder entrar con PIN antes de revocarlo.
      const device = await seedDevice(harness, {
        orgId: luna.orgId,
        venueId: luna.venueId,
        name: 'Tablet Kiosco',
        fingerprint: 'luna-tablet-kiosco',
      });

      const login = await auth.loginWithPin({
        deviceId: device,
        pin: PIN,
        ip: null,
        userAgent: null,
      });

      await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q(`UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1::uuid`, [
          device,
        ]),
      );

      expect(
        await detailOfRejection(() =>
          auth.refresh({ token: login.refreshToken, ip: null, userAgent: null }),
        ),
      ).toMatch(/revocado/i);
    });
  });

  describe('auditoria de la sesion', () => {
    it('el login queda registrado con actor y dispositivo', async () => {
      await auth.loginWithPin({
        deviceId: ids.lunaDevice,
        pin: PIN,
        ip: '203.0.113.55',
        userAgent: 'vitest-pos',
      });

      const rows = await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q<{ action: string; actor_name: string; device_id: string; ip: string }>(
          `SELECT action, actor_name, device_id, ip
           FROM audit_log WHERE action = 'auth.login' ORDER BY created_at DESC LIMIT 1`,
        ),
      );

      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.actor_name).toBe('Valeria');
      expect(rows.rows[0]!.ip).toBe('203.0.113.55');
      expect(rows.rows[0]!.device_id).toBe(ids.lunaDevice);
    });

    it('el logout queda registrado y cierra los refresh tokens', async () => {
      const login = await auth.loginWithPassword({
        email: 'valeria@luna.test',
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });

      await auth.logout({
        userId: login.principal.userId,
        orgId: luna.orgId,
        name: 'Valeria',
        venueId: luna.venueId,
        ip: null,
        userAgent: null,
      });

      const rows = await harness.asOrg(luna.orgId, (q: TestDatabase['query']) =>
        q<{ action: string }>(
          `SELECT action FROM audit_log
           WHERE action LIKE 'auth.logout%' ORDER BY created_at DESC LIMIT 1`,
        ),
      );
      expect(rows.rows[0]!.action).toMatch(/^auth\.logout/);

      await expect(
        auth.refresh({ token: login.refreshToken, ip: null, userAgent: null }),
      ).rejects.toThrow();
    });
  });

  describe('aislamiento entre organizaciones', () => {
    it('dos locales no comparten permisos ni sesion', async () => {
      const lunaSession = await auth.loginWithPassword({
        email: 'valeria@luna.test',
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });
      const orionSession = await auth.loginWithPassword({
        email: 'bruno@orion.test',
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });

      expect(lunaSession.principal.orgId).not.toBe(orionSession.principal.orgId);
      expect(lunaSession.principal.venueId).not.toBe(orionSession.principal.venueId);
      expect(orionSession.principal.permissions).toContain('platform.manage');
      expect(orionSession.principal.permissions).not.toEqual([]);
    });

    it('un token de refresh de un local no renueva en otro', async () => {
      const lunaSession = await auth.loginWithPassword({
        email: 'valeria@luna.test',
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });

      // El refresh resuelve el local desde el token; si alguien manipulase el
      // `venue_id` del access token, la sesion seguiria apuntando al local del token.
      const refreshed = await auth.refresh({
        token: lunaSession.refreshToken,
        ip: null,
        userAgent: null,
      });
      expect(refreshed.principal.orgId).toBe(luna.orgId);
      expect(refreshed.principal.venueId).toBe(luna.venueId);
    });
  });
});
