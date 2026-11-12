import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/database/database.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { loadEnv } from '../../src/config/env';
import { createTestDatabase, truncateAuditLog } from '../support/db';
import type { TestDatabase } from '../support/env';

/**
 * La policy que permite registrar intentos de login fallido sin organizacion.
 *
 * Esta policy vive fuera del `for` de tablas de tenant, y `dropPoliciesIfExist` borra
 * todas las policies de la tabla en cada deploy: si no se recreara aca, el segundo
 * deploy se la llevaria y los ataques con correos inventados dejarían de dejar
 * rastro. Justamente el ataque que hay que poder detectar.
 */
describe('audit_log: policy de intento fallido sin organizacion', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let audit: AuditService;

  beforeAll(async () => {
    harness = await createTestDatabase();
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: harness.url,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-access-secret-que-no-se-usa-fuera-de-los-tests-01',
      PIN_PEPPER: 'test-pin-pepper-de-16-chars-o-mas',
    });
    db = new DatabaseService(env);
    audit = new AuditService(db, env);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
    await truncateAuditLog(harness, '00000000-0000-0000-0000-000000000000');
    await harness.close();
  });

  it('la policy existe despues de aplicar la capa de seguridad', async () => {
    const policies = await harness.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'audit_log'`,
    );
    expect(policies.rows.map((row) => row.policyname)).toContain(
      'audit_log_unattributed_login_failed',
    );
  });

  it('registra un intento fallido sin organizacion', async () => {
    await audit.recordLoginFailed({
      orgId: null,
      email: 'nadie@ejemplo.test',
      deviceId: null,
      ip: '203.0.113.99',
      userAgent: 'vitest',
      reason: 'correo inexistente o usuario sin contrasena',
    });

    const rows = await harness.adminQuery<{ action: string; ip: string; org_id: string | null }>(
      `SELECT action, ip, org_id FROM audit_log
       WHERE action = 'auth.login.failed' AND ip = '203.0.113.99'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows.rows[0]!.org_id).toBeNull();
    expect(rows.rows[0]!.ip).toBe('203.0.113.99');
  });

  it('NO permite escribir una accion cualquiera sin organizacion', async () => {
    // Si la policy fuera mas laxa, cualquiera podria escribir registros arbitrarios en
    // el historico de auditoría sin tener sesión ni tenant.
    await expect(
      db.transaction(async (client) =>
        client.query(
          `INSERT INTO audit_log (org_id, action, entity) VALUES (NULL, 'order.voided', 'order')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('un login fallido de una organizacion conocida SI se registra', async () => {
    // Con contexto de tenant, la fila pasa por la policy normal: es un intento
    // fallido legitimo de un local que existe.
    const orgId = '11111111-1111-4111-8111-111111111111';
    await expect(
      db.withTenant({ orgId }, (client) =>
        client.query(
          `INSERT INTO audit_log (org_id, action, entity, ip)
           VALUES ($1::uuid, 'auth.login.failed', 'user', '203.0.113.7')`,
          [orgId],
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it('NO puede atribuir un login fallido a OTRA organizacion', async () => {
    // Con contexto de Luna, un INSERT que dice "este fallo fue en Orion" tiene que
    // rebotar: es la misma regla que para cualquier otro registro.
    const luna = '11111111-1111-4111-8111-111111111111';
    const orion = '22222222-2222-4222-8222-222222222222';
    await expect(
      db.withTenant({ orgId: luna }, (client) =>
        client.query(
          `INSERT INTO audit_log (org_id, action, entity)
           VALUES ($1::uuid, 'auth.login.failed', 'user')`,
          [orion],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('las filas sin organizacion no son legibles desde el rol de la aplicacion', async () => {
    // Se pueden escribir (para dejar rastro del ataque) pero no se pueden listar:
    // un atacante no debe poder leer los intentos de otros locales.
    const rows = await harness.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE org_id IS NULL`,
    );
    expect(rows.rows[0]!.n).toBe(0);
  });
});
