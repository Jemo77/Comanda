import type { Pool } from 'pg';

/**
 * Verificacion de la cadena de auditoria.
 *
 * Vive en una funcion de SQL (`audit_log_verify_chain`) para que una
 * investigacion se pueda hacer con psql y las mismas reglas con las que se
 * escribieron los registros. Este modulo solo la invoca y devuelve los registros
 * que no cierran: lista vacia = cadena intacta.
 */
export async function verifyAuditChain(
  pool: Pool,
  orgId: string,
): Promise<Array<{ recordId: string; expected: string; actual: string }>> {
  const result = await pool.query<{
    record_id: string;
    expected_hash: string;
    actual_hash: string;
    ok: boolean;
  }>('SELECT * FROM audit_log_verify_chain($1)', [orgId]);

  return result.rows
    .filter((row) => !row.ok)
    .map((row) => ({
      recordId: row.record_id,
      expected: row.expected_hash,
      actual: row.actual_hash,
    }));
}
