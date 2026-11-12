# ADR-0005 · Un solo catálogo de eventos de sincronización

- **Estado:** aceptada
- **Fecha:** 2026-03-02

## Contexto

El catálogo de tipos de evento de sincronización estaba escrito en tres lugares:

1. `apps/api/src/modules/sync/sync.types.ts` (servidor)
2. `packages/sync-client/src/protocol.ts` (POS)
3. La constraint `sync_events_type_valid` en la migración `0004_fase1_pos.sql`
   (base de datos)

Los tres tenían que coincidir. No coincidían.

## Problema

Con copias separadas, el modo de falla es silencioso y caro:

1. Alguien agrega un evento nuevo a la lista del POS.
2. El POS empieza a encolarlo.
3. El servidor lo rechaza con `REJECTED` y el mensaje
   `"Tipo de evento sin handler: X"`.
4. En el mostrador eso es "algo falló" sin ninguna pista de que la lista quedó
   vieja.

El POS no muestra stack traces, y el mensaje que ve el mozo no menciona que el
problema es una lista desactualizada en otro paquete. Diagnosticarlo desde el
local es imposible; hay que Reproducirlo contra el servidor y mirar la versión
del POS instalada en cada tablet.

El riesgo no es teórico: la lista ya había divergido una vez durante el
desarrollo (el servidor aceptaba 18 tipos, el POS 17), y se detectó solo porque
alguien lo leyó. Nada lo iba a detectar en CI.

El test que ahora compara el catálogo del dominio contra la constraint encontró la
divergencia de `CATALOG_PUBLISHED` y `TABLE_STATUS_CHANGED` en su primer run.

## Decisión

El catálogo vive en `packages/domain/src/sync.ts`. El POS y la API lo reexportan.
La base sigue teniendo la constraint, porque una base no lee TypeScript.

Se agrega `packages/domain/src/sync.test.ts`, que copia la constraint de la
migración y falla si divergen. Cuando se cambia la constraint hay que actualizar la
copia en el test, y el test lo dice.

## Por qué `domain` y no el API

El POS es un paquete isomorfico que no depende de la API. Si el catálogo viviera
en la API, el POS tendría que depender de ella para leer una lista de strings, y
el `@comanda/api` es un `NestApplication`, no una biblioteca.

`domain` ya es el lugar donde vive lo que los dos lados necesitan: dinero,
permisos, UUIDv7, errores. Un enum de eventos es exactamente eso.

## Alternativas descartadas

**Generar el catálogo desde la migración.** Habría que parsear SQL en tiempo de
build para emitir TypeScript. Agrega una dependencia de parseo de Postgres y un
paso de build que puede fallar de formas difíciles de depurar, a cambio de evitar
un archivo de 20 strings que un test compara.

**Dejar la lista solo en la base y derivarla.** El POS no puede leer la base:
offline es exactamente el caso donde no hay conexión a la que preguntarle.

**Un solo lado y que el otro importe.** Es lo que se hizo: los dos importan de
`domain`.

## Consecuencias

- Agregar un evento toca tres lugares: `domain/src/sync.ts`, la constraint en una
  migración nueva, y la copia en `sync.test.ts`. El test dice cuál se olvidó.
- La migración `0005` existe justamente porque la constraint no aceptaba los dos
  eventos que emite el servidor. Un `.down.sql` que existe pero no funciona es
  peor que ninguno, así que los tests de migración comprueban reversibilidad de
  verdad.