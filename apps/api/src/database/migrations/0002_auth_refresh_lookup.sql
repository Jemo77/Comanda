-- =============================================================================
-- Lookup de refresh tokens (SECURITY DEFINER)
--
-- El refresh es de las pocas operaciones que corre SIN sesion: el cliente llega con
-- el token y todavia no hay principal, asi que no hay `app.current_org` que poner y
-- la RLS de `refresh_tokens` no dejaria leer la fila.
--
-- Mismo criterio que `auth_lookup_user_by_email`: una ventana minima y explicita,
-- no una puerta trasera. Devuelve solo lo necesario para saber a que organizacion
-- pertenece la sesion; a partir de ahi, todo corre con contexto de tenant.
--
-- El indice unico de `token_hash` la hace eficiente: es una busqueda directa.
-- =============================================================================

CREATE OR REPLACE FUNCTION auth_lookup_refresh_token(p_token_hash text)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  user_id uuid,
  device_id uuid,
  family_id uuid,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT rt.id, rt.org_id, rt.user_id, rt.device_id, rt.family_id, rt.expires_at, rt.revoked_at
  FROM refresh_tokens rt
  WHERE rt.token_hash = p_token_hash
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION auth_lookup_refresh_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_refresh_token(text) TO comanda_app;

-- Red de seguridad, igual que en 0001: una funcion SECURITY DEFINER sin grant
-- explicito es inutil, y con PUBLIC por defecto es un agujero.
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
    AND (p.proacl IS NULL OR p.proacl::text LIKE '%PUBLIC%');

  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION
      'Funciones SECURITY DEFINER de auth expuestas a PUBLIC: %. '
      'Revoke PUBLIC y grant explicito a comanda_app.', exposed;
  END IF;
END
$$;