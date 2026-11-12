# @comanda/fiscal-adapters

Adaptadores fiscales de Argentina (AFIP/ARCA WSFE). El contrato
es `FiscalProvider`: recibe un comprobante con totales **ya
calculados** (neto + IVA por alícuota, en centavos enteros) y
devuelve el comprobante autorizado, o un error **clasificado**.

La API (`apps/api/src/modules/billing-fiscal`) es quien arma el
pedido desde la comanda y quien persiste el resultado; este
paquete no sabe de Nest ni de base.

## Las piezas

| Archivo | Qué es |
| - | - |
| `types.ts` | El contrato: request/resultado, `FiscalProvider`, los dos errores. |
| `afip.ts` | WSAA + WSFE, con transporte HTTP y firma CMS inyectables. |
| `qr.ts` | URL del QR fiscal (constante de AFIP + datos del comprobante). |
| `mock.ts` | Proveedor de demo/homologación, determinístico. |

## Los dos errores, y por qué son dos

- **`FiscalRejectionError`**: el fisco rechazó el comprobante
  (observaciones incluidas). **Terminal**: no se reintenta, se
  muestra al operador. Reintentar un rechazo es multiplicar
  rechazos.
- **`FiscalUnavailableError`**: red caída, 5xx, WSFE intermitente.
  **Transitorio**: la cola reintenta con backoff.

La distinción no es cosmética: es la que decide si `invoices`
pasa a `RECHAZADA` (el operador tiene que actuar) o queda en
`PENDING` (el sistema se recupera solo).

## Todo lo no determinista es inyectable

`AfipFiscalProvider(credentials, transport, cmsProvider)`:

- `transport`: la transacción SOAP. Producción usa
  `HttpWsaaTransport`; los tests un doble que devuelve XML de
  ejemplo. Un test que pega de verdad al homologador es un test
  que falla los viernes.
- `cmsProvider`: firma del TRA de WSAA con el certificado del
  local. En producción se resuelve con el material del vault;
  hoy levanta `FiscalUnavailableError` (facturar con un
  certificado de mentira es peor que no facturar).

El provider **no cachea el token** de WSAA: cada emisión lo
resuelve fresco. Un token al disco puede expirar y, peor,
escribirse con permisos de más.

## Contingencia con CAEA

Si el WSFE está caído y hay un CAEA vigente en las credenciales,
el provider emite con el CAEA y devuelve `contingency: true`:
el comprobante es válido (la normativa lo prevé), y la
auditoría lo distingue. Sin CAEA, es un
`FiscalUnavailableError` y la cola reintenta.

## El QR

`buildFiscalQrUrl` arma la URL de verificación con la constante
de AFIP, el CAE, el CUIT emisor, el punto de venta, el tipo y
el número de comprobante y la fecha. **Se persiste en
`invoices.qr_payload` en el momento de la emisión** y no se
recalcula al imprimir: un comprobante de hace tres meses tiene
que mostrar el mismo QR que mostró el día que se emitió.

## El mock

`MockFiscalProvider` devuelve CAE y número derivados del
`internalId` (hash estable), no aleatorios: la misma comanda
emitida dos veces en la demo da el mismo comprobante, y los
tests de integración pueden asertar valores exactos.

## Tests

```bash
pnpm test          # 13 tests: QR, mock, AFIP con transporte falso, CAEA
```
