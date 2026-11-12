import { join } from 'node:path';
import { Pool } from 'pg';
import { loadDotEnv, loadEnv } from '../config/env';
import { runMigrations } from './migrator';

/**
 * Reset de la base de desarrollo.
 *
 * Borra el schema public y lo reconstruye desde cero. Solo para desarrollo local:
 * en staging o produccion el "down" se hace restaurando un backup, nunca con un
 * DROP SCHEMA (ver el `.down.sql` de la migracion 0000, que tiene el aviso).
 *
 * **Usa dos conexiones a proposito.** El DROP SCHEMA necesita privilegios de
 * administracion, pero las migraciones tienen que correr con `comanda_migrator`:
 * si corren con la conexion admin (superusuario), las tablas quedan_properties de
 * `postgres` en vez de `comanda_owner`, y despues ninguna FK ni GRANT entre ellas
 * funciona. Ese error aparece varias migraciones despues, en un lugar que no
 * señala la causa.
 */
export async function resetDatabase(): Promise<void> {
  loadDotEnv();
  const env = loadEnv();

  if (env.NODE_ENV === 'production') {
    throw new Error('db:reset no puede ejecutarse con NODE_ENV=production');
  }

  const adminUrl =
    process.env.DATABASE_ADMIN_URL ?? env.DATABASE_MIGRATIONS_URL ?? env.DATABASE_URL;
  const migrationsUrl = env.DATABASE_MIGRATIONS_URL ?? adminUrl;

  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const migrations = new Pool({ connectionString: migrationsUrl, max: 4 });

  try {
    console.log('> borrando schema public');
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
    await admin.query('CREATE SCHEMA public');
    await admin.query('ALTER SCHEMA public OWNER TO comanda_owner');
    await admin.query('GRANT USAGE, CREATE ON SCHEMA public TO comanda_owner');
    await admin.query('GRANT USAGE ON SCHEMA public TO comanda_app');

    const folder = join(__dirname, 'migrations');
    const applied = await runMigrations(migrations, folder);
    console.log(`> schema recreado (${applied.length} migraciones)`);
  } finally {
    await admin.end();
    await migrations.end();
  }
}

if (require.main === module) {
  resetDatabase()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Fallo el reset:', error);
      process.exit(1);
    });
}
