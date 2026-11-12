import { defineConfig } from 'drizzle-kit';

/**
 * Dos conexiones con propositos distintos:
 *
 *  - `dbCredentials`: el rol `comanda_app`. Es el que usa `drizzle-kit push` y el
 *    studio, y por eso tiene que ser un rol sin privilegios de owner.
 *  - `migrationsUrl`: el rol `comanda_migrator`, que es miembro de
 *    `comanda_owner`. Las migraciones crean objetos y tienen que poder.
 */
export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? 'postgresql://comanda_app:comanda_app_dev@localhost:5432/comanda',
  },
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
  verbose: true,
  strict: true,
});
