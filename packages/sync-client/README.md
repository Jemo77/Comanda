# `@comanda/sync-client`

Outbox, réplica local y reconciliación. El núcleo del modo offline del POS.

## Qué resuelve

El POS tiene que funcionar sin internet (PLAN §1). Eso significa que escribe en
local, muestra el resultado al mozo de inmediato, y confía en que después va a
converger con el servidor **sin duplicar nada**.

La parte difícil no es guardar los eventos: es decidir qué hacer cuando el
servidor dice "no", y qué hacer con lo que hizo otro dispositivo mientras
estábamos desconectados.

## Piezas

| Archivo | Qué hace |
| - | - |
| `protocol.ts` | Reexporta el catálogo de eventos del dominio. No lo duplica. |
| `storage.ts` | La interfaz `SyncStorage`: qué tiene que saber hacer el almacenamiento. |
| `outbox.ts` | Genera eventos con UUIDv7 y secuencia monotona. |
| `reconcile.ts` | Traduce la respuesta del servidor a cambios en la réplica y la outbox. |
| `engine.ts` | El ciclo de push/pull, con retry y coalescencia. |
| `memory-storage.ts` | Implementación en memoria. Fixture de test **y** especificación ejecutable. |

## Las tres decisiones que hay que conocer

**Fallar no es rechazar.** Un error de red deja los eventos en la cola para el
próximo ciclo. Solo lo que el servidor *rechaza* (un payload inválido) sale de la
cola: reenviar eso en bucle es ruido que nunca termina. Es la diferencia entre un
POS que reintenta y uno que se cuelga.

**Push antes que pull.** Si subimos después de bajar, los eventos que el servidor
genera al resolver *nuestro* conflicto de mesa llegan un ciclo tarde. Al revés,
veríamos la mesa ocupada por una comanda que todavía no existe para nosotros.

**El payload se clona al encolar.** El mozo sigue editando la nota después de
agregar el item. Si el payload fuera una referencia, lo que se sube no es lo que
se vio.

## Por qué `SyncStorage` es una interfaz

Dos razones, ambas prácticas:

1. **Los tests corren en Node.** Probar la reconciliación contra un IndexedDB de
   verdad significa un navegador por caso. Con el adaptador en memoria, la suite
   corre en milisegundos.
2. **Separa dos cosas que no son la misma.** La *outbox* es lo que sale del
   dispositivo y nunca se sobreescribe. La *réplica* es lo que el POS cree que es
   verdad y se sobreescribe con lo que baja del servidor. Confundirlas es cómo se
   pierde una comanda.

`MemorySyncStorage` cumple las dos: es el fixture de los tests y, a la vez, la
especificación que el adaptador de Dexie tiene que cumplir. Si los dos se portan
distinto, uno de los dos está mal.

## Adaptador de Dexie (pendiente)

El POS usa Dexie (ya está en `apps/pos`). Falta `DexieSyncStorage`, que tiene que
cumplir lo que `MemorySyncStorage` cumple, con una condición extra:

`applyRemote` tiene que ser **atómica**. Si el POS se cierra entre dos escrituras
de un mismo evento, al volver a abrir la réplica queda con medio estado y el mozo
cobra de más. En IndexedDB eso es una transacción de Dexie que abarque el lote
entero.

## Tests

```bash
pnpm --filter @comanda/sync-client test
```

El escenario central es el de aceptación del plan: cortar la red en medio de una
orden, seguir operando, reconectar y verificar que no hay duplicados ni pérdida.
Está en `sync.test.ts`, en `corte de red en medio de una orden`.