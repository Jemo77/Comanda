-- Down de 0000_fundaciones_rls.sql
--
-- Reversible por diseno (requisito del plan). El orden importa: primero los
-- triggers y las policies, despues las tablas.
--
-- NOTA: dropear audit_log es la unica forma de perder la cadena de auditoria.
-- En un entorno real este down no se ejecuta nunca contra produccion: se restaura
-- un backup. Por eso lleva el aviso.

DROP TRIGGER IF EXISTS audit_log_set_hash ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP FUNCTION IF EXISTS audit_log_verify_chain(uuid);
DROP FUNCTION IF EXISTS audit_log_chain_hash();
DROP FUNCTION IF EXISTS audit_log_is_append_only();

DROP TABLE IF EXISTS audit_log;

DROP INDEX IF EXISTS refresh_tokens_expires_at_idx;
DROP INDEX IF EXISTS refresh_tokens_family_id_idx;
DROP INDEX IF EXISTS refresh_tokens_user_id_idx;
DROP TABLE IF EXISTS refresh_tokens;

DROP INDEX IF EXISTS user_roles_user_id_idx;
DROP INDEX IF EXISTS user_roles_scope_key;
DROP TABLE IF EXISTS user_roles;

DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS permissions;

DROP INDEX IF EXISTS users_org_id_idx;
DROP TABLE IF EXISTS users;

DROP INDEX IF EXISTS devices_venue_id_status_idx;
DROP INDEX IF EXISTS devices_org_id_idx;
DROP TABLE IF EXISTS devices;

DROP INDEX IF EXISTS venues_org_id_idx;
DROP TABLE IF EXISTS venues;

DROP TABLE IF EXISTS organizations;

DROP TYPE IF EXISTS user_status;
DROP TYPE IF EXISTS device_status;
DROP TYPE IF EXISTS device_kind;
DROP TYPE IF EXISTS venue_kind;
DROP TYPE IF EXISTS plan;