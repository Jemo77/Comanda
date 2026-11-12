import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { Observable } from 'rxjs';
import * as schema from './schema';
import type { AppEnv } from '../config/env';

/**
 * Acceso a datos.
 *
 * Tres decisiones que importan:
 *
 *  1. El pool se crea con el rol `comanda_app`, que NO es owner de las tablas y NO
 *     tiene BYPASSRLS. Si la API se conectara como owner, la RLS no serviria de
 *     nada y los tests de aislamiento probarian un falso.
 *
 *  2. `query()` es SQL parametrizado (`$1`) sobre el pool, y `transaction()` es de
 *     drizzle. La mezcla es deliberada: los servicios escriben SQL que se lee igual
 *     que en la migracion (importante cuando hay policies y joins complejos), y
 *     drizzle aporta la transaccion con el contexto de tenant ya puesto.
 *
 *  3. El contexto de tenant se setea con `SET LOCAL` DENTRO de la transaccion. Con
 *     un `SET` normal, la conexion vuelve al pool con el tenant del local anterior
 *     y la siguiente peticion de otro local leeria datos ajenos: es la fuga
 *     clasica de un multi-tenant con pool de conexiones.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  /** Cliente de drizzle. Se usa solo para abrir y cerrar transacciones. */
  readonly orm: NodePgDatabase<typeof schema>;

  /**
   * Conexion de la transaccion en curso.
   *
   * Sin esto, un servicio que consulta el pool desde adentro de una transaccion abre
   * una segunda conexion: no ve el `SET LOCAL` y las tablas de tenant responden
   * vacias en lugar de filtrar. El fallo es silencioso y dificil de rastrear, asi
   * que el contexto se propaga por AsyncLocalStorage y no por pasar el client a mano.
   */
  private readonly ambient = new AsyncLocalStorage<PoolClient>();

  constructor(env: AppEnv) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
      statement_timeout: 15_000,
      query_timeout: 20_000,
      // Una transaccion abierta con el contexto de tenant puesto no puede quedar
      // colgada: este timeout la aborta y devuelve la conexion limpia al pool.
      idle_in_transaction_session_timeout: 30_000,
    });

    this.orm = drizzle(this.pool, { schema });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Consulta parametrizada. Nunca concatena valores en el SQL.
   *
   * Si hay una transaccion abierta (el interceptor de tenant), la consulta viaja por
   * esa misma conexion y ve el contexto de RLS. Si no, usa el pool.
   *
   * Esto importa mas de lo que parece: el contexto se setea con `SET LOCAL`, que
   * vive en la **conexion**. Consultar el pool desde adentro de una transaccion
   * abre otra conexion, sin contexto, y la tabla de tenant responde vacia en lugar
   * de filtrar. Un `listVenues` que devolvia `[]` era exactamente eso.
   */
  async query<T extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const ambient = this.ambient.getStore();
    const result = ambient
      ? await ambient.query(text, params as unknown[])
      : await this.pool.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  /**
   * Ejecuta un flujo (un Observable de Nest) dentro de una transaccion con contexto.
   *
   * La transaccion se confirma cuando el flujo **termina**, no cuando el handler
   * devuelve. Cerrarla antes haria que un handler que escribe en dos pasos escribiera
   * la segunda parte fuera de la transaccion, y el rollback ya no lo desharía.
   */
  runInTenantStream<T>(ctx: TenantContext, factory: () => Observable<T>): Observable<T> {
    return new Observable<T>((subscriber) => {
      let client: PoolClient | undefined;
      let finished = false;

      const finish = async (commit: boolean): Promise<void> => {
        if (!client || finished) return;
        finished = true;
        try {
          await client.query(commit ? 'COMMIT' : 'ROLLBACK');
        } catch {
          // Si el COMMIT falla, la transicion ya esta rota; el error original del
          // handler es el que importa y sigue propagandose.
        } finally {
          client.release();
          client = undefined;
        }
      };

      void (async () => {
        client = await this.pool.connect();
        await client.query('BEGIN');
        await setTenantContext(client, ctx);

        const stream = this.ambient.run(client, factory);
        stream.subscribe({
          next: (value) => subscriber.next(value),
          error: async (error: unknown) => {
            await finish(false);
            subscriber.error(error);
          },
          complete: async () => {
            await finish(true);
            subscriber.complete();
          },
        });
      })().catch(async (error: unknown) => {
        await finish(false);
        subscriber.error(error);
      });

      // Si el cliente corta la conexion, la transaccion se aborta: el pool nunca
      // devuelve una transaccion abierta a la peticion siguiente.
      return () => {
        void finish(false);
      };
    });
  }

  /** Consulta dentro de una transaccion ya abierta (el interceptor la abrio). */
  async queryIn<T extends Record<string, unknown>>(
    client: PoolClient,
    text: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await client.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  /** Abre una transaccion, setea el contexto de tenant y ejecuta la operacion. */
  async withTenant<T>(
    ctx: TenantContext,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantContext(client, ctx);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Transaccion sin contexto de tenant (seeds, jobs de plataforma). */
  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Identidad del tenant para las politicas RLS. */
export interface TenantContext {
  orgId: string;
  venueId?: string | null;
  userId?: string | null;
  deviceId?: string | null;
}

/**
 * Setea las variables de sesion que leen las politicas RLS.
 *
 * Los nombres son parte del contrato con la base: si cambian, hay que regenerar
 * los policies. Por eso estan duplicados en la migracion y cubiertos por tests.
 */
export async function setTenantContext(client: PoolClient, ctx: TenantContext): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', ['app.current_org', ctx.orgId]);
  if (ctx.venueId) {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_venue', ctx.venueId]);
  }
  if (ctx.userId) {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user', ctx.userId]);
  }
  if (ctx.deviceId) {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_device', ctx.deviceId]);
  }
}

/**
 * Alias para el codigo que ya usaba `Database`.
 * Se mantiene como tipo de la clase, no del cliente de drizzle: los servicios
 * necesitan `query()` y `transaction()`, no el builder relacional.
 */
export type Database = DatabaseService;
