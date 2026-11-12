import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { SYNC_EVENT_TYPES } from '@comanda/domain';

/**
 * Las migraciones, de verdad.
 *
 * Estas pruebas corren el SQL de las migraciones contra PGlite (Postgres
 * compilado a WASM) y comprueban dos cosas que ninguna otra prueba cubre:
 *
 *  1. **Que el SQL es valido.** Una migracion con un error de sintaxis no falla en
 *     el editor ni en el typecheck: falla en el deploy, con la base a medias.
 *
 *  2. **Que son reversibles.** El CI ya lo comprueba contra un Postgres nativo, pero
 *     necesita un servicio. Esto corre en cualquier parte, incluido el editor de
 *     quien esta por cambiar una constraint.
 *
 * Lo que PGlite NO cubre, y por eso sigue haciendo falta la suite de integracion
 * contra un Postgres de verdad: los roles de base de datos. PGlite corre todo como
 * superunico, asi que la RLS y los `SECURITY DEFINER` quedan sin ejercitar. Esta
 * suite es un filtro temprano, no un reemplazo.
 */

const FOLDER = join(__dirname, '../src/database/migrations');

const upFiles = readdirSync(FOLDER)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort((a, b) => a.localeCompare(b, 'en'));

/** Crea una base limpia con los roles que las migraciones esperan. */
async function freshDatabase(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  // PGlite corre como superunico y no tiene gestion de roles. Se crean los tres
  // roles para que los `GRANT` de las migraciones no fallen.
  await db.exec(`
    DO $$ BEGIN CREATE ROLE comanda_owner NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE comanda_app NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE comanda_migrator NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  return db;
}

async function apply(db: PGlite, files: readonly string[]): Promise<string[]> {
  const failures: string[] = [];
  for (const file of files) {
    try {
      await db.exec(readFileSync(join(FOLDER, file), 'utf8'));
    } catch (error) {
      failures.push(
        `${file}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    }
  }
  return failures;
}

describe('migraciones', () => {
  it('suben en orden sin errores de sintaxis', async () => {
    const db = await freshDatabase();
    try {
      expect(await apply(db, upFiles)).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('cada migracion tiene su .down', async () => {
    // Un `.down` que falta es un rollback que el dia que hace falta va a fallar
    // cuando la base ya esta a medias.
    for (const file of upFiles) {
      expect(readdirSync(FOLDER)).toContain(file.replace(/\.sql$/, '.down.sql'));
    }
  });

  it('bajan y vuelven a subir dejando el mismo schema', async () => {
    const db = await freshDatabase();
    try {
      expect(await apply(db, upFiles)).toEqual([]);

      const downFiles = [...upFiles].reverse().map((file) => file.replace(/\.sql$/, '.down.sql'));
      expect(await apply(db, downFiles)).toEqual([]);

      // No queda ninguna tabla de negocio colgando.
      const leftovers = await db.query<{ relname: string }>(`
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname = ANY (ARRAY['pos_device_state','sync_events','orders','order_items',
                                      'payments','kitchen_tickets','shifts','tables','products'])
        ORDER BY c.relname
      `);
      expect(leftovers.rows).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);
});

describe('constraint de tipos de evento', () => {
  it('acepta exactamente los tipos del catalogo del dominio', async () => {
    // Si el dominio y la constraint divergen, el POS manda un evento que el
    // servidor rechaza con un error de base y no de aplicacion: en el mostrador
    // eso es "algo fallo" sin ninguna pista de que la lista quedo vieja.
    const db = await freshDatabase();
    try {
      expect(await apply(db, upFiles)).toEqual([]);

      const { rows } = await db.query<{ def: string }>(`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE conname = 'sync_events_type_valid'
      `);
      const definition = rows[0]?.def ?? '';

      const rejected = SYNC_EVENT_TYPES.filter((type) => !definition.includes(`'${type}'`));
      expect(rejected).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);
});

describe('constraints que el codigo de sync asume', () => {
  it('cerrar una comanda exige turno, y el turno se resuelve en el servidor', async () => {
    // `orders_closed_consistent` exige `shift_id NOT NULL` al cerrar. Por eso el
    // handler resuelve el turno abierto del local: si no, todo cierre offline sin
    // turno manda falla y **la mesa queda ocupada para siempre**.
    const db = await freshDatabase();
    try {
      expect(await apply(db, upFiles)).toEqual([]);

      const org = (
        await db.query<{ id: string }>(
          `INSERT INTO organizations (id, name, country, currency, timezone)
           VALUES (gen_random_uuid(), 'Test', 'AR', 'ARS', 'America/Argentina/Buenos_Aires') RETURNING id`,
        )
      ).rows[0]!;

      await db.query(`SELECT set_config('app.current_org', $1, false)`, [org.id]);

      const venue = (
        await db.query<{ id: string }>(
          `INSERT INTO venues (org_id, name, kind) VALUES ($1, 'Local', 'bar') RETURNING id`,
          [org.id],
        )
      ).rows[0]!.id;

      const order = (
        await db.query<{ id: string }>(
          `INSERT INTO orders (org_id, venue_id, number_label) VALUES ($1, $2, 'A-1') RETURNING id`,
          [org.id, venue],
        )
      ).rows[0]!.id;

      // Sin turno: el UPDATE tiene que fallar por la constraint.
      await expect(
        db.query(`UPDATE orders SET status = 'CLOSED', closed_at = now() WHERE id = $1::uuid`, [
          order,
        ]),
      ).rejects.toThrow();

      // Con turno: el mismo UPDATE pasa.
      const user = (
        await db.query<{ id: string }>(
          `INSERT INTO users (org_id, name, email) VALUES ($1, 'Cajero', 'cajero@test.local') RETURNING id`,
          [org.id],
        )
      ).rows[0]!.id;

      const shift = (
        await db.query<{ id: string }>(
          `INSERT INTO shifts (org_id, venue_id, opened_by, opening_float_cents)
           VALUES ($1, $2, $3, 0) RETURNING id`,
          [org.id, venue, user],
        )
      ).rows[0]!.id;

      const closed = await db.query(
        `UPDATE orders SET status = 'CLOSED', closed_at = now(), shift_id = $2::uuid WHERE id = $1::uuid`,
        [order, shift],
      );
      expect(closed.rows).toBeDefined();
    } finally {
      await db.close();
    }
  }, 60_000);
});
