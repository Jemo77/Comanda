# ADR-0004 · Auditoría append-only garantizada en la base

- **Estado:** aceptada
- **Fecha:** Fase 0

## Contexto

El plan exige que toda acción sensible (anular, descontar, abrir cajón, cambiar
precio, ajustar stock, reimprimir) quede registrada, y que `audit_log` sea
append-only.

"Append-only" se puede implementar de tres maneras:

1. Por código: el servicio de auditoría sólo expone `insert`.
2. Por permisos: `REVOKE UPDATE, DELETE` para el rol de la aplicación.
3. Por trigger en la base.

## Decisión

Las **tres**, y además la tabla **no tiene policy de `UPDATE` ni de `DELETE`**.

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM comanda_app;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log ... RAISE EXCEPTION;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log ... RAISE EXCEPTION;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log ... RAISE EXCEPTION;
```

Sin policy de `UPDATE`/`DELETE`, con `FORCE ROW LEVEL SECURITY` la operación no
tiene con qué ser autorizada, ni siquiera por error.

## Por qué

**Cada capa tapa un agujero distinto.**

- El código tapa el uso normal, pero un `UPDATE` escrito a mano en un script de
  migración lo pasa por alto.
- El permiso tapa el rol de la aplicación, pero no al owner de la tabla.
- El trigger tapa a todos: corre siempre, sin importar el rol.

**Un trigger no se puede esquivar por error.** Es la única de las tres que no
depende de que alguien recuerde algo.

**`TRUNCATE` es una operación de tabla.** No pasa por las policies de fila: sin el
trigger, un `TRUNCATE` borraría todo el histórico sin que la RLS lo advierta. Es el
agujero que suelen dejar las implementaciones que sólo revokan `DELETE`.

**La cadena de hashes va en un trigger, no en el código.** Así se mantiene aunque
alguien escriba con `psql`, y no depende de que el código de la aplicación haya
pasado por el camino correcto.

## La cadena de hashes

Cada registro encadena con el anterior de **la misma organización**:

```
prev_hash = hash del registro anterior del mismo org_id
hash      = sha256(prev_hash | org_id | venue_id | actor_id | action |
                    entity | entity_id | reason | before | after)
```

- Por organización, no global: un tenant grande no bloquea a los demás al
  verificar.
- El primero de cada org arranca en 64 ceros.
- `audit_log_verify_chain(org)` devuelve los registros que **no** cierran. Lista
  vacía = histórico íntegro.

Detecta: un registro insertado a mano con `false`, o un borrado del medio
restaurando un dump.

## Consecuencias

- No hay forma normal de depurar datos de auditoría. Es intencional.
- Los tests de integración **no pueden limpiar `audit_log`** con el rol de la
  aplicación: `truncateAuditLog` desactiva el trigger con el rol admin y lo
  reactiva. Es la única excepción controlada, y está en el harness de test.
- `auth.login.failed` es la única acción que se puede escribir con `org_id` nulo,
  mediante una policy de `INSERT` acotada a esa acción exacta. Sin ella, un ataque
  con correos inventados no dejaría rastro, que es justo el ataque que hay que
  poder detectar.

## Alternativas consideradas

- **Sólo append-only por código:** rechazada. Depende de la disciplina de todos los
  que tocan la base, incluidos los que escriben scripts.
- **Particionar por mes en vez de encadenar:** el plan lo sugiere, pero particionar
  más de un año atrás rompe la continuidad de la cadena. Se particiona cuando haga
  falta y se acepta ese límite.