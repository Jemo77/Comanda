-- Roles de base de datos para Comanda (SOLO desarrollo local).
--
-- Modelo de seguridad (ver docs/adr/0002-rls-y-roles.md):
--   comanda_owner    -> dueno de los objetos. NOLOGIN: nadie se conecta como el.
--   comanda_migrator -> corre migraciones. Es miembro de comanda_owner, asi que
--                       los objetos quedan a nombre del owner.
--   comanda_app      -> rol con el que corre la API, los seeds y los tests.
--                       NO es miembro del owner, no es owner de ninguna tabla y no
--                       tiene BYPASSRLS: esta sujeto a RLS de verdad.
--
-- Si la API se conectara como owner o como superusuario, el RLS no serviria de nada.
-- Por eso la separacion es explicita y el app role solo recibe DML.
--
-- Las contrasenas de abajo son de desarrollo. En staging/produccion se inyectan por
-- variable de entorno o por el gestor de secretos: nunca en el repo.
--
-- Este archivo corre UNA VEZ por base (docker-entrypoint-initdb.d lo ejecuta contra
-- la base de Comanda). Si se corre a mano, apuntarlo a la base correcta:
--   psql -d comanda -f 01-roles.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'comanda_owner') THEN
    CREATE ROLE comanda_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'comanda_migrator') THEN
    CREATE ROLE comanda_migrator LOGIN PASSWORD 'comanda_migrator_dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'comanda_app') THEN
    CREATE ROLE comanda_app LOGIN PASSWORD 'comanda_app_dev';
  END IF;
END
$$;

ALTER ROLE comanda_owner NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- comanda_migrator SÍ tiene BYPASSRLS, y es a proposito.
--
-- Descubierto implementando la Fase 1: crear una FK desde una tabla nueva hacia una
-- tabla que ya tiene FORCE RLS exige que el rol vea las filas de esa tabla. Con el
-- migrador sujeto a RLS, `REFERENCES venues(id)` falla con "permission denied for
-- table venues" y la migración no puede aplicarse.
--
-- La asimetría es correcta: migrar exige privilegios de esquema, y solo lo hace el
-- proceso de deploy. El rol que corre la aplicación NUNCA los tiene.
ALTER ROLE comanda_migrator NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE comanda_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- El migrator puede crear objetos, pero a nombre del owner.
GRANT comanda_owner TO comanda_migrator;

-- El app role NO es miembro del owner. La linea existe para dejar el invariante
-- explicito y fallar ruidosamente si alguien la cambia.
REVOKE comanda_owner FROM comanda_app;

-- `current_database()` no se puede usar como expression en `GRANT ... ON DATABASE`
-- ni en `ALTER DATABASE`: son sintaxis de comando y no aceptan una funcion. La
-- forma correcta en psql es generar la sentencia y ejecutarla con `\gexec`.
--
-- La alternativa seria `:"dbname"`, pero la imagen de Postgres invoca los scripts
-- de init con `psql --dbname` SIN definir esa variable, asi que fallaria.
SELECT format('GRANT CONNECT ON DATABASE %I TO comanda_app, comanda_migrator', current_database())
\gexec

-- PG15+ el schema public le pertenece a pg_database_owner (el owner de la base),
-- no a un rol concreto, y ya no concede CREATE a PUBLIC. Sin esto, el migrator
-- no puede crear ni la primera tabla.
ALTER SCHEMA public OWNER TO comanda_owner;
GRANT USAGE, CREATE ON SCHEMA public TO comanda_owner;
GRANT USAGE ON SCHEMA public TO comanda_app;

-- pgcrypto, que usa el trigger de la cadena de auditoria. Sin esto el migrator
-- no puede instalarla, porque CREATE EXTENSION requiere CREATE sobre la base.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- En PG15+ los objetos por defecto (todo lo de pg_catalog) pertenecen al owner de
-- la base, que ya no es comanda_owner. Sin moverlo, el migrator no puede crear
-- objetos que HEREDEN de esos, como las tablas con identity.
SELECT format('ALTER DATABASE %I OWNER TO comanda_owner', current_database())
\gexec

-- Defaults para que toda tabla futura sea usable por la API sin tocar el DDL.
ALTER DEFAULT PRIVILEGES FOR ROLE comanda_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO comanda_app;
ALTER DEFAULT PRIVILEGES FOR ROLE comanda_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO comanda_app;