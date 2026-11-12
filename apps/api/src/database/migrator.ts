import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { applySecurityLayer } from './security-layer';

/**
 * Aplicacion de migraciones.
 *
 * Corre con `comanda_migrator`, que es miembro de `comanda_owner`: los objetos se
 * crean a nombre del owner y el rol `comanda_app` (el que usa la API, los seeds y
 * los tests) queda sujeto a RLS.
 *
 * Las migraciones son archivos .sql numerados, cada uno con su `.down.sql`. Se
 * aplican en orden lexicografico y se registran en `__comanda_migrations` con su
 * checksum, para que un archivo editado despues de aplicado se detecte en vez de
 * generar un schema distinto entre desarrollo y produccion.
 */

/** Tabla de control de migraciones. */
export const MIGRATIONS_TABLE = '__comanda_migrations';

interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: Date;
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name text PRIMARY KEY,
      checksum varchar(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readMigrationFiles(folder: string): Promise<Array<{ name: string; sql: string }>> {
  const files = await readdir(folder);
  const names = files
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    // Orden lexicografico explicito: los nombres llevan prefijo numerico, y el
    // orden por defecto de readdir no esta garantizado entre sistemas.
    .sort((a, b) => a.localeCompare(b, 'en'));

  // El `await` va dentro del map: si queda como promesa, pg recibe `undefined`
  // y falla con un error que no señala el archivo real.
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(folder, name), 'utf8') })),
  );
}

/** SHA-256 del contenido de la migracion. */
async function checksumOf(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const content = await readFile(path, 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

export async function runMigrations(pool: Pool, folder: string): Promise<string[]> {
  await ensureMigrationsTable(pool);

  const { rows } = await pool.query<AppliedMigration>(
    `SELECT name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));

  const files = await readMigrationFiles(folder);
  const executed: string[] = [];

  for (const file of files) {
    const checksum = await checksumOf(join(folder, file.name));
    const previous = applied.get(file.name);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `La migracion ${file.name} cambio despues de aplicarse (checksum ${previous} -> ${checksum}). ` +
            'No edites migraciones ya aplicadas: crea una nueva.',
        );
      }
      continue;
    }

    // Cada migracion corre en su propia transaccion: si falla, no queda aplicada
    // a medias, y la siguiente queda clara en el log.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`, [
        file.name,
        checksum,
      ]);
      await client.query('COMMIT');
      executed.push(file.name);
      console.log(`  aplicado ${file.name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      // Postgres manda la causa real en `message` de las clases nativas de node-postgres,
      // pero cuando el error viene envuelto el texto util queda en `severity`/`routine`.
      // Se imprime el objeto entero para no perder el motivo.
      const detail =
        error instanceof Error
          ? [
              `Fallo la migracion ${file.name}`,
              `  message: ${error.message}`,
              ...(error.cause
                ? [
                    `  causa: ${JSON.stringify(error.cause, Object.getOwnPropertyNames(error.cause), 2)}`,
                  ]
                : []),
            ].join('\n')
          : `Fallo la migracion ${file.name}: ${String(error)}`;

      throw new Error(detail, { cause: error });
    } finally {
      client.release();
    }
  }

  // Las policies, triggers y privileges no salen del DDL de las tablas: se
  // aplican al final, y son idempotentes para que se puedan reaplicar.
  await applySecurityLayer(pool);

  return executed;
}
