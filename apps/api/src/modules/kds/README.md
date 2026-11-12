# `kds` · Cocina

El KDS es la pantalla que mira quien cocina. Tres cosas viven acá y están juntas a
propósito porque comparten el mismo estado: **qué hay que hacer**, **cómo se hace
saber que hay que hacerlo**, y **el papel que sale por la impresora**.

## Las tres piezas

| Archivo | Qué es |
| - | - |
| `kds.service.ts` | La fuente de verdad: lee y escribe `kitchen_tickets`. |
| `kds.gateway.ts` | El WebSocket. Solo **notifica**: relee la base y emite. |
| `kds.controller.ts` | Lo que el KDS necesita al abrir, y el camino online. |
| `kds-event-bus.ts` | El bus in-process entre quien escribe y quien escucha. |

## Reglas que no se rompen

**El ciclo solo avanza.** `NEW → PREPARING → READY → SERVED`. Volver atrás se rechaza
con 409. Un ticket que vuelve a `NEW` pasa dos veces por la pantalla de cocina y el
que lo está haciendo cree que es otro: un plato doble sale una vez de más.

**Un ticket por estación, no uno por ítem.** Los ítems de la misma estación se
agrupan en un solo papel. La barra no tiene cinco papeles para cinco vasos de vino.
El `station_id` sale de `products.station_id`: el ruteo vive en el catálogo, para que
agregar un producto no toque el POS.

**Un ítem sin estación va a la estación por defecto** (la de menor `sort`). Sin esto,
un producto sin rutear desaparece de la cocina: el mozo lo ve en la comanda y el
cocinero nunca lo ve.

**La base es la fuente de verdad, el socket no.** Cuando llega un cambio, el gateway
*relee la fila* y emite lo que dice la base. Si emitiera el evento tal cual, dos
escrituras que compiten (dos KDS, o el sync contra el endpoint online) harían que dos
pantallas mostraran estados que la base nunca tuvo.

**La sesión se verifica en el handshake, no con los guards.** `PermissionsGuard` lee
`request.principal`, que arma `AuthMiddleware`, que es middleware de **HTTP**. Un
socket no pasa por ahí. Ver el comentario de `kds.gateway.ts` y el ADR-0006.

## El bus es in-process

`KdsEventBus` es un `Subject` de RxJS en la memoria de un proceso.

- **Una instancia del API: funciona.**
- **Varias instancias: se rompe en silencio.** El POS que cae en la instancia B no
  recibe el evento que la instancia A aplicó, y el síntoma no es un error: es "la
  cocina se actualiza a veces". Un KDS que a veces no se actualiza es peor que uno que
  no se actualiza nunca, porque el que está en cocina deja de confiar en la pantalla.

Migrar a Redis (o `LISTEN/NOTIFY` de Postgres, que ya está) toca `kds-event-bus.ts` y
nada más: el resto del sistema ya habla con el bus.

## Permisos

`kitchen.read` (ver la pantalla) y `kitchen.advance` (hacer avanzar un ticket). Son
claves propias y no `order.*` porque no es lo mismo tomar un pedido que hacer un
plato. Ver el comentario de `catalog.controller.ts` para el criterio de no inventar
una clave por cada endpoint.