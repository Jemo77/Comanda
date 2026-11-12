-- Reversa de 0009_permisos_cocina.
--
-- `role_permissions.permission_key` tiene `ON DELETE CASCADE` contra `permissions`, así
-- que borrar la clave se lleva los roles que la tenían. Es el comportamiento correcto
-- para una reversa: si el permiso no existe en el catálogo, un role que lo referencia
-- es un role incoherente.

DELETE FROM permissions WHERE key IN ('kitchen.read', 'kitchen.advance');