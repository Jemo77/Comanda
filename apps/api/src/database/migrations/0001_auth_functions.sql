-- =============================================================================
-- Funciones de autenticacion (SECURITY DEFINER)
--
-- Por que existen
-- ---------------
-- El login ocurre ANTES de que exista una sesion, asi que todavia no se conoce la
-- organizacion y no hay `app.current_org` que poner. Pero `users` esta protegida
-- por RLS: una consulta normal con el rol `comanda_app` no encuentra al usuario
-- por correo y el login falla siempre.
--
-- La salida ingenua seria sacar RLS de `users`, y eso seria un agujero: cualquier
-- peticion sin sesion podria enumerar todas las cuentas de todos los locales.
--
-- La solucion es una ventana minima y explicita: funciones `SECURITY DEFINER` que
-- corren como el owner y devuelven SOLO lo que el login necesita. No son una
-- puerta trasera general: no aceptan org de entrada (la deducen ellas), no
-- devuelven datos de negocio y no permiten escribir nada.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Buscar usuario por correo
--
-- `SECURITY DEFINER` + `SET search_path`: sin esto, un usuario con permiso para
-- crear objetos podria inyectar una funcion con el mismo nombre en el path y
-- ejecutarla en lugar de esta. Es la recomendacion standard de PostgreSQL para
-- funciones con privilegios elevados.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_user_by_email(p_email text)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  name text,
  email text,
  password_hash text,
  status user_status
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- El `lower()` replica la normalizacion del login (el usuario puede escribir
  -- "Valeria@Luna.test"), sin depender de que el indice sea case-insensitive.
  SELECT u.id, u.org_id, u.name, u.email, u.password_hash, u.status
  FROM users u
  WHERE lower(u.email) = lower(trim(p_email))
  LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- Buscar dispositivo
--
-- Devuelve tambien `org_id`: es el unico camino por el que un login por PIN
-- descubre a que organizacion pertenece, y de ahi en adelante ya se puede trabajar
-- con contexto de tenant.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_lookup_device(p_device_id uuid)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  venue_id uuid,
  name text,
  status device_status,
  token_version integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT d.id, d.org_id, d.venue_id, d.name, d.status, d.token_version
  FROM devices d
  WHERE d.id = p_device_id
  LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- Candidatos a PIN de un local
--
-- Devuelve todos los usuarios con PIN del local. NO se busca por PIN: el hash es
-- salado y no se puede indexar, asi que el servidor verifica uno por uno.
--
-- Limitar por local es lo que evita que un PIN de 4 digitos sea adivinable desde
-- cualquier dispositivo de cualquier organizacion: con 4 digitos hay 10.000
-- combinaciones, y contra el sistema entero seria trivial.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_pin_candidates(p_org uuid, p_venue uuid)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  name text,
  pin_hash text,
  status user_status,
  failed_login_count integer,
  locked_until timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT u.id, u.org_id, u.name, u.pin_hash, u.status,
         u.failed_login_count, u.locked_until
  FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  WHERE u.org_id = p_org
    AND u.pin_hash IS NOT NULL
    AND u.status = 'active'
    AND (ur.venue_id IS NULL OR ur.venue_id = p_venue);
$$;

-- -----------------------------------------------------------------------------
-- Privilegios
--
-- Solo `comanda_app` puede llamarlas, y `PUBLIC` no: si quedaran abiertas,
-- cualquiera podria enumerar usuarios y hash de PIN sin pasar por el login.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION auth_lookup_user_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_device(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_pin_candidates(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_lookup_user_by_email(text) TO comanda_app;
GRANT EXECUTE ON FUNCTION auth_lookup_device(uuid) TO comanda_app;
GRANT EXECUTE ON FUNCTION auth_pin_candidates(uuid, uuid) TO comanda_app;

-- -----------------------------------------------------------------------------
-- Red de seguridad
--
-- Si alguien agrega una funcion SECURITY DEFINER nueva sin granting, este chequeo
-- falla y el build queda rojo. Una funcion con privilegios elevados y sin grant
-- seria inútil; con `PUBLIC` por defecto seria un agujero. Los dos casos son
-- errores de despliegue, no cosas para descubrir en produccion.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  exposed text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO exposed
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND p.proname LIKE 'auth_%'
    -- `proacl` con PUBLIC significa que cualquiera puede ejecutarla.
    AND (p.proacl IS NULL OR p.proacl::text LIKE '%PUBLIC%');

  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION
      'Funciones SECURITY DEFINER de auth expuestas a PUBLIC: %. '
      'Revoke PUBLIC y grant explicito a comanda_app.', exposed;
  END IF;
END
$$;