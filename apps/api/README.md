# @comanda/api

API de Comanda: monolito modular en NestJS, con Row Level Security en PostgreSQL.

Fase 0 implementa lo que es la base de seguridad de todo lo demás: tenancy, auth,
RBAC y auditoría. El POS, el catálogo y la caja llegan en la Fase 1.

## Correrlo

```bash
pnpm db:migrate     # schema, RLS y capa de auditoría
pnpm db:seed        # datos de demo
pnpm dev            # http://localhost:3000/api/v1
```

OpenAPI en `/api/docs` fuera de producción.

## Estructura

```
src/
├─ config/env.ts              validación de entorno (falla al arrancar, no al recibir)
├─ database/
│  ├─ database.service.ts     pool, transacciones y contexto de tenant
│  ├─ rls.ts                  generación de las policies
│  ├─ security-layer.ts       RLS, triggers y privilegios (idempotente)
│  ├─ migrator.ts             migraciones con checksum
│  └─ migrations/*.sql        reversibles, cada una con su `.down.sql`
├─ common/
│  ├─ security/hash.ts        argon2id con pepper, tokens opacos
│  ├─ authz/                  guard de permisos y principal de sesión
│  ├─ middleware/             contexto de tenant y autenticación
│  └─ filters/                errores en RFC 7807
└─ modules/
   ├─ tenancy/                organización, locales, dispositivos
   ├─ auth/                   login, refresh, cierre de sesión
   ├─ rbac/                   permisos, roles, auditoría
   └─ audit/                  escritura en audit_log
```

## Reglas del código

### Todo acceso a datos pasa por contexto de tenant

```ts
// Correcto: la RLS filtra por organización sola.
await db.withTenant({ orgId }, async (client) => {
  await client.query(`SELECT * FROM venues`);
});

// Incorrecto: sin `app.current_org` las tablas de tenant son invisibles,
// y el `WHERE org_id = $1` a mano es una convención que un endpoint nuevo
// puede olvidar.
await db.query(`SELECT * FROM venues`);
```

`withTenant` usa `SET LOCAL` dentro de una transacción, así que el contexto se
descarta solo al terminar. Con un `SET` normal, la conexión volvería al pool con el
tenant del local anterior.

### Antes de saber el tenant: funciones `SECURITY DEFINER`

Login, refresh y alta de organización ocurren sin sesión. Hay funciones
específicas para eso (`auth_lookup_user_by_email`, `auth_lookup_refresh_token`,
`platform_find_organization`) con `SECURITY DEFINER`, `SET search_path`,
`REVOKE PUBLIC` y un grant explícito a `comanda_app`. Una migración verifica que
ninguna quede expuesta a `PUBLIC`.

### Todo endpoint declara permisos

```ts
@RequirePermissions('order.item.void')
@Post('orders/:id/void')
```

Un endpoint **sin** el decorador hace fallar el guard. Olvidarse es un error de
desarrollo visible, no una puerta abierta.

### Los errores son problem+json con `code` estable

El POS necesita distinguir "no tenés permiso" de "el servidor se cayó" para
decidir si reintenta, si pide PIN de supervisor o si muestra un error de red. El
`detail` está escrito para la persona que lo lee en el mostrador; el `code` no
cambia nunca.

## Tests

```bash
export TEST_DATABASE_URL=postgresql://comanda_app:comanda_app_dev@localhost:5432/comanda
export TEST_DATABASE_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/comanda

pnpm test              # unitarios + integración
pnpm test:unit         # solo unitarios (sin base)
pnpm exec vitest run test/integration
```

**La conexión de aserciones tiene que ser el rol de la aplicación.** Con un
superusuario, la RLS se ignora y los tests de aislamiento darían verde sin
comprobar nada; `createTestDatabase` falla a propósito si detecta esa situación.

- `test/unit/`: config, hashing, guard de permisos.
- `test/integration/`: aislamiento RLS, `audit_log` append-only, auth.

## Migraciones

- Numeradas y **reversibles**: cada `.sql` tiene su `.down.sql`.
- Con **checksum**: editar una migración ya aplicada falla el deploy, en vez de
  dejar desarrollo y producción con schemas distintos.
- La capa de seguridad (policies, triggers, privilegios) se aplica al final y es
  **idempotente**, porque corre en cada deploy.

`db:reset` borra el schema y reconstruye. Está bloqueado con `NODE_ENV=production`:
en un entorno real, un "down" se hace restaurando un backup.

## Migrar `INSERT ... RETURNING` con RLS

Un detalle que costó tiempo y merece quedar escrito: **`INSERT ... RETURNING`
falla si la fila insertada no es visible para las policies de SELECT.**

Al crear una organización, la fila nueva todavía no es visible (el tenant
recién creado no es el contexto de la sesión), así que:

```sql
INSERT INTO organizations (name) VALUES ($1) RETURNING id;
-- ERROR: new row violates row-level security policy for table "organizations"
```

El error menciona RLS y no el `RETURNING`, que es lo confuso. La solución es
generar el id en la aplicación y no usar `RETURNING` en ese punto.

## Módulos públicos: `storefront` y `loyalty`

La Fase 3 suma la cara que ve el **cliente**, sin sesión:

- **`storefront`**: menú público por local, token de QR
  (ver [ADR-0009](../docs/adr/0009-qr-token-hmac.md)),
  pedidos a mesa y takeaway, intents de pago y
  **webhooks de pago verificados e idempotentes**.
  Las rutas públicas están en `app.module.ts`
  (`PUBLIC_ROUTES`) y rate-limited; todo lo demás
  exige sesión y permiso (`order.approve` para aprobar
  un pedido QR en modo mozo, `loyalty.redeem` para
  canjear puntos).
- **`loyalty`**: programas por organización,
  acreditación automática al cerrar la comanda
  (idempotente por `(order_id, program_id)`) y
  canje con ledger inmutable (`loyalty_entries`,
  append-only por trigger).

Dos reglas de oro de estos módulos:

- **El webhook verifica la firma sobre el `rawBody`
  crudo** (`rawBody: true` en `main.ts`, supuesto
  A-26). Verificar sobre el body parseado rechaza
  webhooks válidos por diferencias de serialización.
- **La resolución de tenant público** pasa por
  funciones `SECURITY DEFINER` acotadas
  (`platform_venue_tenant`, `platform_order_tenant`,
  `platform_intent_lookup`) que devuelven **solo
  ids**: abren el contexto RLS sin exponer filas,
  igual que `auth_lookup_user_by_email` en Fase 0.

## E2E del flujo del cliente

```bash
pnpm test:e2e
```

Levanta la API **compilada** (`nest build && node
dist/main.js` en el puerto 3100) y pega por HTTP con
supertest. Por qué compilada y no el `AppModule` bajo
vitest: los providers de Nest cargan por
`design:paramtypes`, que esbuild no emite con
fiabilidad — el e2e prueba el mismo binario que
corre en producción.

Cubre los dos recorridos de aceptación:

1. **QR → cuenta → pago → cierre**: menú público,
   pedido a mesa, intent de pago, webhook firmado
   (idempotente: el mismo evento dos veces acredita
   una), firma falsa rechazada (401), cierre desde el
   POS por `/sync/push` y acreditación de puntos.
2. **Takeaway → retiro**: slot de retiro, pedido con
   `pickup_at`, avance a `READY` y puntos acreditados;
   más la aprobación en modo `WAITER` (el ticket de
   cocina nace solo después de
   `POST /storefront/orders/:id/approve`).

`vitest.e2e.config.ts` corre aparte de la suite de
integración: es la única capa que prueba el contrato
HTTP completo, incluido el proceso real del servidor.