/**
 * Entorno de tests.
 *
 * Los tests de integracion necesitan una base real: la RLS es una funcion del
 * motor de Postgres y ningun mock la reproduce. Un SQLite en memoria o un
 * doble de test "así se vería" darian un falso verde.
 *
 * La conexion usa el rol `comanda_app`, el mismo que la API. Si los tests corrieran
 * como superusuario, la RLS se ignoraria y probarian un aislamiento que en
 * produccion no existe.
 */

export interface TestDatabase {
  /** URL de conexion del rol de aplicacion (`comanda_app`). */
  url: string;
  /** Ejecuta SQL como el rol de aplicacion. Las aserciones usan SOLO esta. */
  query: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number }>;
  /**
   * Conexion con privilegios, solo para crear y borrar fixtures.
   * Las aserciones NO la usan: si lo hicieran, la RLS se ignoraria y los tests de
   * aislamiento darian verde sin comprobar nada.
   */
  adminQuery: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number }>;
  /** Ejecuta con el contexto de tenant seteado en la misma sesion. */
  asOrg: <T>(orgId: string, fn: (q: TestDatabase['query']) => Promise<T>) => Promise<T>;
  /** Crea una organizacion con sus roles y devuelve los ids necesarios. */
  createOrg: (name?: string) => Promise<{ orgId: string; venueId: string; ownerRoleId: string }>;
  close: () => Promise<void>;
}

/**
 * Lee la configuracion de tests.
 *
 * `TEST_DATABASE_URL` permite apuntar a un PostgreSQL externo cuando no hay
 * Docker (el caso del entorno de desarrollo de esta sesion, documentado en
 * docs/ASSUMPTIONS.md). Con Docker disponible, `test/support/container.ts` levanta
 * un Testcontainers y setea la misma variable.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL no esta definida. Con Docker: se levanta sola. Sin Docker: ' +
        'apuntala a un PostgreSQL local con los roles comanda_* ya creados ' +
        '(ver infra/docker/postgres/init/01-roles.sql).',
    );
  }
  return url;
}

/** Secretos de test. Valores fijos y publicos: no hay nada que proteger aca. */
export const TEST_SECRETS = {
  JWT_ACCESS_SECRET: 'test-access-secret-que-no-se-usa-fuera-de-los-tests-01',
  PIN_PEPPER: 'test-pin-pepper-de-16-chars-o-mas',
  JWT_ISSUER: 'comanda-test',
  JWT_AUDIENCE: 'comanda-test-api',
} as const;
