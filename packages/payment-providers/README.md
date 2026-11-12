# @comanda/payment-providers

Adaptadores de pago para la Fase 3 (menú QR y pedidos del cliente).
Un contrato y tres implementaciones: **mock** (determinístico, para
tests y demo), **Mercado Pago** y **Stripe**.

## Contrato

```ts
interface PaymentProvider {
  readonly provider: 'mock' | 'mercadopago' | 'stripe';
  createIntent(input: CreateIntentInput): Promise<PaymentIntent>;
  verifyWebhook(rawBody: string | Buffer, headers: Record<string, string>): Promise<WebhookEvent>;
}
```

- `createIntent` recibe el monto en **centavos enteros**, la moneda,
  el id interno de la orden y un `sourceEventId` (UUIDv7 que manda el
  cliente para idempotencia). Devuelve un `externalIntentId` del
  proveedor y, según el proveedor, el payload para redirigir al
  checkout.
- `verifyWebhook` recibe el **cuerpo crudo** de la petición y los
  headers, verifica la firma y devuelve el evento normalizado: monto,
  estado (`SUCCEEDED` / otros) y el id externo para idempotencia.

Los errores están **clasificados**, como el adaptador fiscal
(ADR-0008):

- `PaymentRejectedError`: el proveedor rechazó el cobro. Terminal:
  no se reintenta.
- `PaymentUnavailableError`: red o 5xx. Transitorio.
- `WebhookSignatureError`: la firma no verifica. El endpoint de
  webhook responde 401 y **no procesa nada**: un webhook que no se
  puede autenticar no se procesa aunque su contenido parezca válido.

## Firma y verificación

Cada proveedor firma distinto, y **el secreto nunca viaja en la
petición ni en el payload**:

| Proveedor | Algoritmo | Header | Cómo se firma |
| - | - | - | - |
| mock | HMAC-SHA256 | `x-signature` | `hex(hmac(secreto, rawBody))` |
| Mercado Pago | HMAC-SHA256 | `x-signature` | `hmac(secreto, "id.<id>;request_id.<request_id>;ts.<ts>;" + rawBody)` |
| Stripe | HMAC-SHA256 | `stripe-signature` | cada `t=<ts>,v1=<hmac>` con `"t.<ts>.<rawBody>"` |

La comparación es **timing-safe** (`crypto.timingSafeEqual` sobre
hex decodificado, con longitud verificada antes). Stripe admite
rotación de secreto: si alguno de los pares `v1` verifica, el evento
es válido.

**El secreto del webhook del proveedor es distinto del secreto del
token QR** (`PAYMENT_WEBHOOK_SECRET` vs `QR_TOKEN_SECRET`): uno
autentica al proveedor hacia la API, el otro autentica al cliente
hacia la API.

## Idempotencia

Dos capas, ninguna confiada al proveedor:

1. **La creación del intent** es idempotente por `source_event_id`
   (tabla `payment_intents`): un cliente que reintenta no crea un
   segundo cobro.
2. **El webhook** es idempotente por `(provider, external_id)`
   (tabla `payment_webhook_events`, unicidad por función
   `SECURITY DEFINER`): un proveedor que reenvía el mismo evento —
   y lo hace, sobre todo Mercado Pago— no acredita dos veces.

## Por qué el fetch y el tiempo son inyectables

Igual que el `WsaaTransport` del adaptador fiscal: los tests
verifican el **protocolo** (qué se firma, qué se envía, cómo se
interpreta cada respuesta) con un transporte falso, sin un solo
paquete de red y sin credenciales reales. El proveedor real se
cablea con el `fetch` global.

## Mock determinístico

`MockPaymentProvider` deriva el id externo y el estado de un hash
del `sourceEventId`: el mismo input siempre da el mismo cobro, en
tests y en la demo del dueño. Acepta cobros y expone
`failNextPayment` para que los tests de integración ejerciten el
camino de rechazo.

En **desarrollo**, el webhook del mock se firma con
`PAYMENT_WEBHOOK_SECRET` (default
`dev-only-webhook-secret-cambiar-00`): para simular
el pago completo hay que firmar el webhook del mismo
modo que lo haría el proveedor. Por eso la UI del
storefront inicia el pago pero la confirmación final
—que en producción hace el checkout del proveedor—
queda en el E2E, que firma el webhook con el
secreto correcto.

## Uso en la API

El módulo `storefront` resuelve el provider por configuración del
local (`venues.settings.paymentProvider`, default `mock`) y lo
inyecta como puerto. El webhook (`POST /storefront/payments/webhooks/:provider`)
es **público y rate-limited**: no tiene sesión porque la llama el
proveedor, y por eso toda su seguridad está en la firma.
