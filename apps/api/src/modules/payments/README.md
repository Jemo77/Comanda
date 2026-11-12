# Módulo `payments`

Cobro mixto, división de cuenta y propinas.

## Idempotencia obligatoria

`Idempotency-Key` es obligatorio en `pay`. El `payments.source_event_id` tiene un
índice único parcial, así que un reenvío con la misma clave devuelve el cobro
original en vez de cobrar dos veces.

No es una optimización: el POS manda por red y un timeout no distingue "no llegó"
de "llegó y se perdió la respuesta". Sin idempotencia, un reintento del cliente
cobra dos veces y hay que devolver plata con un arqueo que ya cerró.

### El replay se resuelve antes de mirar el estado

El orden importa y no es intuitivo. Si el request reintentado primero mirara si la
comanda ya está cerrada, recibiría un 409 — porque el **primer** request ya la
cerró — y el cliente que reintenta por timeout se queda sin cobrar.

Primero se busca el pago por `source_event_id`. Si está, se devuelve el resultado
original. Solo si no existe se procesa.

### Los totales se leen antes de insertar el pago

Por la misma razón, en sentido inverso: si el total se leyera después de insertar
el pago, el cobro recién insertado contaría como pagado y el sistema creería que la
mesa está al día.

## Nunca vemos el número de tarjeta

`CARD`, `QR` y `TRANSFER` son **pago externo**: el POS manda el comprobante del
terminal (`providerRef`) y nada más. `provider_ref` es la referencia del proveedor,
nunca el PAN. La API no tiene ningún campo donde un número de tarjeta pueda caer
(PCI-DSS, PLAN §6).

## El reparto lo calcula el dominio

`splitEqual`, `splitByItem` y `splitByAmount` viven en `@comanda/domain` y se
importan, no se reimplementan. La regla que sostienen: la suma de las partes es
exactamente el total, por aritmética entera y nunca con `toFixed`.

Un reparto escrito a mano tiene que pasar `balanced`. Si no, no se cobra: es mejor
un rechazo que dar por pagada una mesa a la que le faltaba un peso.

## Tolerancia de sobrepago: cero

Sobrepagar sin motivo se rechaza. Con motivo (un redondeo, unPropina cargada aparte)
se acepta y queda auditado, porque el sobrepago es el mecanismo por el que un local
pierde plata sin darse cuenta.