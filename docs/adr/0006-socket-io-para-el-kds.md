# ADR-0006 · Socket.IO para el tiempo real del KDS

- **Estado:** aceptada
- **Fecha:** 2026-03-02

## Contexto

El KDS (la pantalla de cocina) se alimenta de los mismos eventos que el resto del
POS, y hasta ahora los recibe por el ciclo de sincronización: `GET /sync/pull` cada
20 segundos (`useSyncLifecycle`).

Eso sincroniza bien, pero no sirve para cocina. El ticket nuevo tiene que aparecer en
la pantalla **ya**: está a dos metros, de pie, con extractor encima y ruido de la
barra. Veinte segundos de espera no es una latencia tolerable, es un plato que sale
tarde.

El PLAN §7 ya pedía los canales: `venue:{id}:orders`, `venue:{id}:tables`,
`venue:{id}:kds`, `org:{id}:live-sales`. Faltaba decidir **con qué**.

## Opciones

### 1. WebSocket crudo (`ws`)

El más liviano y el más rápido en handshake.

El problema es la integración con Nest. No existe adaptador oficial: hay que
implementar a mano `INestApplicationContext` → `WebSocketServer`, el ciclo de vida de
`OnGatewayConnection` y el `IoAdapter`. Son unas 80 líneas de plumbing que no
aportan nada al producto y que se rompen con cada versión de Nest.

### 2. SSE (Server-Sent Events) + POST

Cada `POST` del POS genera un evento que el servidor manda por un `GET` abierto.

Es HTTP puro: sin proxy que rompa, reconexión y reconexión sola del navegador, y
funciona detrás de cualquier balanceador.

El límite es que es **unidireccional**. El POS necesita las dos manos: no solo recibir
que un ticket cambió, sino **mandar** el avance sin salir del modo offline. Con SSE
habría que volver al `POST` de REST para cada avance, y el KDS quedaría con dos
transportes para la misma cosa.

### 3. Socket.IO sobre `@nestjs/platform-socket.io` — **elegida**

`@nestjs/websockets` trae el adaptador oficial: el gateway es un provider como
cualquier otro, con su ciclo de vida y su decorador.

## Decisión

Socket.IO, vía `@nestjs/websockets` + `@nestjs/platform-socket.io`.

Tres razones, en orden de peso:

1. **El adaptador oficial existe y es de Nest.** El gateway es un provider que se
   registra en `KdsModule` como `KdsService`. No hay plumbing propio que mantener.

2. **Reconexión con backoff, y rooms.** Socket.IO trae las dos cosas que un KDS
   necesita y que reimplementar son la mitad del trabajo: reconexión automática con
   backoff exponencial (`reconnectionDelay`, `reconnectionDelayMax`) y `join`/`leave`
   por sala. El canal `venue:{id}:kds` **es** una room.

3. **El POS ya es un navegador.** Socket.IO funciona en el navegador sin proxy
   especial y es lo que el POS puede consumir directo. Un `ws` crudo en el POS obliga
   a manejar a mano la reconexión, el ping/pong y el parseo de frames.

## Alternativas descartadas

**`ws` crudo.** Más rápido en handshake —una diferencia de milisegundos que no se
nota al lado de un local—, a cambio del adaptador propio. No vale el mantenimiento.

**SSE.** HTTP puro y sin proxy que lo rompa, pero unidireccional. El avance de estado
del KDS lo hace el POS, y con SSE sería un `POST` por cada avance.

**Polling del `sync/pull` cada 5 segundos.** Es lo que hace hoy `Kitchen.tsx` con su
intervalo. Funciona y es cero infraestructura nueva, pero gasta una consulta de base
por KDS cada cinco segundos para entregar, en el mejor caso, la mitad de la información
que ya está en el socket.

**Redis como transporte del bus.** Es lo que hace falta cuando hay más de una
instancia del API, y está asumido en `docs/ASSUMPTIONS.md` A-09 que Redis no es
obligatorio en Fase 1. Hoy el bus es un `Subject` de RxJS **in-process**: con una sola
instancia funciona, y con varias se rompe en silencio (cada instancia solo ve los
eventos que ella aplicó). El aviso está escrito en `kds-event-bus.ts`, y cambiar a
Redis toca **esa clase y nada más** porque el resto del sistema ya habla con el bus.

## Autenticación del handshake

El punto donde esto se decide de verdad.

Los guards de Nest (`PermissionsGuard`) leen `request.principal`, que arma
`AuthMiddleware`, que es **middleware de HTTP**. Un WebSocket no pasa por ahí: el
handshake es una petición HTTP y los mensajes son otra cosa. Un gateway que confíe en
los guards tiene `client.data.principal === undefined` en todos los sockets.

Por eso `KdsGateway.handleConnection` verifica el token de `handshake.auth.token` con
el mismo `AccessTokenService` que usa el middleware, resuelve el `SessionPrincipal`
con `AuthService.resolvePrincipal` y lo guarda en `client.data.principal`. Sin sesión,
la conexión se rechaza.

Y la suscripción a `venue:{id}:kds` compara el `{id}` del canal contra
`principal.venueId`. Si no coinciden, no se entra a la sala y se devuelve un 403. Ese
chequeo —comparable, no un `startsWith`— es el aislamiento entre locales: sin él, un
KDS abierto muestra las comandas de **todas las sucursales**, porque lo único que
separa a una de otra es el id que viene en el token.

## Consecuencias

- El gateway necesita `AccessTokenService` y `AuthService`, que son globales
  (`AuthModule` es `@Global()`). `KdsModule` no los importa.
- El prefijo global `/api/v1` **no** aplica a los sockets: el path se resuelve en el
  handshake. El POS conecta a `/ws/kds`.
- El bus de eventos es in-process. Con una instancia del API, correcto. Con varias,
  hay que migrarlo a Redis antes de escalar, y el síntoma (KDS que a veces no se
  actualiza) es peor que no tenerlo.
- La fuente de verdad sigue siendo la base. Cuando llega un cambio, el gateway
  **relee la fila** y emite lo que dice: dos escrituras que compiten no pueden dejar
  dos pantallas mostrando estados que la base nunca tuvo.
- El socket es una mejora de latencia, no la única fuente. Si se cae, el KDS sigue
  mostrando lo último del ciclo de sincronización. Ver `apps/pos/src/state/realtime.ts`.