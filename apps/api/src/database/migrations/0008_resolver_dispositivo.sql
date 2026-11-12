-- =============================================================================
-- Comanda · Fase 1: resolución de dispositivo sin sesión
--
-- Por qué existe
-- --------------
-- El POS necesita saber si está autorizado ANTES de tener credenciales, y
-- `GET /devices` exige sesión. Sin esta función el aparato nunca llega a la
-- pantalla de PIN: el POS no puede entrar nunca.
--
-- La consulta tiene que cruzar `devices` → `venues` → `organizations`, y las tres
-- tablas están protegidas por RLS con `app.current_org`. Sin contexto de tenant
-- (que en este punto no existe) la RLS no deja ver ni una fila, y la consulta
-- devuelve cero resultados siempre.
--
-- Por eso es `SECURITY DEFINER` y no una exención de RLS: es el mismo patrón que
-- usa el login (`0001_auth_functions.sql`), y por el mismo motivo.
--
-- Misma disciplina: no acepta `org_id` de entrada — lo deduce de la huella — no
-- escribe nada, no devuelve credenciales y tiene `SET search_path` para que nadie
-- inyecte una función con el mismo nombre en el path.
-- =============================================================================

CREATE OR REPLACE FUNCTION auth_resolve_device_by_fingerprint(p_fingerprint text)
RETURNS TABLE (
  device_id uuid,
  device_name text,
  device_kind text,
  device_status text,
  venue_id uuid,
  venue_name text,
  venue_kind text,
  org_id uuid,
  org_name text,
  currency text,
  timezone text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Solo dispositivos **activos**. Un aparato pendiente de aprobación o revocado
  -- no aparece, que es lo mismo que el controlador traduce a 404 con un mensaje
  -- accionable. Decirle a un aparato revocado "tu huella no existe" y "tu huella
  -- existe pero está revocada" es la misma información para quien prueba huellas,
  -- así que el mensaje es el mismo.
  SELECT d.id, d.name, d.kind, d.status,
         v.id, v.name, v.kind,
         o.id, o.name, o.currency, o.timezone
  FROM devices d
  JOIN venues v ON v.id = d.venue_id
  JOIN organizations o ON o.id = d.org_id
  WHERE d.fingerprint = p_fingerprint
    AND d.status = 'active'
  LIMIT 1
$$;

-- `EXECUTE` acotado al rol de la aplicación. `REVOKE PUBLIC` es lo importante:
-- sin esto, cualquier rol conectado a la base podría llamarla.
REVOKE ALL ON FUNCTION auth_resolve_device_by_fingerprint(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_device_by_fingerprint(text) TO comanda_app;