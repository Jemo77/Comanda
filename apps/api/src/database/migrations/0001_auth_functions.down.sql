-- Down de 0001_auth_functions.sql
--
-- Revierte por completo el acceso previo al tenant que otorgan estas funciones.
-- Si se olvida alguna, la sesion queda sin poder validar credenciales y el fallo
-- aparece como "login incorrecto" para todos los usuarios.

DROP FUNCTION IF EXISTS auth_pin_candidates(uuid, uuid);
DROP FUNCTION IF EXISTS auth_lookup_device(uuid);
DROP FUNCTION IF EXISTS auth_lookup_user_by_email(text);