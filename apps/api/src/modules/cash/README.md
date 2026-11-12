# Módulo `cash`

Turnos, movimientos de efectivo y arqueo.

## El arqueo ciego es estructural

Es la decisión más importante del módulo y no es una condición en el código:
**el objeto que se devuelve al cajero no tiene las claves `expectedCashCents` ni
`diffCents`.** No están en `null` ni en `undefined`; no existen.

`toBlindShift()` construye el turno desde cero con un conjunto de campos acotado, y
todos los endpoints que responden al cajero pasan por ahí. `GET /:id/expected` y
`/:id/report` usan el objeto completo y exigen `cash.viewExpected`.

La razón de que sea estructural y no una condición: si el campo existiera con
`null`, el primer refactor que lo populara —del tipo "que el cajero vea la
diferencia"— se lo llevaría, y el arqueo ciego deja de serlo sin que nadie lo note.

Un cajero que ve el esperado declara lo que ve. Un cajero que no lo ve, cuenta.

## El signo lo decide el tipo

`IN` suma; `OUT` y `RETIRO` restan. Nunca se confía en el signo del payload.

Si el cliente mandara el signo, un retiro podría guardarse como ingreso y el arqueo
del turno quedaría desfasado **para siempre**: el error está escrito en la base y
nadie lo vuelve a mirar.

`cash_movements.amount_cents` se guarda siempre positivo; el signo se aplica al
calcular el total del turno.

## Un turno abierto por local

Índice único parcial `shifts_one_open_per_venue` sobre `status = 'OPEN'`. Dos cajas
abiertas a la vez no tienen sentido y duplicarían el arqueo.

Cuando el POS abre el turno offline y lo sube después, `resolveOpenShift` (en
`orders/order-state.ts`) evita el conflicto: si ya hay uno abierto, el evento
responde `DUPLICATE` con el id del existente.

## Motivo obligatorio

Todo movimiento de efectivo exige motivo, sin excepción. `audit_log` lo exige
también, pero validarlo en el dominio corta el error antes de escribir.

Un movimiento de efectivo sin motivo es indistinguible de uno hecho por el mismo
encargado, y esa indistinguibilidad es exactamente lo que hay que evitar.