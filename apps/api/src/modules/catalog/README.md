# Módulo `catalog`

Estaciones, categorías, productos, grupos de modificadores y modificadores.

## El precio de un producto no toca las comandas abiertas

Los ítems guardan `unit_price_cents` y `name_snapshot` del momento en que se
agregaron. Renombrar un producto o cambiarle el precio no altera una comanda que ya
se abrió.

Parece una redundancia y es lo que permite que un ticket siga diciendo lo que se
pidió dentro de seis meses, con el producto ya renombrado o borrado. Si alguna vez
se "optimiza" con un JOIN al catálogo para mostrar el nombre actual, se pierde eso
y no hay test que lo note.

## El precio es un entero de centavos

`price_cents` y `price_delta_cents` son enteros, siempre. Un float acá se acumula
en el arqueo de caja: el error de redondeo de 0.1 + 0.2 es invisible por pedido y
visible en la conciliación del turno.

## `product.priceChange` se verifica aparte de `product.manage`

`product.priceChange` es más fino que `product.manage`: el Cajero lo tiene, el Mozo
no. Ponerlo en el decorador junto con `manage` le negaría al Cajero el permiso de
**renombrar** un producto, que no es lo que queremos.

Por eso la comprobación del precio ocurre en el handler, y solo cuando el body
trae `priceCents`. Es el único endpoint que no se resuelve solo con el decorador, y
está comentado para que el próximo no lo "simplifique".

## Cambiar precio o disponibilidad se audita

Con el valor anterior. `product.price_changed` y `product.availability_changed`
quedan en `audit_log` con actor, dispositivo y el antes.

Desactivar un producto es la forma más común de que un producto "desaparezca" de la
carta sin que nadie lo note, y sin registro no hay forma de volver atrás.

## Los filtros booleanos llegan como texto

`available` e `includeUnavailable` se parsean con `z.coerce.boolean()`, que convierte
**cualquier** string no vacío en `true`. `available=false` se volvería `true` y la
respuesta ocultaría exactamente los productos que se pedían.

Por eso se comparan contra `"true"` explícitamente en vez de usar `z.coerce.boolean()`:
el resultado sería un 200 con la lista al revés, que es el peor modo de falla para
quien lo consume.