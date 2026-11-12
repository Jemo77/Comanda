# ADR-0002 · Roles de base de datos y Row Level Security

- **Estado:** aceptada
- **Fecha:** Fase 0
- **Impacto:** es la decisión de seguridad más importante del proyecto

## Contexto

Comanda es multi-tenant: un dueño puede tener dos locales, y cada local debe ver
sólo lo suyo. Un filtro por `org_id` en el WHERE de cada consulta parece
suficiente, pero es un filtro que depende de que todas las consultas lo lleven.

La alternativa habitual es usar un solo rol de base de datos (el owner), que ve
todo. Entonces el aislamiento queda enteramente en la aplicación, y un `SELECT`
sin filtro devuelve datos de otro local.

## Decisión

Tres roles separados, y la API conecta con el que no tiene privilegios:

| Rol | Puede entrar | Puede bypassear RLS | Dueño de objetos |
| - | - | - | - |
| `comanda_owner` | no (NOLOGIN) | no | sí |
| `comanda_migrator` | sí | no | crea como owner |
| `comanda_app` | sí | **no** | **no** |

Además:

- `ENABLE ROW LEVEL SECURITY` **y** `FORCE ROW LEVEL SECURITY` en todas las
  tablas de negocio.
- El contexto de tenant se pone con `SET LOCAL` **dentro de una transacción**.
- Los tests de integración usan `comanda_app`, nunca un superusuario.

## Por qué

**El owner de una tabla ignora su propia RLS.** Con `ENABLE` solamente, las
migraciones (que corren como owner) saltarían las políticas, y un test ejecutado
con ese rol probaría un aislamiento que la API real no tiene. `FORCE` cierra eso.

**El filtro en el WHERE es una convención; la RLS es una garantía.** Una consulta
nueva sin filtro sigue devolviendo sólo lo propio. El test lo verifica
explícitamente.

**`SET LOCAL` y no `SET`.** Con `SET`, la conexión vuelve al pool con
`app.current_org` del local anterior y la siguiente petición de otro local lee
datos ajenos. Es la fuga clásica de un multi-tenant con pool de conexiones.
`SET LOCAL` vive hasta el fin de la transacción, así que el contexto se descarta
solo. Hay un test que lo comprueba en cada corrida.

**El test corre como `comanda_app`.** `createTestDatabase` falla si la conexión
tiene superusuario o `BYPASSRLS`. Sin esa comprobación, un `TEST_DATABASE_URL`
mal configurado daría verde a toda la suite sin comprobar nada.

**Política uniforme generada, no escrita a mano.** Si cada tabla nueva define su
propia policy, alguien olvida la de la tabla que acaba de agregar y los tests
siguen pasando porque prueban las viejas. Hay un `DO $$` en la migración que falla
si alguna tabla no tiene RLS.

## Consecuencias

- Todo acceso a datos con tenants pasa por `withTenant` o por una función
  `SECURITY DEFINER` acotada. No es opcional: sin contexto, las tablas de tenant
  son invisibles.
- `current_setting('app.current_org', true)` devuelve cadena vacía (no `NULL`)
  después de una transacción que usó `set_config(..., true)`. Sin `nullif`, el
  cast a `::uuid` lanza en la segunda petición del proceso. Las policies usan
  `nullif(...)` por eso.
- unas pocas operaciones ocurren **antes** de saber el tenant (login, refresh).
  Esas van por funciones `SECURITY DEFINER` muy acotadas, con `REVOKE PUBLIC` y
  una verificación en la migración que falla si alguna queda expuesta.

## Alternativas consideradas

- **Filtro por `org_id` en el WHERE:** rechazada como única defensa. Funciona
  hasta la primera consulta que lo olvide, y ese error no se ve en los tests.
- **Base de datos por tenant:** rechazada. El dueño con dos locales pagaría el doble
  de infraestructura por una garantía que la RLS ya da en una sola base, y las
  consultas entre locales (el consolidado del dueño) pasarían a ser distribuidas.
- **Vistas de seguridad por tenant:** equivalente en resultado, peor en
  mantenimiento: hay que crear una vista por tabla y reescribir todas las
  consultas.