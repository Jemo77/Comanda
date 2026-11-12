# Supuestos

Decisiones tomadas donde el plan era ambiguo. Cada una está también en su ADR
cuando cambia la arquitectura.

| # | Ambigüedad | Decisión | Motivo |
| - | - | - | - |
| A-01 | Node 22 vs. entorno local 26 | `engines.node >= 22`, `.nvmrc` 22; se desarrolla y testea con 26 | Node 26 local; ambos soportados por NestJS 11 |
| A-02 | Rotación de refresh tokens en Redis o Postgres | **Postgres** (tabla `refresh_tokens`) | Redis no es fuente de verdad; enables auditoría y detección de reuse sin dependencia de cache |
| A-03 | Prisma o Drizzle | **Drizzle** | RLS + triggers + roles de DB se expresan en SQL real; Prisma abstrae justo lo que necesitamos controlar |
| A-04 | ¿RLS `ENABLE` o `ENABLE + FORCE`? | Ambos, en toda tabla de tenant | Que el owner de la tabla tampoco evada la política: los tests de aislamiento son creíbles |
| A-05 | Seed de demo: ¿como superuser o como rol app? | **Como `comanda_app`**, con `app.current_org` seteado | El seed ejercita el mismo modelo de seguridad que la API; si el RLS está roto, el seed falla |
| A-06 | ¿Drizzle Kit o SQL a mano para migraciones? | `drizzle-kit generate` + revisión manual de RLS/triggers | Genera `down` reversible; los policies/triggers se afinan a mano en el mismo archivo |
| A-07 | Moneda/impuestos por país en Fase 0 | Solo `currency` (ISO 4217) en `organizations` | El motor fiscal es Fase 2; agregar `tax_rate` al producto en Fase 1 |
| A-08 | Idioma de la UI | es-AR | PLAN §8 |
| A-09 | Redis es obligatorio en Fase 0 | No: solo cache y pub/sub. Auth y RBAC no lo necesitan | Permite correr la API sin Redis; rate limiting en memoria hasta Fase 1 |
| A-10 | ¿Dos apps o una con roles? | Dos apps (`pos`, `admin`) con el mismo `packages/ui` | PLAN §9; el POS necesitatargets grandes y modo offline, el admin densidad |
| A-11 | ¿El POS tiene que abrir sesión contra el servidor para entrar? | No: el login por PIN valida contra el hash local de la réplica y revalida en el servidor cuando hay red | Un mostrador sin internet es el caso normal, no la excepción |
| A-12 | ¿Dónde vive la réplica del POS? | En IndexedDB vía `SyncStorage`, una interfaz con dos implementaciones: Dexie (navegador) y `MemorySyncStorage` (tests y referencia) | La lógica de reconciliación tiene que poder testearse en Node sin levantar un navegador por cada caso |
| A-13 | ¿El reparto de la cuenta se recalcula en el servidor? | No: se persiste tal cual lo calculó el cliente, y el servidor solo valida que las partes sumen el total | El reparto ya se mostró en pantalla y el cliente lo aceptó; recalcularlo puede dar un centavo distinto al que se leyó cobrar |
| A-14 | ¿Dónde se resuelve el turno al cerrar una comanda offline? | En el servidor, leyendo el turno abierto del local | La constraint `orders_closed_consistent` exige turno, y hay a lo sumo uno abierto por local: no hay ambigüedad de la cual elegir |
| A-15 | ¿Cómo se prueban las migraciones sin base de datos? | PGlite (PostgreSQL en WASM) en la etapa de calidad, y la suite de integración con PostgreSQL real en la etapa siguiente | PGlite no tiene roles, así que no reemplaza los tests de RLS; hace que un error de SQL aparezca en el pipeline y no en el deploy |
| A-16 | ¿Los eventos `TABLE_*` son efectos distintos de los `ORDER_*`? | No: delegan en los mismos handlers | Son el mismo efecto con el nombre del dominio del salón. Dos implementaciones del mismo efecto se divergen |
| A-17 | ¿Cómo sabe un POS recién instalado cuál es su aparato, si `GET /devices` exige sesión? | `POST /devices/resolve`, público y rate-limited, respaldado por una función `SECURITY DEFINER` | Sin esto el POS no tiene forma de descubrirse y nunca llega a la pantalla de PIN: no puede entrar nunca. La función cruza tablas con RLS y a esa altura no hay `app.current_org` que poner |
| A-18 | ¿Qué devuelve ese endpoint público? | Solo rótulos: id y nombre del dispositivo, del local y de la organización, con la moneda y el huso horario | Público no significa abierto. Devolver algo que sirva para autenticarse convertiría el endpoint en una puerta; el tipo de respuesta es más angosto que `Device` a propósito, para que un campo nuevo no se filtre por olvidarse |
| A-19 | ¿El POS recalcula el precio o lo pide? | Lo recalcula el servidor desde el catálogo; el contrato de `addItem` no tiene `unitPriceCents` | Un `unitPriceCents` en el body es un hueco de manipulación de precio. El POS igual lo calcula para ser optimista, pero lo que se guarda es el del servidor |
| A-20 | ¿Descuento en centavos o en basis points? | Descuento en centavos, servicio en basis points | El descuento es una decisión del mozo sobre esa comanda: se guarda el importe y el motivo. La tasa de servicio viene de la configuración del local, así que si el dueño la sube, las comandas abiertas tienen que reflejarlo |
| A-21 | ¿Pub/sub para el WebSocket del KDS con Redis? | In-process, sin Redis | A-09 ya decidió que Redis es opcional en esta fase. Con varias instancias del API el pub/sub se rompe, y hay que saberlo antes de que pase: está anotado en el código |
| A-22 | ¿Qué ve el cajero al cerrar la caja? | La respuesta no tiene las claves del esperado ni de la diferencia | El arqueo ciego es estructural y no una condición: si el campo existe y vale `null`, el primer refactor que lo popule se lo lleva. Para verlo hace falta `cash.viewExpected` |
| A-23 | BullMQ para la cola de facturación (PLAN §2.1) | **La tabla `invoices` es la cola**: claim atómico por `platform_claim_pending_fiscal_invoices`, reintentos con `next_attempt_at` y backoff en SQL | La fila es la fuente de verdad del comprobante de todas formas; dos fuentes (cola en Redis + tabla) se desfasan. Y Redis es opcional (A-09): la cola no puede reintroducir la dependencia. Ver [ADR-0007](adr/0007-cola-fiscal-en-la-base.md) |
| A-24 | ¿Dónde se evalúan las promos de una venta de mostrador? | **En el POS**, con `@comanda/pricing-engine` sobre reglas hidratadas de `GET /promotions` a la réplica local (Dexie `priceRules`) | El POS nunca llama a `POST /orders/:id/items` (siempre encola eventos): si el precio lo calcula solo el servidor, las promos nunca aplican en mostrador. El motor es puro e isomorfo, así que el mismo input da el mismo precio en el navegador y en Node. La hora del contexto viene de la zona del local (`setVenuePricing`, default `America/Argentina/Buenos_Aires`). Ver [ADR-0008](adr/0008-adaptador-fiscal.md) |
| A-25 | ¿La nota de crédito se emite sobre la comanda o sobre la factura? | **Sobre la FACT**, con sus mismos totales y receptor; una FACT admite a lo sumo una NC vigente | La pregunta que importa ("¿qué se acreditó?") se responde mirando la factura original, no la comanda. La unicidad parcial (`credit_note_for` con `status <> 'ERROR'`) impide la doble acreditación sin bloquear el reintento de una NC en `ERROR` |
| A-26 | ¿Cómo se verifica la firma del webhook de pago? | Sobre el **`rawBody` crudo** (`NestFactory.create(..., { rawBody: true })`), antes de cualquier parseo | El proveedor firma los bytes que envió. Si la API verifica sobre el body parseado (o re-serializado), un solo espacio o el orden de claves invalida la firma y el webhook se rechaza —o peor, si se verifica sobre un objeto reconstruido, la verificación es del JSON de Nest y no del mensaje del proveedor |
| A-27 | ¿Cómo se entera el cliente de takeaway que su pedido está listo? | **Polling** de `GET /storefront/orders/:id/takeaway-status` cada 5 s desde la página | La página es pública y sin sesión: no hay canal (WebSocket autenticado, push) donde el servidor pueda avisar. Las notificaciones reales (adapter WhatsApp/email) quedan para después; el polling es honesto sobre lo que es hoy |
| A-28 | ¿Formato y rotación del token QR? | HMAC-SHA256 truncado a 22 chars base64url, secreto en `QR_TOKEN_SECRET` (nunca en la base) y rotación por `tables.qr_token_version` | Un token aleatorio en la base no se puede rotar sin reimprimir stickers; un JWT trae expiración y claims que no necesitamos. La versión en la base permite invalidar todos los QR impresos con un UPDATE. Ver [ADR-0009](adr/0009-qr-token-hmac.md) |

## Desviaciones del plan

Ninguna que contradiga el plan. Se registra acá el caso de Testcontainers:

- El entorno de desarrollo de esta sesión **no tiene Docker**, así que los tests de
  integración usan un PostgreSQL local nativo en lugar de Testcontainers. El código de
  test detecta Docker y usa Testcontainers cuando está disponible
  (`apps/api/test/support/db.ts`): en CI corre con Testcontainers, localmente con un
  server propio. Es el mismo SQL en ambos casos.