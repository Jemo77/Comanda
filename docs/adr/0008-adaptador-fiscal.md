# ADR-0008 · Adaptador fiscal: WSFE con transporte y CMS inyectables

- **Estado:** aceptada
- **Fecha:** 2026-10-02

## Contexto

Fase 2 necesita emitir comprobantes en Argentina (AFIP/ARCA
WSFE). El adaptador fiscal tiene que ser testeable sin la red
del fisco, sobrevivible a una caída del WSFE, y no puede
esconder el material criptográfico en el código.

Tres decisiones de diseño, agrupadas porque se sostienen
entre sí:

1. **cómo** se prueba el WSFE sin homologación real,
2. **qué** pasa cuando el fisco está caído,
3. **dónde** vive el QR del comprobante.

## Opciones

### 1. Un `AfipFiscalProvider` con HTTP y cripto adentro

Lo más directo: `fetch` al WSAA/WSFE y el CMS firmado con
`node:crypto`.

El problema es que el **ticket de acceso** (WSAA) y la
**firma CMS** son justamente lo que no se puede ejercitar en
un test: el primero es un login SOAP con certificado, y el
segundo necesita el .p12 del contribuyente. Un provider con
eso adentro solo es testeable contra el ambiente de
homologación, con certificados de prueba que caducan y un
servicio que no está garantizado en el pipeline.

### 2. Transporte y CMS como puertos — **elegida**

`AfipFiscalProvider` recibe:

- un `WsaaTransport` (interfaz: `authenticate(cuit, certRef,
  environment)` → ticket de acceso), con la implementación
  real `HttpWsaaTransport` (SOAP sobre HTTPS);
- un `CmsSigner` (interfaz: `sign(xml, certRef)` → CMS
  base64), que en producción firma con el material del vault.

Los tests inyectan un transporte falso y un firmador falso:
se verifica el **protocolo** (qué XML se pide, cómo se
arma el FECAESolicitar, qué pasa con cada respuesta) sin
un solo paquete de red.

## Decisión

**Interfaz `FiscalProvider`** (`packages/fiscal-adapters`):
`issueInvoice` y `creditNote`, con errores clasificados:

- `FiscalRejectionError`: el fisco **rechazó** el comprobante.
  Terminal: no se reintenta, se muestra al operador con las
  observaciones.
- `FiscalUnavailableError`: red, 5xx, WSFE intermitente.
  Transitorio: la cola reintenta con backoff (ADR-0007).

**Contingencia con CAEA.** Si el WSFE está caído y hay un
CAEA vigente en `fiscal_settings`, el provider emite con el
CAEA y marca el resultado `contingency: true`: el comprobante
es válido (el CAEA es la autorización de contingencia que la
normativa prevé), y la auditoría lo distingue
(`invoice.contingency_issued`). Si no hay CAEA, es un
`FiscalUnavailableError` y la cola reintenta.

**QR persistido.** El proveedor devuelve `qrPayload` (la URL
del QR de verificación, construida por `qr.ts` con la
constante de AFIP y el CAE) y el servicio lo guarda en
`invoices.qr_payload`. El QR **no se recalcula al imprimir**:
el comprobante de hace tres meses tiene que mostrar el mismo
QR que mostraba el día que se emitió, y recalcularlo exige
el CAE, el punto de venta y la fecha exacta —todo lo que ya
está congelado en la fila.

**Mock determinístico.** `MockFiscalProvider` devuelve CAE y
número derivados del `internalId` (hash estable), para que
los tests de integración y la demo del dueño vean resultados
reproducibles, no aleatorios.

**El POS calcula precios offline con el motor compartido.**
Las promociones se evalúan en el POS con
`@comanda/pricing-engine` (el mismo paquete que corre el
servidor), sobre reglas hidratadas de `/promotions` en la
réplica local (Dexie, `priceRules`). No hay segunda
implementación del Happy Hour: la línea congela
`unitPriceCents` + `appliedRules` en el momento de agregar,
igual que en el servidor, y el evento de sync las sube.

## Consecuencias

- El **material fiscal** (certificado, clave) nunca viaja ni
  se guarda en el código: `certRef` es una referencia al
  vault. El `CmsSigner` de producción —que lee el .p12 del
  secret manager— llega con el vault (PLAN §14); hoy el
  wiring de AFIP levanta `FiscalUnavailableError` si no hay
  material, que es la falla correcta: facturar con un
  certificado de mentira es peor que no facturar.
- La **emisión es síncrona en la API** (`POST
  /fiscal/orders/:id/invoices` procesa la fila y devuelve el
  comprobante). Para el mostrador es lo correcto: el mozo
  tiene que ver el CAE antes de entregar el producto. La
  cola existe para los reintentos cuando el fisco está caído,
  no para asincronizar el caso feliz.
- **El estado terminal es `RECHAZADA`.** Una observación del
  fisco (CUIT inexistente, alícuota inválida) no se va a
  arreglar reintentando: reintentar sería multiplicar
  rechazos. `POST /fiscal/invoices/:id/retry` existe para
  `ERROR` y para reintentar un `RECHAZADA` después de que el
  operador corrigió la configuración.
- La NC se emite **sobre la factura original** (con sus
  totales y receptor), no sobre la comanda: la única
  pregunta que importa ("¿qué se acreditó?") se responde
  mirando la FACT, y la constraint parcial (`credit_note_for`
  con `status <> 'ERROR'`) impide la doble acreditación.
- El POS **no llama** a `POST /orders/:id/items`: siempre
  encola eventos. Por eso el precio con promos se calcula en
  el POS: si no, las promos nunca aplicarían a las ventas de
  mostrador (el servidor solo vería el total ya calculado).
  El motor es puro, así que evaluarlo en el navegador y en
  Node da el mismo precio para la misma entrada.
