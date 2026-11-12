# Módulo `orders`

Comandas: alta, ítems, notas, cierre, transferencia y unión.

## `order-state.ts` es lo importante de este módulo

Ahí viven las tres operaciones que el POS y el servidor comparten:

- `refreshOrderTotal`: recalcula el total desde los ítems con `orderTotals()` del
  dominio.
- `resolveOpenShift`: devuelve el turno abierto del local.
- `freeTable`: libera la mesa.

`sync.service.ts` (el camino offline) los usa igual que este módulo (el camino
online). Eso es deliberado: había dos políticas de total y de cierre, y divergían.
Con descuento o servicio, el número que veía el mozo y el que cobraba el sistema
eran distintos. Dos implementaciones del mismo cálculo siempre divergen; lo que no
divergen es las que comparten código.

Si agregás una regla de negocio que afecte al total o al cierre, va acá y no en un
servicio.

## El precio lo recalcula el servidor

`addItem` no tiene `unitPriceCents` en el contrato. El precio sale del catálogo,
pasa por `priceLine()` de `@comanda/pricing-engine` y se guarda como snapshot en
el ítem.

El POS igual calcula el precio localmente, para poder ser optimista y pintar el
total sin esperar la red. Lo que se guarda es el del servidor. Un `unitPriceCents`
en el body sería un hueco de manipulación de precio: el que lo manda decide cuánto
cobra.

## El precio de un producto no toca las comandas abiertas

Los ítems guardan `unitPriceCents` y `nameSnapshot` del momento en que se
agregaron. Cambiar el precio del catálogo o renombrar el producto no altera una
comanda que ya se abrió.

Esto parece una redundancia y es lo que permite que un ticket siga diciendo lo que
se pidió dentro de seis meses, con el producto ya renombrado o borrado.

## Anular exige motivo

No por cortesía: sin motivo no hay forma de responder cuánto se descontó por
anulaciones. `voidItem` audita con `order.item_voided` y el **importe con
modificadores incluidos**, que es el que dejó de cobrarse.

El importe es `unitPriceCents + deltas de modificadores`, no solo el precio de
lista: auditar el precio de lista descuadra el arqueo, porque el hueco real es el
importe con el que estaba en la pantalla.