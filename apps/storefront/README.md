# @comanda/storefront

La **cara pública** del SaaS: el menú digital que el cliente abre
con el QR de la mesa, el pedido takeaway y la consulta de puntos de
fidelización. Next.js (App Router), sin login: el acceso se
autentica con el token del QR o con el id del local.

## Correrlo

```bash
cp .env.example .env    # del repo raíz
pnpm dev                # API en :3000
pnpm --filter @comanda/storefront dev
```

| Variable | Para qué | Default |
| - | - | - |
| `NEXT_PUBLIC_API_URL` | Base de la API | `http://localhost:3000/api/v1` |

El token QR **no** se configura acá: lo genera la API (ver
[ADR-0009](../docs/adr/0009-qr-token-hmac.md)).

## Rutas

| Ruta | Qué es |
| - | - |
| `/` | Landing: qué es el producto y cómo se entra (QR, takeaway, POS). |
| `/m/[venueId]/[tableId]` | **Menú de mesa**: carta con fotos, alérgenos y disponibilidad; carrito; envío del pedido a la mesa; cuenta del servidor (lo que va sumando); inicio de pago. |
| `/takeaway/[venueId]` | **Takeaway**: carta, slots de retiro con capacidad por franja, carrito y polling del estado del pedido. |
| `/loyalty` | Consulta de saldo de puntos por teléfono. |

El menú de mesa es dinámico por diseño: la carta y el estado de la
mesa salen de la API en cada visita, así que el cliente siempre ve
lo que el local tiene ahora (un item agotado desaparece sin deploy).

## Cómo se autentica el pedido

Nada de sesión: el pedido se crea con el **token del QR**
(`/m/[venueId]/[tableId]` lo lee de la URL). La API lo verifica
con HMAC (ver ADR-0009) y resuelve mesa y local; un token inválido
o de otra mesa es 404, no 403 —no revela que la mesa existe.

Los endpoints públicos están **rate-limited** en la API
(`@nestjs/throttler`): un QR es público y printable, así que el
abuso se corta por volumen, no por sesión.

## Pago

El storefront **inicia** el pago (`POST /storefront/orders/:id/payment-intents`)
y muestra el monto y el estado de la cuenta. En producción, el
botón de pago redirige al checkout del proveedor (MP/Stripe) con el
`externalIntentId`; el webhook del proveedor —no el storefront—
confirma el cobro. Con el proveedor `mock` (demo y tests) la
confirmación se simula firmando el webhook, cosa que hace el E2E de
la API y no la UI: la UI no tiene el secreto del webhook, y no
debería tenerlo.

## Takeaway

Los slots de retiro los calcula la API (`GET
/storefront/takeaway/slots`): ventanas de 15 minutos con capacidad
(`takeaway_config` del local: `capacity_per_slot`,
`max_slots_ahead`, `min_lead_minutes`). El cliente elige franja;
el pedido nace con `pickup_at`.

**El estado del retiro se consulta por polling** (cada 5 s, `GET
/storefront/orders/:id/takeaway-status`), no por push: la página
es pública y sin sesión, así que no hay canal donde el servidor
pueda avisar. Supuesto [A-27](../docs/ASSUMPTIONS.md); las
notificaciones reales (WhatsApp/email) quedan como adapter para
después.

## Fidelización

`/loyalty` consulta el saldo por teléfono (`GET
/storefront/loyalty/balance?phone=...`): puntos positivos vigentes
(vencen a 365 días), puntos por vencer y el programa del local.
El **canje** no es público: es una acción de caja, con el permiso
`loyalty.redeem`, desde el POS o el backoffice.

## Estructura

```
app/
├─ layout.tsx                 shell público
├─ page.tsx                   landing
├─ m/[venueId]/[tableId]/     menú de mesa (MenuClient.tsx)
├─ takeaway/[venueId]/        takeaway con slots
└─ loyalty/                   consulta de puntos
```

Todo el estado del carrito vive en el cliente; el servidor de Next
solo compone la página. La API es la única fuente de verdad de la
carta y de la cuenta: no hay precios ni nombres de producto en el
código de esta app.

## Tests

```bash
pnpm --filter @comanda/storefront typecheck
pnpm --filter @comanda/storefront lint
pnpm --filter @comanda/storefront build   # / y /loyalty estáticas
```

El flujo completo —QR → pedido → pago con webhook firmado → cierre
de mesa, y takeaway → retiro— se prueba en el E2E de la API
(`apps/api/test/e2e/storefront-flow.e2e.test.ts`), que levanta la
API compilada y pega por HTTP: el contrato es el que se prueba, no
esta UI.
