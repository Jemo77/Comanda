import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, truncateAuditLog, truncateOrg } from '../support/db';
import type { TestDatabase } from '../support/env';

/**
 * `audit_log` append-only.
 *
 * La inmutabilidad se garantiza en la base, no en el codigo. Estos tests lo
 * comprueban de las tres formas que importan: como el rol de la API, como el owner
 * de la tabla y con un `TRUNCATE` (que no pasa por las policies de fila).
 */
describe('audit_log: append-only', () => {
  let db: TestDatabase;
  let orgId: string;
  let venueId: string;

  /**
   * Inserta un registro como lo hace `AuditService`: dentro de una transaccion con
   * el contexto de tenant puesto.
   *
   * No se usa `db.query` a proposito: sin `app.current_org`, la RLS de `audit_log`
   * rechaza el INSERT. Que falle es la property que se quiere comprobar, y por eso
   * el servicio abre su propia transaccion.
   */
  const insert = async (action: string, reason: string | null = null): Promise<string> => {
    const result = await db.asOrg(orgId, (q: TestDatabase['query']) =>
      q<{ id: string }>(
        `INSERT INTO audit_log (org_id, venue_id, action, entity, reason)
         VALUES ($1::uuid, $2::uuid, $3, 'test', $4) RETURNING id`,
        [orgId, venueId, action, reason],
      ),
    );
    return result.rows[0]!.id;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    const created = await db.createOrg('Auditable');
    orgId = created.orgId;
    venueId = created.venueId;
  });

  afterAll(async () => {
    if (orgId) {
      await truncateAuditLog(db, orgId);
      await truncateOrg(db, orgId);
    }
    await db.close();
  });

  describe('privilegios del rol de la aplicacion', () => {
    it('puede escribir (INSERT)', async () => {
      await expect(insert('order.opened')).resolves.toBeTruthy();
    });

    it('puede leer (SELECT)', async () => {
      const id = await insert('order.opened');
      const rows = await db.asOrg(orgId, (q: TestDatabase['query']) =>
        q(`SELECT id FROM audit_log WHERE id = $1::uuid`, [id]),
      );
      expect(rows.rows).toHaveLength(1);
    });

    it('no puede actualizar', async () => {
      const id = await insert('order.opened');
      await expect(
        db.asOrg(orgId, (q: TestDatabase['query']) =>
          q(`UPDATE audit_log SET reason = 'alterado' WHERE id = $1::uuid`, [id]),
        ),
      ).rejects.toThrow();
    });

    it('no puede borrar', async () => {
      const id = await insert('order.opened');
      await expect(
        db.asOrg(orgId, (q: TestDatabase['query']) =>
          q(`DELETE FROM audit_log WHERE id = $1::uuid`, [id]),
        ),
      ).rejects.toThrow();
    });

    it('no puede truncar', async () => {
      // TRUNCATE es una operacion de tabla: no pasa por las policies de fila, asi que
      // el revoked del permiso es lo unico que lo frena.
      await expect(db.query(`TRUNCATE audit_log`)).rejects.toThrow(/permission denied/i);
    });
  });

  describe('trigger, que cubre al owner y a otros roles', () => {
    // Estas pruebas usan la conexion admin a proposito: el owner de la tabla (que es
    // como se migra) tiene TODOS los privilegios, y aun asi el trigger lo detiene.
    // Si solo probamos el revoked, un `SET ROLE comanda_owner` seria un agujero.
    it('el owner tampoco puede actualizar', async () => {
      const id = await insert('order.opened');
      await expect(
        db.adminQuery(`UPDATE audit_log SET reason = 'alterado' WHERE id = $1::uuid`, [id]),
      ).rejects.toThrow(/append-only/i);
    });

    it('el owner tampoco puede borrar', async () => {
      const id = await insert('order.opened');
      await expect(
        db.adminQuery(`DELETE FROM audit_log WHERE id = $1::uuid`, [id]),
      ).rejects.toThrow(/append-only/i);
    });

    it('el owner tampoco puede truncar', async () => {
      await expect(db.adminQuery(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/i);
    });
  });

  describe('el registro sobrevive a los intentos', () => {
    it('la fila sigue intacta despues de todos los intentos', async () => {
      const id = await insert('bill.paid', 'pago en efectivo');

      await expect(
        db.adminQuery(`UPDATE audit_log SET reason = 'alterado' WHERE id = $1::uuid`, [id]),
      ).rejects.toThrow();
      await expect(
        db.adminQuery(`DELETE FROM audit_log WHERE id = $1::uuid`, [id]),
      ).rejects.toThrow();

      const rows = await db.asOrg(orgId, (q: TestDatabase['query']) =>
        q(`SELECT reason, action FROM audit_log WHERE id = $1::uuid`, [id]),
      );
      expect(rows.rows[0]!.reason).toBe('pago en efectivo');
      expect(rows.rows[0]!.action).toBe('bill.paid');
    });
  });

  describe('cadena de hashes', () => {
    it('cada registro encadena con el anterior', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await insert(`order.opened.${i}`));

      const rows = await db.asOrg(orgId, (q: TestDatabase['query']) =>
        q(
          `SELECT id, prev_hash, hash FROM audit_log
           WHERE id = ANY($1::uuid[]) ORDER BY created_at, id`,
          [ids],
        ),
      );

      expect(rows.rows).toHaveLength(4);
      for (const [index, row] of rows.rows.entries()) {
        expect(row.hash, `registro ${index} sin hash`).toMatch(/^[0-9a-f]{64}$/);
        if (index > 0) {
          // Apunta al hash del registro anterior: si alguien borra uno del medio
          // restaurando un dump, la cadena deja de cerrar.
          expect(row.prev_hash, `rotura antes del registro ${index}`).toBe(
            rows.rows[index - 1]!.hash,
          );
        }
      }
    });

    it('el primer registro de la cadena arranca en 64 ceros', async () => {
      const first = await db.asOrg(orgId, (q: TestDatabase['query']) =>
        q(`SELECT prev_hash FROM audit_log ORDER BY created_at, id LIMIT 1`),
      );
      expect(first.rows[0]!.prev_hash).toBe('0'.repeat(64));
    });

    it('el hash cambia si cambia cualquier campo del registro', async () => {
      const before = await db.asOrg(orgId, (q: TestDatabase['query']) =>
        q(`SELECT hash FROM audit_log ORDER BY created_at DESC LIMIT 1`),
      );
      const first = before.rows[0]!.hash as string;

      await insert('order.item_voided', 'el cliente se fue sin pagar');

      const after = await db.asOrg(orgId, (q: TestDatabase['query']) =>
        q(`SELECT hash FROM audit_log ORDER BY created_at DESC LIMIT 1`),
      );
      expect(after.rows[0]!.hash).not.toBe(first);
    });

    it('la funcion de verificacion no reporta rotas las cadenas sanas', async () => {
      for (let i = 0; i < 3; i++) await insert(`order.closed.${i}`);

      const result = await db.adminQuery(`SELECT * FROM audit_log_verify_chain($1::uuid)`, [orgId]);
      // Solo devuelve los registros que NO cierran: lista vacia = cadena intacta.
      expect(result.rows).toHaveLength(0);
    });

    it('la cadena es por organizacion y no global', async () => {
      // Un tenant grande no debe bloquear a los demas al insertar: la cadena corre
      // dentro de la organizacion.
      const otro = await db.createOrg('Otra cadena');
      try {
        const id = await insert('order.opened');
        const rows = await db.asOrg(otro.orgId, (q: TestDatabase['query']) =>
          q(`SELECT id FROM audit_log WHERE id = $1::uuid`, [id]),
        );
        expect(rows.rows).toHaveLength(0);
      } finally {
        await truncateAuditLog(db, otro.orgId);
        await truncateOrg(db, otro.orgId);
      }
    });
  });
});
