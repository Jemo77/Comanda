-- Reversa de 0008_resolver_dispositivo.

REVOKE ALL ON FUNCTION auth_resolve_device_by_fingerprint(text) FROM PUBLIC;
DROP FUNCTION IF EXISTS auth_resolve_device_by_fingerprint(text);