# ***SaaS Gastronómico (POS + Autogestión + Back-office) — Plan técnico**

***Documento de arquitectura y plan de construcción. Nombre en clave: Comanda.**


## ***1. Visión, alcance y principios**

***Objetivo: plataforma cloud multi-tenant para bares y cafés: POS ultra rápido, autopedido por QR, stock con escandallos, finanzas, BI e integraciones. Mercado inicial: Argentina (AFIP, Mercado Pago, PedidosYa), con diseño country-agnostic.**

***Principios de diseño**

1. ***Offline-first: el POS nunca depende de internet para vender.**

2. ***Latencia percibida \< 100 ms en acciones de POS (UI optimista, datos locales).**

3. ***Todo es un evento auditable (event log inmutable).**

4. ***Multi-tenant estricto desde el día 1 (aislamiento por `tenant_id` + RLS).**

5. ***Adaptadores para todo lo externo (fiscal, pagos, delivery, contabilidad).**

6. ***Dinero en enteros (centavos) + moneda; nunca floats.**

***Personas: Mozo, Cajero, Barista/Cocina (KDS), Encargado, Dueño, Cliente final, Contador (solo export).**


## ***2. Arquitectura**

### ***2.1 Stack recomendado**

| **Capa** | **Tecnología** |
| - | - |
| Monorepo | pnpm + Turborepo |
| Frontend POS/Admin | React + TypeScript + Vite, PWA (Workbox), TailwindCSS, shadcn/ui, TanStack Query/Router, Zustand |
| Menú cliente / Takeaway | Next.js (SSR/ISR para SEO y velocidad en móvil) |
| Almacenamiento local | IndexedDB vía **Dexie** (o RxDB / PowerSync) |
| Backend | NestJS (Node 22, TS) modular monolith; REST + WebSocket (Socket.IO) |
| DB | PostgreSQL 16 (RLS), Redis (cache, colas, pub/sub) |
| Colas/Jobs | BullMQ (facturación, sync, webhooks, reportes) |
| Storage | S3-compatible (fotos, PDFs, exports) |
| ORM | Prisma o Drizzle + migraciones versionadas |
| Auth | JWT corto + refresh rotativo, PIN rápido para POS, OIDC opcional |
| Observabilidad | OpenTelemetry, Prometheus/Grafana, Sentry, logs JSON |
| Infra | Docker, Terraform, AWS/GCP, CI/CD GitHub Actions |
| Analítica | Vistas materializadas en PG (fase 1) → ClickHouse/BigQuery si escala |

> ***Decisión: monolito modular (NestJS modules con límites claros) en vez de microservicios; extraer solo billing/fiscal e integraciones si hace falta.**

### ***2.2 Diagrama lógico**

```
***[Tablet/PC POS (PWA)] <-> IndexedDB (cola outbox + réplica local)**

        ***|  HTTPS + WS (sync incremental)**

***[API Gateway/Nest] -- Auth/RBAC -- Módulos --> PostgreSQL (RLS) / Redis**

        ***|                                   \-> BullMQ workers -> Fiscal / Pagos / Delivery / Contable**

***[Next.js Menú QR / Takeaway] ---> API pública (rate-limited, token de mesa)**

***[Dashboard dueño (móvil, PWA)] <- WebSocket (ventas en vivo)**
```

### ***2.3 Multi-tenancy**

- ***Jerarquía: `Organization` → `Venue` (local) → `Device`.**

- ***Todas las tablas llevan `org_id` (y `venue_id` donde aplique). Row Level Security con `SET app.current_org`.**

- ***Subdominios por tenant opcionales (`cafe-luna.comanda.app`).**

- ***Planes y feature flags por organización (Starter / Pro / Enterprise).**


## ***3. Offline y sincronización (núcleo crítico)**

***Estrategia: outbox + eventos idempotentes + réplica local parcial.**

1. ***Réplica local (IndexedDB): catálogo, precios, promos, mesas, usuarios/PIN hash, stock aproximado, órdenes abiertas del turno.**

2. ***Outbox: cada acción (abrir mesa, agregar ítem, cobrar) genera un evento con `event_id` (UUIDv7), `device_id`, `seq`, `occurred_at`, `payload`. Se guarda local y se envía cuando hay conexión.**

3. ***Idempotencia: el servidor ignora `event_id` repetidos.**

4. ***Numeración local segura: órdenes con ID UUID + número visible `device_prefix-seq`. Tickets no fiscales offline; la factura fiscal se emite al reconectar (o usa contingencia fiscal según país: CAEA en AFIP).**

5. ***Resolución de conflictos:**

   - ***Orden: merge por ítem (los ítems son eventos append-only*; borrado = evento `ITEM_VOIDED`).**

   - ***Mesa ocupada por 2 dispositivos: gana el primer `occurred_at` del servidor; el otro recibe aviso y re-asigna.**

   - ***Stock: se aplican deltas (suma de movimientos), nunca valores absolutos.**

6. ***Pull incremental: `GET /sync/pull?since=<cursor>` con cursor por tabla; WS notifica cambios.**

7. ***Pagos offline: efectivo OK; tarjeta solo si el terminal/posnet lo permite (se registra como "pago externo"); QR/Mercado Pago requieren conexión (UI lo deshabilita con aviso).**

8. ***Indicador visual de estado (online / offline / sincronizando N eventos) siempre visible.**

9. ***Tests obligatorios: simulación de corte de red, reordenamiento de eventos, duplicados, reloj desfasado (usar `server_received_at` como autoridad de reportes).**


## ***4. Módulos y requisitos funcionales**

### ***4.1 POS y operativa diaria**

***Gestión de mesas y planos**

- ***Editor drag & drop de planos por sector (salón, terraza, barra); formas, capacidad, rotación.**

- ***Estados: `LIBRE`, `OCUPADA`, `PIDIÓ_CUENTA`, `RESERVADA`, `BLOQUEADA`. Color + temporizador de ocupación; alerta si supera umbral configurable.**

- ***Unir/separar mesas, transferir orden entre mesas y mozos.**

- ***Reservas básicas (fase 3).**

***Comandas y modificadores**

- ***Productos con grupos de modificadores* (obligatorio/opcional, min/max, multi-selección), ej: leche (entera/almendras/avena +$), punto de cocción, extra shot, sin hielo.**

- ***Notas libres, teclas rápidas, favoritos, búsqueda predictiva, combos.**

- ***Enrutamiento por estación: cada producto → impresora/KDS (barra, cocina, café). Tickets de comanda ESC/POS (WebUSB/red) y pantalla KDS con estados `nuevo → preparando → listo`.**

- ***Cursos/tiempos (entrada, principal), "mantener" y "disparar".**

***Cuentas complejas**

- ***Dividir por ítem, por partes iguales, por monto personalizado, por comensal (asiento).**

- ***Pagos mixtos (efectivo + tarjeta + QR). Propinas: % sugeridos, monto libre, reparto configurable (pool/por mozo).**

- ***Descuentos (% o fijo) con motivo y permiso; cortesías; anulaciones con motivo.**

- ***Pre-cuenta imprimible; cierre de mesa.**

***Promociones y Happy Hour (motor de reglas)**

- ***Reglas declarativas JSON: `{ scope: producto|categoría, schedule: {dias, desde, hasta, tz}, type: PERCENT|FIXED|BOGO|NXM|PRICE_OVERRIDE, priority, stackable }`.**

- ***Evaluación en cliente (offline) y servidor con el mismo paquete compartido (`packages/pricing-engine`). El precio aplicado se persiste en la línea (snapshot) para auditoría.**

- ***Tests de propiedad para evitar descuentos negativos o dobles.**

### ***4.2 Experiencia del cliente**

- ***Menú digital (Next.js): categorías, fotos, alérgenos (iconos normados), tags dietarios, disponibilidad en vivo (producto agotado), multi-idioma, modo oscuro.**

- ***QR por mesa: URL con token firmado y rotable (`/m/{venue}/{table_token}`). Pedido crea orden en estado `PENDIENTE_APROBACIÓN` (configurable: auto-aprobar o validar mozo).**

- ***Pago desde la mesa: ver cuenta, dividir, propina, pagar con Mercado Pago / Stripe, Apple Pay / Google Pay (vía PaymentRequest API). Webhooks verificados e idempotentes.**

- ***Takeaway / Click & Collect: horario de retiro (slots con capacidad), pago anticipado, notificación (WhatsApp/email/push) "tu pedido está listo", pantalla de retiros.**

- ***Fidelización: programas configurables (puntos por $ o tarjeta de sellos "6to gratis"), identificación por teléfono/QR/email, canje en POS, expiración de puntos, ledger inmutable de puntos.**

### ***4.3 Inventario y back-office**

- ***Insumos (ingredientes) con unidad base (g, ml, u), conversiones, costo promedio ponderado.**

- ***Escandallos / recetas: producto → lista de insumos con cantidad y merma teórica; sub-recetas; modificadores que alteran receta (leche de almendras reemplaza leche entera). Cálculo de costo y margen.**

- ***Descuento automático de stock al confirmar venta (evento `STOCK_CONSUMED`), reversión al anular.**

- ***Movimientos de stock (ledger): compra, venta, merma, ajuste, transferencia, conteo. Stock = suma de movimientos.**

- ***Mermas: registro con motivo (vencido, error cocina, rotura, cortesía), foto opcional, costo imputado.**

- ***Conteo físico (inventario cíclico) con diferencias valoradas.**

- ***Alertas y compras: stock mínimo/punto de reposición → sugerencia de OC por proveedor (par stock, lead time), envío por email/WhatsApp/PDF, recepción de mercadería con control contra OC, actualización de costos.**

### ***4.4 Administración y finanzas**

- ***Turnos y caja: apertura con fondo, movimientos (ingresos/egresos/retiros), arqueo ciego (el cajero declara efectivo sin ver el esperado; sistema calcula diferencia y la reporta al encargado), cierre Z.**

- ***Facturación electrónica: interfaz `FiscalProvider` con implementaciones por país (AFIP/ARCA WSFE: Factura A/B/C, Notas de crédito, CAE, QR fiscal; SII Chile; etc.). Cola con reintentos, estados `PENDIENTE/EMITIDA/RECHAZADA`, certificados cifrados por tenant. Homologación obligatoria antes de producción.**

- ***Roles y permisos (RBAC + permisos finos): ver §6.**

- ***Fichaje: entrada/salida por PIN (+ geocerca/IP opcional), cálculo de horas, extras, exportable a liquidación.**

### ***4.5 Reportes y BI**

- ***Ventas por día/hora/mozo/categoría/producto; mapa de calor día × franja.**

- ***Ingeniería de menú (matriz popularidad × margen): Estrellas, Caballos de batalla, Puzzles, Perros.**

- ***KPIs: ticket promedio, rotación de mesa, ventas por mozo, CMV (costo de mercadería vendida = consumo teórico valorizado), merma %, propinas, descuentos otorgados.**

- ***Dashboard en vivo (WebSocket) en móvil. Export CSV/XLSX/PDF, reportes programados por email.**

### ***4.6 Integraciones**

- ***Delivery (PedidosYa, Rappi, UberEats): interfaz `DeliveryAggregator` (webhooks de pedido entrante → orden unificada → KDS; sincronización de menú y disponibilidad; aceptar/rechazar). Mapeo de SKUs por canal.**

- ***Contabilidad: exportadores a Xero / QuickBooks (OAuth2), asientos de ventas, impuestos, medios de pago; export CSV genérico.**

- ***Pagos: `PaymentProvider` (Mercado Pago, Stripe). Conciliación diaria.**

- ***API pública y webhooks salientes para terceros (fase 4).**

### ***4.7 Requisitos técnicos transversales**

- ***Auditoría continua: tabla `audit_log` append-only* (sin UPDATE/DELETE por permisos de DB), con hash encadenado opcional. Registra: actor, dispositivo, IP, acción, entidad, before/after, motivo. Eventos críticos: anular ítem, descuento, apertura de cajón, cambio de precio, reimpresión, ajuste de stock, login fallido.**

- ***Multi-dispositivo: sesiones por dispositivo registrado (aprobación del dueño), revocación remota.**


## ***5. Modelo de datos (entidades principales)**

```
***organizations(id, name, plan, country, currency, tz)**

***venues(id, org_id, name, address, fiscal_config_id, settings)**

***users(id, org_id, name, email, pin_hash, status)**

***roles(id, org_id, name) / permissions(key) / role_permissions / user_roles(user_id, venue_id, role_id)**

***devices(id, venue_id, name, type, last_seen, revoked_at)**


***floors(id, venue_id, name) / tables(id, floor_id, label, seats, x, y, w, h, shape, status)**


***categories(id, org_id, name, sort) / products(id, org_id, category_id, name, price_cents, tax_rate, station_id, active, image_url, allergens[])**

***modifier_groups(id, name, min, max, required) / modifiers(id, group_id, name, price_delta_cents, recipe_override jsonb)**

***product_modifier_groups(product_id, group_id)**

***price_rules(id, org_id, venue_id, type, scope, schedule jsonb, params jsonb, priority, active)**


***orders(id, venue_id, table_id, channel[POS|QR|TAKEAWAY|DELIVERY], status, opened_by, opened_at, closed_at, guests, shift_id)**

***order_items(id, order_id, product_id, qty, unit_price_cents, applied_rules jsonb, status[ACTIVE|VOIDED], course, seat, note)**

***order_item_modifiers(order_item_id, modifier_id, price_delta_cents)**

***payments(id, order_id, method, amount_cents, tip_cents, provider, provider_ref, status, shift_id)**

***bill_splits(id, order_id, mode, allocations jsonb)**

***invoices(id, order_id, type, number, cae, cae_due, status, raw_request, raw_response)**


***ingredients(id, org_id, name, base_unit, avg_cost_cents, min_stock, reorder_point)**

***recipes(product_id, ingredient_id|sub_recipe_id, qty, waste_pct)**

***stock_movements(id, venue_id, ingredient_id, type, qty_delta, cost_cents, ref_type, ref_id, reason, created_by, created_at)**

***suppliers(id, org_id, name, contact, lead_time_days) / supplier_items**

***purchase_orders(id, supplier_id, status, ...) / purchase_order_lines / goods_receipts**


***shifts(id, venue_id, opened_by, opened_at, opening_float, closed_at, declared_cash, expected_cash, diff)**

***cash_movements(id, shift_id, type, amount_cents, reason)**

***time_entries(id, user_id, venue_id, clock_in, clock_out, source)**


***customers(id, org_id, phone, email, name) / loyalty_programs / loyalty_ledger(customer_id, delta, reason, order_id)**

***sync_events(event_id pk, device_id, seq, type, payload, occurred_at, received_at)**

***audit_log(id, org_id, venue_id, actor_id, device_id, ip, action, entity, entity_id, before, after, reason, created_at, prev_hash, hash)**
```

***Índices clave: `(venue_id, status)` en orders, `(ingredient_id, created_at)` en stock\_movements, particionado mensual de `audit_log` y `sync_events`.**


## ***6. Seguridad, roles y permisos**

| **Permiso** | **Mozo** | **Cajero** | **Encargado** | **Dueño** |
| - | - | - | - | - |
| Tomar pedidos / ver sus mesas | ✔ | ✔ | ✔ | ✔ |
| Cobrar / dividir cuenta | — | ✔ | ✔ | ✔ |
| Anular ítem enviado | — | — | ✔ | ✔ |
| Aplicar descuento | — | límite | ✔ | ✔ |
| Abrir/cerrar caja | — | ✔ | ✔ | ✔ |
| Ver arqueo con esperado | — | — | ✔ | ✔ |
| Ajustes de stock / compras | — | — | ✔ | ✔ |
| Finanzas, costos, reportes completos | — | — | parcial | ✔ |
| Usuarios, precios, fiscal | — | — | — | ✔ |

- ***Permisos como claves (`order.void`, `discount.apply`, etc.) verificadas en backend (guards) y reflejadas en UI.**

- ***Acciones sensibles piden PIN de supervisor (override) y quedan en auditoría.**

- ***Seguridad: TLS, cifrado en reposo, secretos en KMS/Secrets Manager, certificados fiscales cifrados por tenant, rate limiting, protección CSRF/XSS, validación Zod en bordes, OWASP ASVS L2, backups PITR, 2FA para dueño, cumplimiento de datos personales (Ley 25.326 AR / GDPR si aplica), PCI-DSS delegado a pasarelas (nunca almacenar PAN).**


## ***7. API (convenciones)**

- ***REST versionada `/api/v1`, OpenAPI generada, errores RFC 7807.**

- ***Recursos: `/venues/{id}/tables`, `/orders`, `/orders/{id}/items`, `/orders/{id}/split`, `/orders/{id}/pay`, `/shifts`, `/stock/movements`, `/reports/*`, `/sync/push`, `/sync/pull`, `/public/menu/{venue}`, `/public/table/{token}/orders`, `/webhooks/{provider}`.**

- ***WebSocket canales: `venue:{id}:orders`, `venue:{id}:tables`, `venue:{id}:kds`, `org:{id}:live-sales`.**

- ***Idempotency-Key obligatorio en endpoints de pago y creación de órdenes.**


## ***8. Requisitos no funcionales**

| **Aspecto** | **Meta** |
| - | - |
| Disponibilidad | 99.9% API; POS 100% operativo offline |
| Rendimiento | Agregar ítem \< 100 ms UI; API p95 \< 300 ms |
| Escala inicial | 1.000 locales, 50 órdenes/min pico por local |
| RPO / RTO | 5 min / 1 h |
| Accesibilidad | WCAG AA en menú cliente; POS con targets táctiles ≥ 48 px |
| i18n | es-AR por defecto, es/en/pt; moneda y impuestos por país |
| Testing | Unit (Vitest), integración (Testcontainers), E2E (Playwright, incl. offline), carga (k6) |


## ***9. Estructura del monorepo**

```
***comanda/**

├─ ***apps/**

│  ├─ ***pos/            # PWA React (POS, KDS, caja)**

│  ├─ ***admin/          # Backoffice (inventario, reportes, config) PWA**

│  ├─ ***storefront/     # Next.js: menú QR, takeaway, loyalty**

│  └─ ***api/            # NestJS**

│     └─ ***src/modules/{auth,tenancy,catalog,tables,orders,pricing,payments,**

│                     ***billing-fiscal,inventory,purchasing,cash,staff,loyalty,**

│                     ***reports,integrations,sync,audit,notifications}**

├─ ***packages/**

│  ├─ ***pricing-engine/ # reglas de promos/happy hour (isomórfico)**

│  ├─ ***domain/         # tipos, eventos, validaciones Zod compartidas**

│  ├─ ***sync-client/    # outbox, Dexie, reconciliación**

│  ├─ ***ui/             # design system**

│  └─ ***fiscal-adapters/{afip,sii,...}**

├─ ***infra/ (terraform, docker)**

├─ ***docs/ (ADR, runbooks, OpenAPI)**

└─ ***.github/workflows**
```


## ***10. Roadmap por fases**

| **Fase** | **Duración est.** | **Entregables** |
| - | - | - |
| **0. Fundaciones** | 2–3 sem | Monorepo, CI/CD, auth, multi-tenant + RLS, RBAC, auditoría base, design system |
| **1. MVP POS** | 6–8 sem | Catálogo, modificadores, planos/mesas, comandas, KDS/impresión, cobro efectivo/tarjeta, split bill, propinas, caja y turnos, **offline + sync** |
| **2. Fiscal y promos** | 4–5 sem | AFIP (homologación → prod), motor de promos/Happy Hour, arqueo ciego, reportes básicos |
| **3. Cliente** | 5–6 sem | Menú digital, QR + pago Mercado Pago/Stripe, takeaway, loyalty |
| **4. Inventario** | 5–6 sem | Insumos, escandallos, descuento automático, mermas, alertas, OC y proveedores |
| **5. BI y personal** | 4 sem | Heatmaps, ingeniería de menú, CMV, KPIs, dashboard en vivo, fichaje |
| **6. Ecosistema** | 5–6 sem | PedidosYa/Rappi/UberEats, Xero/QuickBooks, API pública y webhooks |
| **7. Hardening** | continuo | Carga, seguridad (pentest), onboarding, billing SaaS (suscripciones) |

***Riesgos principales: sincronización offline (mitigar con tests de caos), homologación fiscal (empezar temprano), APIs de delivery con acceso restringido (gestionar alianzas), hardware heterogéneo de impresoras (abstraer driver ESC/POS).**


## ***11. Definition of Done por feature**

- ***Casos de uso con tests unitarios + E2E; funciona offline si es de POS.**

- ***Permisos y eventos de auditoría definidos.**

- ***Migración de DB reversible, OpenAPI actualizada, docs/ADR si hay decisión arquitectónica.**

- ***Métricas y logs; sin regresión de performance (presupuesto de bundle POS \< 300 KB inicial gz).**

