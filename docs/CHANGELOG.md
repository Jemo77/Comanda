# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
El proyecto sigue [SemVer](https://semver.org/lang/es/).

## [No publicado]

### Agregado

**Dominio compartido (`@comanda/domain`)**

- **Contratos del POS** (`pos.ts`): catálogo, salón, comanda, cuenta, caja y
  cocina. No son solo validación de borde: son el formato de la réplica local del
  POS y el del payload de la outbox, así que el mismo Zod describe las tres
  cosas y no hay translation layer.
- `orderTotals` es una función pura y no un `SELECT`: la corre el POS sobre su
  réplica local y el servidor al cobrar, y tienen que dar el mismo número. El
  servicio se calcula sobre el neto (lista menos descuento), no sobre la lista;
  los modificadores entran en el precio unitario efectivo y no como línea aparte;
  el sobrepago queda en negativo y no en cero, porque taparlo esconde un cambio
  mal dado.
- **División de cuentas** (`split.ts`): los tres modos del plan más el reparto por
  comensal. La regla que no se negocia: la suma de las partes es exactamente el
  total, por `allocate` (fracción mayor sobre enteros) y nunca `toFixed`.
- **Catálogo de eventos de sincronización** (`sync.ts`), con una red que compara
  la lista contra la constraint de `sync_events.type` en la base. Ese test
  encontró la divergencia en su primer run.

**Cliente de sincronización (`@comanda/sync-client`)**

- Outbox, réplica local y reconciliación: el núcleo del modo offline, con los tests
  que el enunciado de la Fase 1 exige (cortar la red en medio de una orden,
  seguir operando, reconectar y verificar que no hay duplicados ni pérdida).
- `SyncStorage` es una interfaz y no Dexie directo: la reconciliación se testea en
  Node sin navegador, y la outbox (lo que sale, nunca se sobreescribe) queda
  separada de la réplica (lo que baja).
- Fallar no es rechazar: un error de red deja los eventos en la cola; solo lo que
  el servidor *rechaza* sale, porque reenviar eso en bucle no termina.
- `MemorySyncStorage` es a la vez fixture y especificación ejecutable del
  adaptador de Dexie.

**API**

- **Los 14 handlers de evento que faltaban.** De los 20 tipos del catálogo, 6
  caían en el `default` con "tipo de evento sin handler": el POS encolaba un
  evento válido y el servidor lo rechazaba con un mensaje que no explicaba nada.
  Entre los que faltaban estaban propina, reparto de cuenta, apertura de turno y
  movimientos de efectivo.
- Los eventos `TABLE_*` delegan en los `ORDER_*`: son el mismo efecto con el
  nombre del dominio del salón, y dos implementaciones se divergen.
- Migración `0005`: constraint de tipos de sync ampliada a los dos eventos que
  emite el servidor, tabla `pos_device_state` (comanda activa y cursor por
  dispositivo) y `shifts.source_event_id`.

**Cocina (`apps/api/src/modules/kds`)**

- **Tiempo real por WebSocket** (`kds.gateway.ts`): canales `venue:{id}:kds` y
  `venue:{id}:orders`, con el token verificado **en el handshake** con el mismo
  `AccessTokenService` que usa el middleware. Los guards de Nest leen
  `request.principal`, que arma middleware de HTTP: un socket no pasa por ahí. Sin
  esa verificación, `principal` es `undefined` y el chequeo de local —lo único que
  separa a una sucursal de otra— no tiene contra qué compararse.
- **La base es la fuente de verdad, el socket no.** Cuando llega un cambio, el
  gateway relee la fila y emite lo que dice: dos escrituras que compiten no pueden
  dejar dos pantallas mostrando estados que la base nunca tuvo.
- **El bus de cocina es in-process** (`kds-event-bus.ts`), asumido en
  `docs/ASSUMPTIONS.md` A-09. Con una instancia del API funciona; con varias se
  rompe en silencio y el síntoma es "la cocina se actualiza a veces", que es peor
  que no actualizarse nunca. Migrar a Redis toca esa clase y nada más.
- **`ensureTicketsForOrder`** crea un ticket por **estación**, no uno por ítem: la
  barra no tiene cinco papeles para cinco vasos de vino. El `station_id` sale de
  `products.station_id`, y un ítem sin rutear va a la estación por defecto (la de
  menor `sort`) en vez de desaparecer de la cocina.
- **El ciclo `NEW → PREPARING → READY → SERVED` solo avanza.** Volver atrás se
  rechaza con 409 y un mensaje en criollo, no con un 422 de validación: no es un
  dato inválido, es una regla del turno.
- Permisos propios `kitchen.read` y `kitchen.advance` (no `order.*`: no es lo
  mismo tomar un pedido que hacer un plato), con migración `0009` que los inserta
  para los tenants que ya existían.

**Impresión ESC/POS (`packages/escpos`)**- Paquete nuevo, isomorfico: el POS lo corre en el navegador (WebUSB) y la API en
  Node (TCP). Tres capas separables y testeables por separado: los bytes del
  protocolo, la codificación del texto, y el generador de tickets.
- **CP850 por defecto** y no CP437: los tickets llevan `€` y `º`, y CP437 no los
  tiene. CP858 está disponible (es la que tiene el euro) y es la que hay que elegir
  si el local factura en euros.
- **`sanitize` antes de codificar**: un `0x1B` suelto en medio del texto abre un
  comando ESC/POS y lo que sigue se ejecuta. Un producto llamado "Café ☕" puede
  abrir el cajón de dinero.
- **El cortador se arma antes de cortar** (`ESC p 1`). Sin eso, el corte funciona
  una vez y el ticket siguiente se imprime entero adentro del rollo.
- **Sin importes en el papel de cocina**: el que lo mira no lo cobra, y un total
  escrito a mano es un total que se puede equivocar.
- **Los totales del comprobante salen de `orderTotals()`**, la misma función pura
  que corre el POS sobre su réplica. Reimplementar la aritmética es el modo de
  falla de "me cobraron 120 y el ticket dice 118".
- Tres drivers tras la misma interfaz `write(bytes)`: `ConsoleDriver` (desarrollo y
  tests), `TcpDriver` (el de producción: impresión cruda en el 9100) y
  `BrowserUsbDriver` (WebUSB). Ninguno sabe qué es un ticket.

**Motor de promociones (`@comanda/pricing-engine`)**

- **`promotionRuleSchema`**: el contrato de lectura de `GET
  /promotions`. El POS lo usa para no escribir en su réplica una
  regla que no sabría evaluar —y como el mismo paquete la evalúa, la
  forma que valida es la forma que corre. Rellena los opcionales con
  `default` y rechaza la incoherencia `scope`/`scopeId`.
- El motor deja de ser scaffolding: evalúa en el servidor
  (`orders.service#addItem` carga las reglas activas antes de
  `priceLine`) y en el POS offline.

**Adaptador fiscal (`packages/fiscal-adapters`, nuevo)**

- **Contrato `FiscalProvider`**: recibe un comprobante con totales
  ya calculados (neto + IVA por alícuota, centavos enteros) y
  devuelve el comprobante autorizado (CAE, número, QR) o un error
  **clasificado**: `FiscalRejectionError` (decisión del fisco,
  terminal) y `FiscalUnavailableError` (transitorio, la cola
  reintenta). La distinción es la que decide si el comprobante pasa
  a `RECHAZADA` o queda en `PENDING`.
- **AFIP/ARCA WSFE** con el transporte HTTP y la firma CMS
  **inyectables**: los tests verifican el protocolo (qué XML se
  pide, cómo se arma `FECAESolicitar`) con un transporte falso,
  sin tocar el homologador. El provider no cachea el token de WSAA.
- **Contingencia con CAEA**: WSFE caído + CAEA vigente = emisión
  marcada `contingency: true` (válida por normativa). Sin CAEA,
  reintento.
- **QR persistido**: la URL se construye con la constante de AFIP y
  se guarda en el momento de la emisión; no se recalcula al imprimir.
- **Mock determinístico**: CAE y número derivados del `internalId`
  (hash estable), no aleatorios.

**API — módulo `promotions`**

- CRUD de reglas de precio con Zod, RLS y auditoría. Dos
  validaciones que no son formalidad: la **coherencia**
  (`ORDER` no lleva `scopeId`; cada tipo exige sus parámetros, porque
  un `PERCENT` sin `bps` descuenta cero en silencio) y la
  **no creación para otro local** (409 si el body trae el id de otra
  sucursal).
- La baja es lógica (`active = false`): las comandas pasadas guardan
  el snapshot en `applied_rules` y tienen que poder explicarse.
- Al editar se valida la fila **mergeada** (base + cambios): cambiar
  solo el `type` no puede dejar una regla incoherente.

**API — módulo `billing-fiscal`**

- **Emisión por comanda cerrada**: FACT A/B/C y NC, desglose de IVA
  por alícuota (`fiscal.math.ts`, puro). Los precios de catálogo son
  IVA-inclusive, así que `neto = round(bruto / (1 + alícuota))` **por
  grupo de alícuota**; sumar por grupo con esa regla preserva el total
  al centavo.
- **La cola es la tabla `invoices`** (ver
  [ADR-0007](../adr/0007-cola-fiscal-en-la-base.md)): claim atómico
  por `platform_claim_pending_fiscal_invoices` (SECURITY DEFINER),
  reintentos con backoff exponencial calculado en SQL (1 min, 2 min,
  4 min… tope 2 h), agotamiento a `ERROR`. Sin BullMQ y sin Redis:
  una sola fuente de verdad, y la facturación no depende de un
  tercer servicio (A-09).
- `POST /fiscal/invoices/orders/:orderId` crea la fila y la procesa
  en el mismo request: el mozo ve el CAE antes de entregar el
  producto. La cola es la red de seguridad cuando el fisco está caído.
- **NC sobre la FACT original** (con sus totales y receptor), con
  unicidad parcial que impide la doble acreditación sin bloquear el
  reintento de una NC en `ERROR`.
- `FiscalWorker` con barrido cada `FISCAL_WORKER_INTERVAL_MS`
  (30 s; `0` lo apaga para que los tests sean deterministas).
- **`providerFactory` inyectable**: los tests de integración prueban
  rechazos y caídas del fisco sin red.

**API — módulo `reports`**

- `GET /reports/sales`: ventas por día, producto o categoría, en
  centavos, solo comandas `CLOSED` (el rango se aplica sobre
  `closed_at`: la venta es de cuando se cerró). El importe por línea
  incluye el delta de modificadores vía `LATERAL`, para no inflar el
  `SUM` con la multiplicidad del join.

**Fase 3 — Experiencia del cliente**

- **`apps/storefront`** (Next.js): la cara pública del
  producto. Menú de mesa con fotos, alérgenos, descripción
  multilenguaje y disponibilidad; carrito y cuenta del servidor;
  takeaway con slots de retiro por capacidad; y consulta de
  puntos. Sin sesión: la autenticación es el token del QR.
- **Módulo `storefront`**: menú público por local, pedidos a
  mesa y takeaway, intents de pago y webhooks. Las rutas
  públicas están en `PUBLIC_ROUTES` y rate-limited — un QR es
  imprimible, así que el abuso se corta por volumen, no por
  sesión. Un token QR inválido es **404**, no 403: no revelar
  que la mesa existe vale más que un código preciso.
- **Token QR HMAC** ([ADR-0009](docs/adr/0009-qr-token-hmac.md),
  supuesto A-28): el secreto vive en `QR_TOKEN_SECRET` —**nunca
  en la base**— y la rotación es `tables.qr_token_version`: un
  `UPDATE` invalida todos los stickers impresos sin reimprimir
  la mesa. El token es opaco (no lleva ids) y se verifica sin
  consulta: no existe tabla de tokens que filtrar.
- **Aprobación configurable** (`venues.settings.qrApprovalMode`):
  `AUTO` (café: a cocina directo) y `WAITER` (bar: la orden nace
  `PENDIENTE_APROBACION` y solo sale a cocina cuando un mozo la
  aprueba, permiso `order.approve`). En ambos caminos, los tickets
  de cocina nacen por estación con la misma lógica del sync.
- **`packages/payment-providers`**: contrato `PaymentProvider`
  con errores clasificados como el fiscal (`PaymentRejectedError`
  terminal, `PaymentUnavailableError` transitorio,
  `WebhookSignatureError`) y tres adaptadores —mock
  determinístico, Mercado Pago y Stripe— con fetch inyectable
  para verificar el protocolo sin red. **El webhook verifica la
  firma sobre el `rawBody` crudo** (`rawBody: true` en `main.ts`,
  A-26) y compara de forma timing-safe; Stripe admite rotación de
  secreto.
- **Idempotencia en dos capas, ninguna confiada al proveedor**:
  el intent es único por `source_event_id` (el cliente manda un
  UUIDv7) y el webhook por `(provider, external_id)` — Mercado
  Pago reenvía, y un reenvío no puede acreditar dos veces.
- **Resolución de tenant público** por funciones `SECURITY
  DEFINER` acotadas (`platform_venue_tenant`,
  `platform_order_tenant`, `platform_intent_lookup`) que
  devuelven solo ids: abren el contexto RLS sin exponer filas,
  igual que el login en Fase 0. `payment_webhook_events` tiene
  RLS `FORCE` sin policy: solo se toca por esas funciones.
- **Módulo `loyalty`**: programas por organización, **acreditación
  automática al cerrar la comanda** —disparada desde ambos caminos
  de cierre (`closeOrder` y el sync aplicando `ORDER_CLOSED`),
  idempotente por `(order_id, program_id)`—, cliente creado al
  vuelo con `customer_phone`, puntos positivos que vencen a 365
  días, y **canje con ledger inmutable** (`loyalty_entries`,
  append-only por trigger, permiso `loyalty.redeem`). El servicio
  es opcional en `OrdersService`/`SyncService` para no romper los
  tests que construyen los servicios a mano.
- Migraciones `0012` (cliente: `customers`, `loyalty_programs`,
  `loyalty_entries`, `payment_intents`, `payment_webhook_events`,
  i18n de carta, `qr_token_version`, permisos `order.approve` /
  `loyalty.read` / `loyalty.redeem`) y `0013` (`orders.status` a
  `varchar(24)`: `PENDIENTE_APROBACION` no cabía en 16).
- **E2E de aceptación** (`pnpm test:e2e`, 5 tests): QR → cuenta →
  pago con webhook firmado e idempotente (y firma falsa rechazada
  con 401) → cierre desde el POS por `/sync/push` → puntos
  acreditados; takeaway → slot → retiro `READY` → puntos; y
  aprobación en modo `WAITER` con tickets nacidos solo tras la
  aprobación. Levanta la API **compilada** (`node dist/main.js`):
  los providers de Nest cargan por `design:paramtypes`, que
  esbuild no emite con fiabilidad bajo el transform de vitest.

- **Promociones offline**: las reglas bajan de `GET /promotions` a la
  réplica Dexie (tabla `priceRules`, schema v3) y el precio de
  mostrador lo evalúa `@comanda/pricing-engine` —el mismo paquete que
  corre el servidor— sobre la cache de `state/pricing.ts`. Sin esto,
  las promos nunca aplicarían a ventas de mostrador: el POS no llama
  a `POST /orders/:id/items`, siempre encola eventos (A-24).
- La hidratación llena la cache de precios **desde la réplica antes
  de tocar la red**: un arranque sin conexión sigue aplicando las
  promos de la última sincronización. Una promo corrupta se salta y
  se loguea; no se lleva puesta la hidratación de la carta.
- `/promotions` y `/venues` se hidratan con su propio `catch`: un
  rol sin `promotion.read` o un 500 de esos caminos no saca al POS
  de la carta.

**Backoffice**

- Secciones **Promociones** (CRUD de reglas con prioridad, horario y
  params), **Fiscal** (configuración del local y libro de comprobantes
  con estados y reintento) y **Reportes** (ventas por día/producto/
  categoría), conectadas a la API.

### Corregido

- **ESLint 9 sin flat config hacía fallar el lint de los seis paquetes.** Las
  dependencias estaban instaladas pero `eslint.config.mjs` no existía, así que el
  pipeline no podía pasar ni en el primer commit. Agregada la config con lint
  tipado. Al correrla aparecieron cinco piezas de código muerto que se corrigieron
  en vez de silenciarse, entre ellas una prop `caution` que no hacía nada y un
  `deps` sin usar en `applyOrderClosed` que dejaba una comanda cobrada desde otra
  tablet sin rastro de qué dispositivo la cerró.
- **Cerrar una comanda sin turno fallaba siempre.** `orders_closed_consistent`
  exige `shift_id NOT NULL` y el handler usaba solo el `shiftId` del payload. El
  `UPDATE` reventaba la constraint, el evento se marcaba `REJECTED` y **la mesa
  quedaba ocupada para siempre**. El turno ahora se resuelve en el servidor, que
  es el hecho autoritativo.
- **El signo del movimiento de efectivo lo decidía quien escribía**, así que un
  retiro podía guardarse como ingreso y el arqueo del turno quedaba desfasado
  para siempre. Ahora lo decide el tipo.
- **El script de roles no era SQL válido y rompía `docker compose up`.**
  `GRANT ... ON DATABASE current_database()` y `ALTER DATABASE current_database()`
  son sintaxis de comando y no aceptan una función. Como el entrypoint de Docker
  corre los scripts de init con `ON_ERROR_STOP=1`, el error abortaba la
  inicialización de la base y el contenedor no levantaba. Ahora las sentencias se
  generan con `\gexec`.

### Tests

- **E2E de la Fase 1 en verde**: cortar la red a mitad de comanda, seguir
  agregando ítems, reconectar y verificar **contra el servidor** que no hay pérdida
  ni duplicado. Validado por mutación (rompiendo `nextBatch`, el test falla).
- **Migraciones contra PGlite** (Postgres compilado a WASM): el SQL es válido, las
  migraciones son reversibles y la constraint acepta exactamente el catálogo del
  dominio. Corren en la etapa de calidad del CI sin servicio de base. No
  reemplazan la suite de integración: PGlite no tiene roles, así que la RLS queda
  sin ejercitar.
- **Cocina contra PostgreSQL real** (23 tests): el agrupamiento por estación, el ítem
  sin rutear yendo a la por defecto, la idempotencia de `ensureTicketsForOrder`, el
  ciclo de estados con su rechazo del retroceso, el bus emitiendo **después** del
  commit, y el aislamiento entre locales (un ticket del local A no se lee ni se avanza
  desde el B).
- **Promociones contra PostgreSQL real** (6 tests): la promo aplicada congela el
  snapshot `applied_rules` en la línea, el CRUD con RLS y el aislamiento entre
  organizaciones (una promo de un local no se ve ni se aplica desde el otro).
- **Fiscal contra PostgreSQL real** (5 tests): emisión con el proveedor inyectado,
  el rechazo del fisco es terminal (`RECHAZADA`), la caída reintenta con backoff
  hasta agotar en `ERROR`, la NC no duplica la FACT por la unicidad parcial, y
  la auditoría de cada transición.
- **Reportes contra PostgreSQL real** (3 tests): el rango aplica sobre `closed_at`,
  los modificadores entran en el importe y el promedio sale del total, no de
  promediar promedios.
- **Los bytes exactos del ticket ESC/POS**, con `toEqual` sobre fixtures escritos a
  mano y no con snapshots. Un snapshot se regenera con `--update` sin que nadie lo lea,
  y un byte de corte cambiado es el fallo más caro del sistema de impresión: nadie lo
  detecta hasta que el papel se acumula en el rollo.
- **La codificación a bytes** con los valores reales de CP850 y CP858 verificados
  contra la especificación: `ñ` en `0xA4`, `€` en `0xD5` solo en CP858, y el mismo
  símbolo (`¢`) en bytes distintos según la página.
- **El POS con un socket falso**: la reconexión con backoff la maneja el socket, el
  token viaja en el handshake, y una desconexión **no borra la réplica**. Ese último
  es el test que importa: si alguna vez se agrega un `clear()` en ese camino, un KDS
  desaparece en cada corte de red y el POS vuelve a no vender.
- **El POS con promos offline** (4 tests en `order.test.ts`): una promo vigente
  aplica y congela el snapshot, una de otro producto no cambia el precio, una fuera
  de vigencia (`endsOn` en el pasado, determinista) no aplica, y una dada de baja
  tampoco. Más 5 en `catalog.test.ts`: la hidratación valida regla por
  regla, una lista rota no saca la carta, la réplica llena la cache cuando
  no hay red, y sin token no se pide nada.
- **El adaptador fiscal** (13 tests): QR con los datos exactos, mock determinístico,
  WSFE con transporte falso (XML de pedido, clasificación de errores, contingencia
  con CAEA).
- **726 tests** (más 5 E2E): dominio (136), motor de promociones
  (47), design system (30), sync-client (56), ESC/POS (88),
  fiscal-adapters (13), payment-providers (10), admin (5), POS
  (61) y API (280, de los cuales 222 contra PostgreSQL real, 5
  contra PGlite, 48 unitarios y 5 E2E HTTP del flujo del
  cliente). Antes de esta etapa eran 650, con la API en 260.

### Decisiones documentadas

- [ADR-0005](docs/adr/0005-catalogo-de-eventos-unico.md) — un solo catálogo de
  eventos de sincronización.
- [ADR-0006](docs/adr/0006-socket-io-para-el-kds.md) — Socket.IO para el tiempo real
  del KDS, y por qué no SSE ni `ws` crudo.
- [ADR-0007](docs/adr/0007-cola-fiscal-en-la-base.md) — la cola de facturación vive
  en la base, no en BullMQ.
- [ADR-0008](docs/adr/0008-adaptador-fiscal.md) — WSFE con transporte y CMS
  inyectables, QR persistido y promos offline con el motor compartido.
- [ADR-0009](docs/adr/0009-qr-token-hmac.md) — Token QR de mesa: HMAC con
  secreto en variable de entorno y rotación por versión.

[No publicado]: https://github.com/comanda/comanda/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/comanda/comanda/releases/tag/v0.1.0


## [0.1.0] — Fase 0: fundaciones

Primer corte del producto. Entra lo que permite que todo lo demás sea seguro: sin
esto, cada feature que se sume encima hereda un modelo de datos sin aislamiento y
sin trazabilidad.

### Agregado

**Monorepo**
- pnpm workspaces + Turborepo, TypeScript estricto (`strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`).
- CI en tres etapas: calidad, integración con PostgreSQL real, y build con
  presupuesto de bundle.
- `docker compose` con PostgreSQL 16, Redis 7 y MinIO.

**Paquete compartido (`@comanda/domain`)**
- Dinero en enteros (centavos) + moneda. `allocate` reparte sin perder ni crear
  centavos; los descuentos por monto fijo y por porcentaje son funciones distintas
  para que no se confundan.
- UUIDv7 con estado monotono propio. Cuando se agotan los 4096 ids del
  milisegundo toma prestado un ms en vez de fallar, para que un pico de tráfico no
  deje al POS sin poder crear ids.
- Catálogo de **73 permisos finos** y los cuatro roles del plan, con el tope de
  descuento del Cajero modelado como constraint numérica y no como permiso.
- Contratos Zod de auth, tenancy y auditoría; errores en RFC 7807 con `code`
  estable, porque el POS necesita distinguir "no tenés permiso" de "el servidor
  se cayó".

**Motor de promociones (`@comanda/pricing-engine`)**
- Puro e isomorfico: el tiempo entra por parámetro y el motor nunca lee el reloj,
  así que el mismo input produce el mismo output hoy y dentro de un año.
- Horarios evaluados en hora local del local, con soporte de ventanas que cruzan
  la medianoche y margen de desfase de reloj por dispositivo.

**Design system (`@comanda/ui`)**
- Dirección "Enamel & Ink", derivada del sujeto real del producto.
- `azulejo` (primario) y `coca` (destructivo) son excluyentes por construcción: no
  existe un botón "primario destructivo".
- El elemento memorable es el rollo de comanda con guía de puntos.
- Targets táctiles de 48 px, foco único, `prefers-reduced-motion` respetado.
- Cinta de caution únicamente en acciones irreversibles.

**API**
- **Row Level Security** por organización con `ENABLE` + `FORCE`. Los tests
  conectan con el rol `comanda_app`: uno corrido como superusuario probaría un
  aislamiento que en producción no existe.
- **`audit_log` append-only** por tres capas: `REVOKE`, triggers y ausencia de
  policy de `UPDATE`/`DELETE`. Un trigger corre siempre, así que cubre también al
  owner de la tabla.
- Cadena de hashes por organización, verificable desde SQL durante una
  investigación.
- Auth con argon2id y pepper; el PIN usa el doble de esfuerzo y el id del usuario
  entra en el material.
- **Refresh rotativo con detección de reuso por familia**: usar un token ya
  rotado revoca la sesión completa.
- Login por PIN solo en dispositivos registrados y aprobados, y con el PIN
  acotado a los usuarios de ese local.
- Funciones `SECURITY DEFINER` acotadas para lo que ocurre antes de saber el
  tenant (alta de organización, login, refresh), con `REVOKE PUBLIC` y un chequeo
  en la migración que falla si alguna queda expuesta.
- Rate limiting en memoria: un Redis caído no puede abrir el login.

**POS**
- PWA con shell precacheado; la API nunca se cachea.
- Replica local en IndexedDB y outbox de eventos idempotentes con UUIDv7 y
  secuencia monotona por dispositivo.
- Login por PIN con teclado en pantalla de 64 px.
- Layout de barra: spine fijo, rollo de comanda al centro, bloque de cuenta.

**Backoffice**
- Layout de planilla densa: filas con filete de acero, sin cards ni sombras
  difusas.

**Base de datos**
- Migraciones reversibles, con checksum: editar una migración ya aplicada falla el
  deploy en vez de generar dos schemas distintos.
- Chequeo en la migración que falla si alguna tabla no tiene RLS.
- Seeds de dos locales (un café y un bar) con equipo, roles, permisos y
  dispositivos; idempotentes.

### Decisiones documentadas

- [ADR-0001](docs/adr/0001-monolito-modular.md) — monolito modular.
- [ADR-0002](docs/adr/0002-rls-y-roles.md) — roles de base de datos y RLS.
- [ADR-0003](docs/adr/0003-refresh-tokens-en-postgres.md) — sesiones en Postgres.
- [ADR-0004](docs/adr/0004-auditoria-append-only.md) — auditoría append-only.
- [DESIGN](docs/DESIGN.md) — dirección visual.
- [ASSUMPTIONS](docs/ASSUMPTIONS.md) — decisiones donde el plan era ambiguo.

### Tests

204 tests: dominio (84), motor de promociones (38), design system (30), API (92,
de los cuales 51 contra PostgreSQL real).
