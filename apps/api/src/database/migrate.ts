import { join } from 'node:path';
import { Pool } from 'pg';
import { loadDotEnv, loadEnv } from '../config/env';
import { runMigrations } from './migrator';
import { verifyAuditChain } from './audit-verify';

/**
 * Punto de entrada de `pnpm db:migrate`.
 *
 * Corre las migraciones pendientes y despues imprime el estado de las cadenas de
 * auditoria existentes, para que un restore de backup con registros truncos se
 * note en el log del deploy y no tres meses despues.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const env = loadEnv();
  const url = env.DATABASE_MIGRATIONS_URL ?? env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, max: 4 });

  try {
    const folder = join(__dirname, 'migrations');

    const executed = await runMigrations(pool, folder);
    if (executed.length === 0) {
      console.log('> no hay migraciones pendientes');
    } else {
      console.log(`> ${executed.length} migraciones aplicadas`);
    }

    const orgs = await pool.query<{ org_id: string }>(
      'SELECT DISTINCT org_id FROM audit_log ORDER BY org_id',
    );
    for (const { org_id: orgId } of orgs.rows) {
      const broken = await verifyAuditChain(pool, orgId);
      if (broken.length > 0) {
        console.warn(
          `> AVISO: la cadena de auditoria de ${orgId} tiene ${broken.length} registro(s) que no cierran`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Fallo la migracion:', error);
  process.exit(1);
});
