# ADR-0003 · Refresh tokens en Postgres, no en Redis

- **Estado:** aceptada
- **Fecha:** Fase 0

## Contexto

La autenticación usa JWT de acceso corto (15 minutos) y refresh tokens rotativos.
Cada refresh emite un token nuevo y revoca el anterior; si llega un token ya
revocado, significa que alguien copió uno de los dos y hay que cortar la sesión
completa (el "detección de reuso por familia").

Eso obliga a guardar estado: qué tokens están vivos, a qué familia pertenecen y
por qué se revocaron. El plan propone Redis para esto.

## Decisión

Los refresh tokens viven en **PostgreSQL**, no en Redis.

Redis se usa para cache, pub/sub y colas (BullMQ), pero no como fuente de verdad
de la sesión.

## Por qué

**La sesión tiene que sobrevivir a un reinicio de cache.** Un Redis que se vacía
no debería cerrar todas las sesiones del sistema. Con Postgres, el estado de
autenticación está junto al resto del estado.

**El estado de sesión es auditable.** `refresh_tokens` tiene `ip`, `user_agent`,
`family_id` y `revoked_reason`. Con el detective de reuso, esa información es
evidencia: "este token se usó desde dos IPs a las 3:41". Redis no ofrece eso sin
duplicar los datos.

**Redis no es necesario en Fase 0.** Con un Redis caído, la autenticación, el RBAC
y el POS siguen funcionando. Si el refresh viviera en Redis, un Redis caído
dejaría el login entero abajo justo cuando puede haber un ataque (un atacante
suele provocar caída de servicios).

**El coste es aceptable.** Un local genera unas decenas de refresh por turno. Una
tabla indexada por `token_hash` (índice único) y por `family_id` maneja eso sin
dificultad. Se limpia con un job periodical sobre `expires_at`, que ya está
indexado.

## Consecuencias

- Un `SELECT` a Postgres por refresh, en lugar de un `GET` a Redis. Medido local:
  menos de un milisegundo con índice; el refresh no es una operación caliente.
- Hace falta un job de limpieza. `refresh_tokens_expires_at_idx` existe para eso.
- El estado de sesión y el resto del negocio se pueden consultar en la misma
  transacción, lo que simplifica el logout y la revocación por dispositivo.

## Alternativas consideradas

- **Redis como fuente de verdad:** rechazada. Agrega un punto de fallo al login y
  obliga a duplicar el estado para poder auditarlo.
- **Redis con Postgres como respaldo:** rechazada por complejidad. Dos fuentes de
  verdad para el mismo dato es peor que una sola.
- **JWT de acceso largo (24 h) sin refresh:** rechazada. No se puede revocar sin
  esperar a que expire, y revocar es un requisito (robo de sesión, dispositivo
  extraviado).