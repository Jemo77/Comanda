# ADR-0007 · La cola de facturación vive en la base, no en BullMQ

- **Estado:** aceptada
- **Fecha:** 2026-10-02
- **Desviación del PLAN §2.1** (que propone BullMQ para colas). Registrada
  también en `docs/ASSUMPTIONS.md` A-23.

## Contexto

La facturación fiscal no es un trabajo "en el aire": es un comprobante
que el fisco **autoriza o rechaza**, con CAE y número de comprobante
que hay que persistir aunque el proceso muera a mitad de camino. El
PLAN pone a BullMQ (sobre Redis) como el bus de jobs por defecto:
facturación, sync, webhooks, reportes.

Para Fase 2 la pregunta era concreta: ¿dónde vive la cola de
facturación pendiente?

## Opciones

### 1. BullMQ sobre Redis

Es lo que dice el plan, y es excelente para trabajos efímeros (resize
de imagen, envío de mail, reporte que se recalcula).

El problema es la **durabilidad del estado del comprobante**. BullMQ
guarda el job, pero el *resultado* del job (CAE, número, observaciones
del fisco) tiene que vivir en una tabla de todas formas: `invoices` es
la fuente de verdad para el contador y para la impresión del QR. Con
BullMQ habría **dos** fuentes de verdad sobre "qué falta emitir": la
cola en Redis y la tabla en Postgres, y dos cosas que pueden desfasarse
(Redis se vacía, un job se pierde, el worker se cae con el job en
`active`). Sincronizarlas es trabajo extra y casos de borde.

Además, A-09 ya decidió que **Redis es opcional** en esta fase: la API
tiene que poder arrancar sin Redis para que un local pequeño con una
sola instancia no dependa de un tercer servicio. Meter la cola fiscal
en Redis reintroduce la dependencia justo donde más duele: si Redis
está caído, **no se factura**, y eso es un local que no puede vender.

### 2. Tabla `invoices` como cola — **elegida**

La fila misma es el trabajo. `status` (`PENDING` → `EMITIDA` /
`RECHAZADA` / `ERROR`) y `next_attempt_at` son el estado de la cola;
`attempts` contra `max_attempts` es la política de reintentos; el
claim es una sola función en la base.

## Decisión

La cola de facturación es la tabla `invoices`, con la función
`platform_claim_pending_fiscal_invoices(limit)` (SECURITY DEFINER,
owner `comanda_migrator` con `BYPASSRLS`) que atómicamente:

1. selecciona hasta `limit` filas `PENDING` con `next_attempt_at <= now()`
   del local, **sin orden de prioridad entre locales** (el orden de
   llegada basta: una factura no es más urgente que otra);
2. las marca como reclamadas (suma el intento y fija el próximo
   `next_attempt_at`), para que dos workers no procesen la misma fila.

El worker del API (`FiscalWorker`) es un poller con
`FISCAL_WORKER_INTERVAL_MS` (por defecto 30 s; `0` lo apaga, que es
lo que hacen los tests). Además, `POST /fiscal/orders/:id/invoices`
procesa la fila inmediatamente después de crearla: el operador que
factura ve el resultado en la misma respuesta, y la cola es la red de
seguridad para cuando el fisco está caído.

Los reintentos usan backoff exponencial (1 min, 2 min, 4 min… tope
2 h) **calculado en la base** (`next_attempt_at = now() + interval`),
y el agotamiento pasa a `ERROR` con el último error persistido. Un
`FiscalRejectionError` del proveedor es **terminal** (`RECHAZADA`):
es una decisión del fisco, no una falla de red, y reenviarla igual
solo genera otro rechazo.

## Consecuencias

- **Una sola fuente de verdad.** Lo que está en `invoices` es lo que
  hay que emitir; no hay cola que reconciliar con la tabla.
- **Sin Redis, la facturación sigue funcionando.** Consistente con
  A-09: la cola no reintroduce la dependencia.
- **El claim es atómico en la base**, no "reservar en Redis y luego
  actualizar Postgres": no hay ventana en la que dos workers emitan la
  misma factura.
- **El worker es un poller, no un suscriptor.** La latencia para
  reintentar es de hasta 30 s, que es irrelevante frente a un backoff
  de minutos. Si el volumen crece, el poller se puede paralelizar con
  `SELECT ... FOR UPDATE SKIP LOCKED` sin cambiar el modelo.
- **BullMQ sigue siendo la opción para trabajos efímeros** (webhooks,
  reportes pesados) cuando se agregue Redis. Esa decisión no se
  anticipa: no hay trabajo de ese tipo en Fase 2.
- El plan se actualiza en `docs/ASSUMPTIONS.md` (A-23) y esta
  desviación es explícita: el PLAN propone tecnología, el requisito es
  "cola con reintentos y auditoría", y la tabla lo cumple sin la
  dependencia.
