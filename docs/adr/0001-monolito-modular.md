# ADR-0001 · Monolito modular en NestJS

- **Estado:** aceptada
- **Fecha:** Fase 0

## Contexto

El producto tiene 17 dominios (POS, catálogo, inventario, finanzas, fiscal,
fidelización, integraciones) con reglas que se cruzan entre sí. El plan ya sugiere
un monolito modular con límites claros y sólo extraer facturación fiscal e
integraciones si hace falta.

La alternativa obvia son microservicios desde el día 1.

## Decisión

Monolito modular con NestJS, un proceso, una base de datos.

Cada dominio es un módulo de Nest con su servicio, su controller y su esquema.
Los límites se mantienen por convención y por la regla de imports, no por red.

## Por qué

**El aislamiento que importa es de datos, no de procesos.** El riesgo real en
Comanda es que un local vea los datos de otro. Eso lo resuelve la Row Level
Security de PostgreSQL, que ya implementamos y que funciona mejor en una sola
base que replicada entre servicios. Partir el sistema en microservicios hoy no
mejoraría el aislamiento y sí multiplicaría la superficie.

**Equipo chico, dominios muchos.** Treinta servicios con siete personas es
mucho trabajo de plumbing y muy poco de producto. La primera versión del POS (Fase
1) necesita que catálogo, mesas, comandas y caja cambien juntos, y con la lógica
en un proceso, un cambio de precios no rompe la venta.

**Transacciones.** Cobrar una comanda toca órdenes, pagos, caja, stock y
auditoría. Con microservicios eso sería una saga con compensaciones; en un monolito
es una transacción de Postgres.

**Operación.** Un local con internet lenta necesita que el POS funcione; el
backend puede ser un monolito simple que escala verticalmente hasta que haga
falta.

## Consecuencias

- Un comando de despliegue para todo. Aceptable: el riesgo de un despliegue
  parcial que deje el POS sin precios nuevos es peor.
- Se puede compartir una transacción entre dominios, lo que es un riesgo
  (un módulo puede escribir tablas de otro). Se mitiga con la regla de que cada
  módulo sólo accede a las suyas por su servicio.
- Extraer un módulo más adelante (fiscal, integraciones) es un problema de
  *cambio*, no de reescritura: la lógica ya está aislada detrás de un servicio.

## Alternativas consideradas

- **Microservicios desde el día 1:** rechazada. Más plumbing que producto, sin
  ganancia de aislamiento, y sagas donde no hacen falta.
- **Serverless (Lambda):** rechazada. El POS necesita conexiones persistentes y
  el modelo de costos de concurrencia constante en un mostrador es peor.