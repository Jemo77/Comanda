# `tables`

Sectores y mesas: el plano del local y el mapa que ve el mozo.

Las decisiones que no se ven leyendo el codigo:

## Por que `OCUPADA` y `PIDIO_CUENTA` no se pueden poner a mano

`POST /tables/:id/status` acepta `LIBRE`, `RESERVADA` y `BLOQUEADA`, y rechaza los
otros dos con un 409 que dice que abrir la comanda. No es una limitacion de UI: es la
unica forma de que el estado de una mesa.signifique siempre lo mismo.

La ocupacion la deriva el sincronizador (`applyOrderOpened` / `freeTable` en
`sync.service.ts`) y solo puede existir junto a una comanda. Si un endpoint la
escribiera a mano, se romperian dos garantias de la base al mismo tiempo:

- **`orders_one_open_per_table`**: la mesa quedaria ocupada por una comanda que el
  servidor nunca vio abrir. La comanda real que se abra despues se iría sin mesa, y
  el local cobraria a dos personas sentadas en la misma.
- **`tables_occupied_consistent`**: exigiría inventar un `order_id` y un
  `occupied_since` que no corresponden a nada, o reventar la constraint.

En los dos casos el resultado es un salon con una mesa "ocupada" sin nadie a quien
cobrarle. Es el peor estado posible para un local, y el que mas cara sale.

El camino inverso tambien se cierra: una mesa ocupada o que pidio cuenta no cambia de
estado hasta que la comanda se cierra. Bloquear una mesa con comanda abierta dejaria
esa comanda sin poder cobrarse.

El enum del esquema sigue siendo el del dominio (los cinco estados): el recorte es
del servicio y responde 409 con que hacer, no un 422 de "valor invalido" que deja al
POS sin saber si reintenta.

## La constraint es de una sola direccion

`tables_occupied_consistent` dice "ocupada implica comanda y momento de ocupacion".
**No** dice "libre implica que no hay comanda colgando": Postgres acepta una mesa
`LIBRE` con `order_id` puesto, y el test lo comprueba.

Por eso `setStatus` limpia `order_id` y `occupied_since` siempre juntos, en el mismo
UPDATE que el estado. La app sostiene la otra mitad de la invariante, y ese
`UPDATE` de tres campos a la vez es deliberado: cambiar uno solo reintroduce el hueco.

`updateTable` tampoco toca ninguno de los tres: escribe solo lo que vino en el body,
porque escribir el estado leido seria una ocasion para pisar `OCUPADA` con el `LIBRE`
que el POS tiene cacheado.

## Por que el umbral de ocupacion vive en la app

El "aviso de mesa hace rato" (120 min por defecto, `DEFAULT_OCCUPANCY_ALERT_MINUTES`)
esta en el codigo y no en `tables` ni en `venues`.

- Es una politica **por local**, no un dato: un bar de copas no advierte a los 20
  minutos lo que un restaurante de familias avisa a la hora y media. Meterlo en la
  base obliga a una migracion cada vez que un cliente lo cambia.
- No se consulta: se compara en memoria al pintar. Guardar un numero que solo se lee
  desde el proceso es guardar ruido.
- El calculo (`computeOccupancy`) tiene que ser **identico** en el servidor y en la
  replica del POS, porque el mapa pinta el temporizador mientras esta offline. El POS
  no tiene, ni puede tener, acceso a una funcion de Postgres.

Los minutos se truncan, no se redondean: el temporizador tiene que decir "hace 119
min" mientras faltan segundos para la hora, porque un redondeo que salta a 120 un
minuto antes hace que la alerta vibre.

## Por que la lista trae el numero de comanda

`listTables` y `floorPlan` resuelven `orders.number_label` en el mismo SELECT. El mapa
pinta el temporizador y el numero de cada mesa ocupada; si el numero estuviera en otra
consulta, un salon con veinte mesas serian veinte requests extra por refresco.

## Por que el filtro por local esta en el `WHERE`

La RLS es por **organizacion**, no por local: sin `venue_id` en el `WHERE`, un
Encargado del local A leeria y moveria el salon del local B de la misma organizacion.
La RLS resuelve el aislamiento entre tenants; el `venue_id` resuelve el de locales, y
son cosas distintas.

La excepcion es `occupiedSince`, que solo se limita por organizacion: el id de la mesa
viene de un listado que ya vino acotado al local de la sesion, y para leer una fila el
filtro extra solo se equivoca.

## Que NO esta aca

- **Unir y separar mesas** ( Fase 3 del plan). El modelo de datos actual tiene la mesa
  como unidad: no hay grupo de mesas, asi que no hay endpoint que las agrupe.
- **Mover la mesa de sector**: el editor drag & drop mueve dentro del plano, y cambiar
  el sector de una mesa es una operacion de administracion distinta.
- **El historial de una mesa**: el `audit_log` ya tiene `table.updated` y
  `table.status_changed` con el estado anterior; no hay una tabla de review de mesa.

`bulkSaveLayout` no audita: arrastrar una mesa veinte pixeles no es un hecho de
negocio, y auditar cada gesto del editor llena el registro de cosas que nadie revisa.
Si alguna vez hace falta, el lugar es el guardado del plano completo, no cada
movimiento.
