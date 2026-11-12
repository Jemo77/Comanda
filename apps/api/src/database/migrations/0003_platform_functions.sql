-- =============================================================================
-- Funciones de plataforma (SECURITY DEFINER)
--
-- Alta de organizaciones
-- ----------------------
-- El alta de un local tiene una consecuencia que surprising en Postgres: el
-- `INSERT ... RETURNING id` falla si la fila insertada no es visible para las
-- policies de SELECT, y la fila recien insertada todavia no es visible (el tenant
-- recien creado todavia no es el contexto de la sesion).
--
-- Efectivamente: `INSERT INTO organizations (...) RETURNING id` responde
-- "new row violates row-level security policy". Un INSERT sin RETURNING funciona
-- perfecto. El error dice RLS cuando en realidad es el filtro de SELECT.
--
-- De ahi que el id se genere del lado de la aplicacion (`gen_random_uuid()` en el
-- cliente), que ademas es lo correcto: el id de un tenant no deberia depender de
-- que una policy este o no activa.
--
-- Y para que el seed (y el futuro alta de un local) sean idempotentes hace falta
-- poder CONSULTAR si la organizacion ya existe. Eso es una operacion de plataforma,
-- no de tenant: el mismo criterio que `auth_lookup_*`.
-- =============================================================================

CREATE OR REPLACE FUNCTION platform_find_organization(p_tax_id text)
RETURNS TABLE (
  id uuid,
  name text,
  plan plan
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.name, o.plan
  FROM organizations o
  WHERE o.tax_id = p_tax_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION platform_find_organization(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_find_organization(text) TO comanda_app;

-- -----------------------------------------------------------------------------
-- Red de seguridad
--
-- Mismo criterio que en 0001 y 0002: una funcion con privilegios elevados tiene que
-- tener un grant explicito a `comanda_app` y nada para PUBLIC. Si alguna queda
-- abierta por descuido, el build falla.
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
    AND (p.proname LIKE 'auth_%' OR p.proname LIKE 'platform_%')
    AND (p.proacl IS NULL OR p.proacl::text LIKE '%PUBLIC%');

  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION
      'Funciones SECURITY DEFINER expuestas a PUBLIC: %. '
      'Revoke PUBLIC y grant explicito a comanda_app.', exposed;
  END IF;
END
$$;