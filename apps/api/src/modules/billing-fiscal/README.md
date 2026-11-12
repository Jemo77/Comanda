# `billing-fiscal` · Facturación electrónica

Emisión de comprobantes (facturas y notas de crédito), la cola
de comprobantes pendientes y la configuración fiscal del local.
El adaptador contra el fisco vive aparte, en
`@comanda/fiscal-adapters`: este módulo es el caso de uso, no
el protocolo.

## Las piezas

| Archivo | Qué es |
| - | - |
| `fiscal.controller.ts` | Configuración, emisión, listado, reintento. |
| `fiscal.service.ts` | La cola: crea la fila, procesa, clasifica el resultado. |
| `fiscal.module.ts` | Módulo + `FiscalWorker`, el barrido periódico de pendientes. |
| `fiscal.math.ts` | Desglose de IVA: puro, sin I/O, testeable sin base. |

## La cola es la tabla

No hay BullMQ ni Redis: **la fila de `invoices` es la cola**
(`PENDING` + `next_attempt_at` + `attempts`), y el claim
atómico es `platform_claim_pending_fiscal_invoices` (función
`SECURITY DEFINER`, ver migración `0011`). La razón completa
está en el [ADR-0007](../../../../docs/adr/0007-cola-fiscal-en-la-base.md).

El `FiscalWorker` barrida cada `FISCAL_WORKER_INTERVAL_MS`
(30 s por defecto; **`0` lo apaga**, que es lo que hacen los
tests de integración para que el orden de los reintentos sea
determinista: llaman `processDueInvoices` a mano).

`POST /fiscal/invoices/orders/:orderId` crea la fila y la
procesa **en el mismo request**: el mozo tiene que ver el CAE
antes de entregar el producto. La cola es la red de seguridad
para cuando el fisco está caído, no para asincronizar el caso
feliz.

## Máquina de estados

```
PENDING ──▶ EMITIDA    (CAE, número, QR persistidos)
   │           │
   │           └─ contingencia: CAEA vigente, marca `contingency`
   ├─▶ RECHAZADA  (terminal: decisión del fisco, no se reintenta)
   └─▶ ERROR      (cola agotada: attempts >= max_attempts)
```

- **Rechazo ≠ error.** `FiscalRejectionError` del proveedor es
  terminal: una observación del fisco (CUIT inexistente, alícuota
  inválida) no se arregla reintentando. `ERROR` es agotamiento
  de reintentos transitorios. `POST /fiscal/invoices/:id/retry`
  vuelve a poner en `PENDING` ambos, con auditoría.
- **Backoff exponencial en SQL**: 1 min, 2 min, 4 min… tope 2 h,
  calculado al escribir `next_attempt_at`.
- **Cada resultado se audita**: `invoice.issued`,
  `invoice.contingency_issued`, `invoice.rejected`,
  `invoice.retry_scheduled`, `invoice.failed`.

## La nota de crédito

Se emite **sobre la FACT original** (`creditNoteFor`), con sus
mismos totales y receptor, y el tipo se deriva
(`FACT_B` → `NC_B`). No se duplica: una FACT admite a lo sumo
una NC vigente (constraint parcial sobre `credit_note_for` con
`status <> 'ERROR'`, así una NC en `ERROR` sí puede reintentarse).

## La matemática del IVA

Los precios de catálogo son **IVA-inclusive** (el mostrador
cobra lo que se ve), así que la factura desglosa:
`neto = round(bruto / (1 + alicuota))` **por grupo de alícuota**,
y `iva = bruto - neto`. Sumar por grupo con esa regla preserva
el total al centavo; redondear antes de agrupar pierde centavos
en cartas con varias alícuotas. Los modificadores heredan la
alicuota del producto.

## Permisos

- `invoice.issue` (emitir, reintentar): cajero para arriba.
- `invoice.read` (ver la cola y el libro): cajero para arriba.
- `fiscal.manage` (configuración: proveedor, ambiente, CAEA):
  dueño. La configuración no la toca quien solo factura.

## Proveedores

`provider: 'afip'` construye `AfipFiscalProvider` con
`HttpWsaaTransport` (WSAA + WSFE reales) y un `CmsSigner` que
hoy **levanta `FiscalUnavailableError`**: firmar el XML exige
el .p12 del contribuyente, que vive en el vault (PLAN §14).
`provider: 'mock'` usa `MockFiscalProvider`, determinístico
(CAE y número derivados del `internalId`), que es el modo
homologación local y la demo del dueño.

En ambos casos el tercer parámetro del constructor de
`FiscalService` (`providerFactory`) permite inyectar un proveedor
de mentira en tests: se prueban los rechazos y las caídas del
fisco sin una red de por medio.
