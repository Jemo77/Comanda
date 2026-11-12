# Comanda

SaaS multi-tenant para bares y cafés: POS, autopedido QR, inventario con
escandallos, finanzas, BI e integraciones.

**Estado:** Fases 0 (fundaciones), 1 (POS + offline)
y 2 (fiscal, promociones, reportes) **completas**.
**Fase 3 (cliente) completa**: menú digital QR,
pedidos desde la mesa con aprobación configurable,
pagos con webhooks verificados, takeaway con slots
de retiro y fidelización. Ver
[Qué hay y qué no](#qué-hay-y-qué-no).

---

## Correrlo local

```bash
cp .env.example .env          # y cambiá los secretos
docker compose up -d          # postgres, redis, minio
pnpm install
pnpm db:migrate               # crea el schema, RLS y auditoría
pnpm db:seed                  # dos locales de demo con equipo y dispositivos
pnpm dev                      # API + POS + admin
```

| Servicio | URL |
| - | - |
| API | http://localhost:3000/api/v1 |
| Documentación OpenAPI | http://localhost:3000/api/docs |
| POS | http://localhost:5173 |
| Backoffice | http://localhost:5174 |
| Storefront (menú QR, takeaway) | http://localhost:3001 |

### Entrar

El seed crea dos locales con equipo y roles.

**Con PIN (así entra el mozo en el mostrador):** elegí el dispositivo
`Tablet Barra` en la pantalla del POS y tipeá el PIN del mozo.

| Local | Usuario | Rol | PIN |
| - | - | - | - |
| Cafe Luna | Nico Alvarez | Mozo | `1357` |
| Cafe Luna | Tomas Reinoso | Mozo | `2468` |
| Cafe Luna | Juana Pryce | Cajero | `5577` |
| Cafe Luna | Marcos Belloni | Encargado | `9134` |
| Cafe Luna | Valeria Soto | Dueño | `4821` |
| Bar Orion | Diego Sosa | Mozo | `3344` |

**Con correo y contraseña** (dueño y encargado, desde el navegador):
`valeria@cafe-luna.test` / `Comanda1234!`

---

## Qué hay y qué no

**Fase 0, implementado:**

- Monorepo pnpm + Turborepo, TypeScript estricto, CI con PostgreSQL real.
- **Aislamiento por organización con Row Level Security**, verificado con tests que
  conectan con el mismo rol que la API.
- `audit_log` **append-only garantizado en la base** (permisos + triggers) con
  cadena de hashes verificable.
- Auth: correo + contraseña, **PIN por dispositivo registrado** y aprobado,
  JWT corto con **refresh rotativo y detección de reuso**.
- RBAC con **75 permisos finos**, los cuatro roles del plan y verificación en el
  backend (la UI solo refleja).
- Design system "Enamel & Ink" y los layouts del POS y del backoffice.
- Seeds de demo idempotentes.
- Outbox offline del POS con eventos idempotentes (UUIDv7) y detección de huecos.

**Fase 1, implementado:**

- Esquema de las 18 tablas del POS (catálogo, salón, comandas, cobro, caja, KDS,
  sync) con RLS y constraints de integridad.
- **`@comanda/sync-client`**: outbox, réplica local (Dexie) y reconciliación. Es el
  núcleo del modo offline.
- `SyncService` con `/sync/push` y `/sync/pull`, idempotencia por `eventId`,
  cursor incremental y resolución de conflictos de mesa.
- **Los 20 tipos de evento tienen handler.** Antes, 14 de ellos caían en el
  `default` con "tipo de evento sin handler".
- **El total se calcula una sola vez.** `orderTotals()` del dominio corre en el POS
  y en el servidor: es lo único que garantiza que el número que ve el mozo y el que
  cobra el sistema sean el mismo. Antes había dos implementaciones y divergían.
- Módulos de API: `catalog`, `tables`, `orders`, `payments`, `cash`, `kds`, más
  `sync`. El camino online y el offline comparten `orders/order-state.ts`, así que
  no hay dos políticas de total ni de cierre; y el agrupamiento de items por
  estación vive en `kds/kds.service.ts` para que el sync y el endpoint online no
  reimplanten a qué impresora va cada papel.
- **Arqueo ciego estructural**: la respuesta al cajero no tiene las claves
  `expectedCashCents` ni `diffCents`. No se las esconde; no existen en el objeto.
- Cobro mixto con `Idempotency-Key` obligatorio, split bill (tres modos + por
  comensal) y propinas.
- Auditoría de las acciones sensibles del sync: anular, cobrar, descontar y mover
  caja quedan con actor, dispositivo, importe y motivo.
- POS: mapa de mesas con temporizador de ocupación, comandas con modificadores y
  notas, cobro mixto con propinas, pantalla de cocina, indicador de estado de sync.
- **KDS en tiempo real por WebSocket** (`/ws/kds`): el ticket nuevo aparece sin que
  el POS haga un pull. La sesión se verifica **en el handshake**, porque los guards
  de Nest leen el principal que arma el middleware de HTTP y un socket no pasa por
  ahí; y la base sigue siendo la fuente de verdad: el gateway relee la fila y emite
  lo que dice. Ver el [ADR-0006](docs/adr/0006-socket-io-para-el-kds.md).
- **`@comanda/escpos`**: tickets de cocina y comprobantes en ESC/POS, con la
  codificación CP850/CP858 para que los acentos salgan como acentos y no como dos
  símbolos raros. Tres drivers (consola, TCP, WebUSB) detrás de una interfaz
  `write(bytes)` que no sabe qué es un ticket. Los bytes se prueban con `toEqual`
  sobre fixtures, no con snapshots.
- Descubrimiento del aparato (`POST /devices/resolve`) para que un POS recién
  instalado sepa si está autorizado antes de tener credenciales.
- Semilla de carta: 45 productos en 5 categorías, 5 grupos de modificadores,
  estaciones y 24 mesas en los dos locales.
- **E2E de aceptación en verde**: cortar la red a mitad de comanda, seguir
  vendiendo, reconectar, y el servidor termina con cada ítem una sola vez.
- Tests de migración contra PGlite: SQL válido, migraciones reversibles y la
  constraint de eventos alineada con el catálogo del dominio.
- **650 tests** (260 de la API contra PostgreSQL real) + 4 E2E.

**Corregido, encontrado al correr y levantar el producto** (no al leer el código):

- El script de roles no era SQL válido y **rompía `docker compose up`**. Ahora se
  genera con `\gexec`; hay una receta en el README para correr sin Docker.
- `nest build` caía en `dist/src/` mientras `package.json` apuntaba a `dist/`:
  **`pnpm start` no arrancaba**. Con `rootDir` explícito.
- **Tailwind no generaba ninguna utilidad**: faltaba `@tailwindcss/vite`. El build
  pasaba, los tests pasaban, y el POS se veía entero como texto negro sobre blanco.
- **`fetch` sin `.bind`** en el transporte de sync: Node lo tolera, el navegador
  tira `Illegal invocation`. **El POS no subía nada** y la outbox no vaciaba nunca.
- `logoutAndClear()` borraba la réplica en cada arranque: la carta se cargaba y
  desaparecía sola.
- Dos bases IndexedDB con el mismo nombre y esquemas distintos se pisaban entre sí.

**Fase 1, pendiente:**

- Nada de lo enumerado en el plan. El KDS en tiempo real y la impresión ESC/POS
  quedaron cerrando la fase.

**Fase 2, implementado:**

- **Motor de promociones conectado.** CRUD de reglas en la API
  (módulo `promotions`), evaluación en el servidor **y en el POS
  offline** con el mismo `@comanda/pricing-engine`: las reglas
  bajan de `GET /promotions` a la réplica Dexie (`priceRules`)
  y el precio de mostrador con Happy Hour aplica sin red. La
  línea congela `unitPriceCents` + `appliedRules` como snapshot.
  Backoffice: sección Promociones.
- **Facturación fiscal** (módulo `billing-fiscal`, paquete
  `@comanda/fiscal-adapters`): emisión de FACT A/B/C y NC por
  comanda cerrada, desglose de IVA por alícuota, CAE y QR
  persistidos, y **cola de reintentos en la base** (no BullMQ:
  la tabla `invoices` es la cola, ver
  [ADR-0007](docs/adr/0007-cola-fiscal-en-la-base.md)). Estados
  `PENDING → EMITIDA / RECHAZADA / ERROR`, backoff exponencial,
  contingencia con CAEA, y proveedor AFIP WSFE con transporte y
  firma CMS inyectables (ver
  [ADR-0008](docs/adr/0008-adaptador-fiscal.md)). Backoffice:
  sección Fiscal (configuración y libro de comprobantes).
- **Reportes básicos de ventas** (`GET /reports/sales`): por día,
  producto y categoría, en centavos, solo comandas cerradas.
  Backoffice: sección Reportes.
- **Configuración fiscal del local** (`fiscal_settings`):
  proveedor, ambiente (homologación/producción), punto de venta,
  CUIT y CAEA de contingencia.
- Seed de demo: tres promociones (Happy Hour de fernet lun-jue
  18-20, 2x1 de café los miércoles, miércoles de barra -10%),
  configuración fiscal en `mock`/homologación y `tax_rate` en
  los 45 productos.

**Fase 3, implementado:**

- **Menú digital QR** (`apps/storefront` + módulo
  `storefront`): el QR de la mesa es un token
  HMAC (ver
  [ADR-0009](docs/adr/0009-qr-token-hmac.md));
  un token inválido es 404, no 403. La carta
  pública muestra fotos, alérgenos, descripción
  multilenguaje (`name_i18n`) y disponibilidad.
- **Pedidos desde la mesa** con aprobación
  configurable por local
  (`venues.settings.qrApprovalMode`): `AUTO`
  (a cocina directo) o `WAITER` (la orden nace
  `PENDIENTE_APROBACION` y sale a cocina solo
  cuando un mozo la aprueba con
  `POST /storefront/orders/:id/approve`,
  permiso `order.approve`). En ambos caminos
  se crean los tickets de cocina por estación.
- **Pagos con `@comanda/payment-providers`**:
  intents idempotentes por `source_event_id` y
  **webhooks verificados sobre el `rawBody`
  crudo** e idempotentes por
  `(provider, external_id)`. Adaptadores mock
  (determinístico), Mercado Pago y Stripe con
  fetch inyectable.
- **Takeaway**: slots de retiro con capacidad
  por franja (`takeaway_config`: ventanas de
  15 min), pedido con `pickup_at` y consulta
  de estado por polling (supuesto A-27).
- **Fidelización** (módulo `loyalty`): programas
  por organización, **acreditación automática
  al cerrar la comanda** (idempotente, cliente
  creado al vuelo con `customer_phone`), puntos
  que vencen a 365 días, y **canje con ledger
  inmutable** (`loyalty_entries`, append-only,
  permiso `loyalty.redeem`).
- Migraciones `0012` (cliente: customers,
  loyalty, payment_intents, webhooks, i18n,
  permisos nuevos) y `0013` (`orders.status` a
  `varchar(24)` para `PENDIENTE_APROBACION`).
- **E2E de aceptación en verde**
  (`pnpm test:e2e`): QR → pedido → pago con
  webhook firmado (idempotente) → cierre de
  mesa desde el POS → puntos acreditados; y
  takeaway → retiro READY; más aprobación en
  modo mozo. La API se levanta **compilada**
  (`node dist/main.js`) porque los providers de
  Nest no cargan con fiabilidad bajo el
  transform de vitest.
- Seed de demo: `qrApprovalMode` por tipo de
  local (café AUTO, bar WAITER), enriquecimiento
  de productos (imagen, alérgenos, descripción,
  i18n), programa de puntos por organización y
  cliente demo.

**Fases siguientes:**

- Notificaciones reales de takeaway (adapter
  WhatsApp/email, hoy por polling A-27),
  inventario con escandallos, BI completo
  (CMV, ingeniería de menú, heatmaps), y
  UI del POS para aprobar comandas QR y canjear
  puntos: **Fases 4 a 5 y pulido de la 3**.
- El `CmsSigner` de producción (material fiscal
  desde el vault) llega con el secret manager
  (PLAN §14).

---

## Estructura

```
comanda/
├─ apps/
│  ├─ pos/          PWA del mostrador (offline-first)
│  ├─ admin/        Backoffice
│  ├─ storefront/   Menú QR, takeaway y fidelización (Next.js, público)
│  └─ api/          NestJS: tenancy, auth, rbac, audit, sync, catalog, tables,
│                   orders, payments, cash, kds, promotions, billing-fiscal,
│                   reports, storefront, loyalty
├─ packages/
│  ├─ domain/       dinero, ids, permisos, roles, auditoría, contratos del POS,
│  │                división de cuentas, catálogo de eventos de sync (isomorfico)
│  ├─ sync-client/  outbox, réplica local (Dexie) y reconciliación (núcleo del offline)
│  ├─ escpos/       tickets ESC/POS y drivers de impresión (isomorfico)
│  ├─ pricing-engine/  motor de promociones (puro, isomorfico)
│  ├─ fiscal-adapters/  AFIP/ARCA WSFE, QR, mock (contrato FiscalProvider)
│  ├─ payment-providers/  mock/MercadoPago/Stripe (contrato PaymentProvider)
│  └─ ui/           design system "Enamel & Ink"
├─ infra/           docker, scripts de base de datos
└─ docs/            plan, ADRs, supuestos, diseño
```

Cada paquete tiene su README con las decisiones que no se ven en el código.

---

## Comandos

```bash
pnpm dev              # todo en paralelo
pnpm build            # build de todos los paquetes
pnpm lint             # ESLint
pnpm typecheck        # TypeScript estricto
pnpm test             # suite completa
pnpm test:coverage    # con cobertura

pnpm db:migrate       # aplica migraciones pendientes
pnpm db:seed          # datos de demo (idempotente)
pnpm db:reset         # borra el schema y lo reconstruye (solo desarrollo)
```

### Tests de integración

Necesitan PostgreSQL con los roles `comanda_*` creados.

```bash
export TEST_DATABASE_URL=postgresql://comanda_app:comanda_app_dev@localhost:5432/comanda
export TEST_DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/comanda
pnpm --filter @comanda/api exec vitest run
```

`TEST_DATABASE_URL` **tiene que ser el rol de la aplicación**. Si apunta a un
superusuario, la suite falla a propósito: con superusuario la RLS se ignora y los
tests de aislamiento darían verde sin comprobar nada.

Con Docker, `pnpm test` alcanza; los roles los crea
`infra/docker/postgres/init/01-roles.sql`.

### Tests de migración (sin base de datos)

Las migraciones se ejecutan contra **PGlite**, un PostgreSQL compilado a WASM. No
necesitan servicio, así que corren en la etapa de calidad del CI y también desde
el editor:

```bash
pnpm --filter @comanda/api exec vitest run test/migrations.test.ts
```

Comprueban que el SQL es válido, que cada migración baja sin dejar schema colgando
y que la constraint de eventos de sync acepta exactamente el catálogo del
dominio. **No reemplazan** la suite de integración: PGlite no tiene roles de base
de datos, así que la RLS y los `SECURITY DEFINER` quedan sin ejercitar.

### Postgres local sin Docker

Si tenés PostgreSQL instalado pero no querés levantar Docker, alcanza con un
cluster propio. El punto importante es que los tests de aserciones usen el rol
`comanda_app`, no un superusuario, o la RLS se ignora y el aislamiento no se prueba.

```bash
initdb -D /tmp/pgdata -U "$USER" --locale=C.UTF-8
echo "unix_socket_directories = '/tmp'" >> /tmp/pgdata/postgresql.conf
pg_ctl -D /tmp/pgdata -l /tmp/pg.log -w start

createdb -h /tmp -U "$USER" comanda
psql -h /tmp -U "$USER" -d comanda -v ON_ERROR_STOP=1 \
  -f infra/docker/postgres/init/01-roles.sql

export DATABASE_MIGRATIONS_URL="postgresql://comanda_migrator:comanda_migrator_dev@localhost:5432/comanda"
export DATABASE_URL="postgresql://comanda_app:comanda_app_dev@localhost:5432/comanda"
export TEST_DATABASE_URL="$DATABASE_URL"
export TEST_DATABASE_ADMIN_URL="postgresql://$USER@localhost:5432/comanda"
export JWT_ACCESS_SECRET="local-access-secret-que-no-protege-nada-000000"
export PIN_PEPPER="local-pin-pepper-que-no-protege-nada-00"
export QR_TOKEN_SECRET="local-qr-token-secret-que-no-protege-nada-000"
export PAYMENT_WEBHOOK_SECRET="local-webhook-secret-que-no-protege-na-0"

pnpm db:migrate && pnpm db:seed && pnpm test
```

Para parar el servidor: `pg_ctl -D /tmp/pgdata stop`.

### Probar la facturación sin el fisco

El seed deja la configuración fiscal de los dos locales en
`provider: mock`, ambiente `homo`. Con eso, facturar una comanda
cerrada emite un comprobante determinístico (CAE y número derivados
del id de la fila) y devuelve el CAE y el QR en la respuesta:

```bash
# 1. Abrir sesión, tomar una comanda, cerrarla (POS).
# 2. Emitir el comprobante:
curl -X POST "$API/api/v1/fiscal/invoices/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type": "FACT_B", "receiver": {"name": "Consumidor Final", "taxId": "0", "condition": "CONSUMIDOR_FINAL"}}'
# 3. Ver la cola y el libro:
curl "$API/api/v1/fiscal/invoices" -H "Authorization: Bearer $TOKEN"
```

Para probar la **cola de reintentos** y los rechazos, los tests de
integración inyectan un proveedor que cae o rechaza
(`billing-fiscal.test.ts`): `FiscalUnavailableError` reintenta con
backoff hasta `max_attempts` y pasa a `ERROR`; `FiscalRejectionError`
es terminal y pasa a `RECHAZADA`.

El proveedor `afip` (WSFE real) está cableado pero **no emite en este
entorno**: firmar el XML exige el .p12 del contribuyente, que vive en
el vault (PLAN §14). Sin material, levanta
`FiscalUnavailableError` y la cola reintenta —facturar con un
certificado de mentira es peor que no facturar.

---

## Decisiones documentadas

| Documento | De qué va |
| - | - |
| [`docs/PLAN.md`](docs/PLAN.md) | Plan técnico maestro |
| [`docs/ADR-0001`](docs/adr/0001-monolito-modular.md) | Por qué monolito modular |
| [`docs/ADR-0002`](docs/adr/0002-rls-y-roles.md) | Roles de base de datos y RLS |
| [`docs/ADR-0003`](docs/adr/0003-refresh-tokens-en-postgres.md) | Sesiones en Postgres, no en Redis |
| [`docs/ADR-0004`](docs/adr/0004-auditoria-append-only.md) | Auditoría append-only |
| [`docs/ADR-0005`](docs/adr/0005-catalogo-de-eventos-unico.md) | Un solo catálogo de eventos de sincronización |
| [`docs/ADR-0006`](docs/adr/0006-socket-io-para-el-kds.md) | Socket.IO para el tiempo real del KDS |
| [`docs/ADR-0007`](docs/adr/0007-cola-fiscal-en-la-base.md) | La cola de facturación vive en la base, no en BullMQ |
| [`docs/ADR-0008`](docs/adr/0008-adaptador-fiscal.md) | Adaptador fiscal: WSFE con transporte y CMS inyectables |
| [`docs/ADR-0009`](docs/adr/0009-qr-token-hmac.md) | Token QR de mesa: HMAC con secreto en env y rotación por versión |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Dirección visual del producto |
| [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) | Decisiones donde el plan era ambiguo |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Historial |

---

## Reglas que no se rompen

1. **Dinero siempre en enteros** (centavos) con moneda. Nunca float.
2. **Multi-tenant estricto**: `org_id` en toda tabla, RLS en toda tabla de negocio.
3. **Verificación de permisos en el backend.** La UI solo refleja.
4. **Acciones sensibles con motivo**, y el motivo en el registro.
5. **Idempotencia en la outbox** (UUIDv7), para poder reenviar sin miedo.
6. **Nada de código muerto ni TODOs sin issue.**

---

## Autoría

Proyecto personal de **Jorge Martín** ([Jemo77](https://github.com/Jemo77)). El repositorio reúne el diseño, la implementación y la documentación técnica de la plataforma.
