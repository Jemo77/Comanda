# @comanda/pricing-engine

Motor de promociones y happy hour. **Puro e isomorfico**: sin `Date.now()`, sin
I/O, sin aleatoriedad no inyectable. El POS lo evalua offline y el servidor con
exactamente el mismo codigo, que es la unica forma de que el precio de una linea
sea el mismo antes y despues de sincronizar.

## Determinismo

El tiempo entra como parametro (`PricingContext.now`). El mismo input produce el
same output hoy y dentro de un ano: eso es lo que hace testeable el happy hour y
reproducible una factura vieja.

## Reglas

Tipos: `PERCENT` (bps), `FIXED` (centavos), `BOGO`, `NXM`, `PRICE_OVERRIDE`.
Ambito: `PRODUCT`, `CATEGORY`, `ORDER`.

Orden de aplicacion, que es la parte que hay que acertar:

1. Se descartan las reglas inactivas.
2. Se ordenan por `priority` descendente.
3. Cada descuento se calcula sobre el precio **ya modificado** por las anteriores.
   Encadenar dos de 50% da 75% off, no 100%.
4. Una regla `stackable: false` corta la cadena para las demas no apilables.
5. El total de la linea se redondea **una sola vez**, al final.

## Horarios y zonas

Los horarios se evalúan en hora **local del local**, no en UTC: un happy hour de
18 a 20 tiene que seguir siendo de 18 a 20 cuando cambia el horario de verano.
La conversion usa `Intl.DateTimeFormat` con la zona IANA, no offsets fijos.

Una ventana puede cruzar la medianoche (`22:00` a `02:00`). En ese caso la
comprobacion se parte: `[from, 24:00)` pertenece a hoy y `[00:00, to)` a ayer.
Sin esa separacion, un "viernes de 22 a 02" quedaria vigente todo el sabado a la
noche, que es cuando el local ya esta cerrado.

`PricingContext.clockSkewMs` absorbe el desfase de reloj de los dispositivos: sin
el, el mismo happy hour seria distinto en cada tablet.

## Esquema de lectura (`schema.ts`)

`promotionRuleSchema` es el contrato de lo que baja de
`GET /promotions`. Lo usan los clientes (el POS, al hidratar
la réplica local) para no escribir una regla que no sabrían
evaluar —y como el mismo paquete la evalúa, la forma que
valida es la forma que corre. Rellena los opcionales con
`default` y rechaza la incoherencia `scope`/`scopeId`, que es
un error de escritura, no una regla rara.

## Estado

Motor completo desde Fase 2: evalúa en el servidor
(`orders.service#addItem`) y en el POS offline (réplica de
`price_rules` en Dexie, ver `apps/pos/src/data/catalog.ts`).
La UI de reglas es el módulo `promotions` de la API y la
sección Promociones del backoffice.

## Tests

```bash
pnpm test          # 47 tests (38 del motor, 4 de propiedades, 5 del esquema)
pnpm test:coverage # umbral 80% (real: 96%)
```