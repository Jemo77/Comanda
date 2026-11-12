# `reports` · Reportes básicos de ventas

Ventas por día, producto y categoría. Es el primer corte de
lo que el PLAN pone en BI (Fase 5): CMV, ingeniería de menú y
heatmaps no existen todavía, y no se anticipan acá.

## La pieza

`GET /reports/sales?from=…&to=…&groupBy=day|product|category`
(permiso `report.read`), con Zod en el query. Devuelve totales
del rango más el desglose pedido, **todo en centavos enteros**.

## Reglas que no se rompen

**Solo ventas reales.** Se suma sobre comandas `CLOSED` con el
rango aplicado sobre `closed_at`: la venta ocurrió cuando se
cerró, no cuando se abrió la mesa ni cuando se cobró parcial.
Una comanda abierta ayer y cerrada hoy es venta de hoy.

**El item es la unidad de medida.** El importe por línea es
`(unit_price_cents + delta de modificadores) * quantity`, con
el delta en un `LATERAL` para no inflar el `SUM` por la
multiplicidad del join. Los items anulados (`VOIDED`) no suman,
y el motivo de la anulación ya vive en la auditoría, que es
donde se mide "cuánto se descontó por anulaciones".

**Promociones incluidas, sin doble contar.** El precio unitario
congelado ya tiene la promo aplicada (el snapshot de
`applied_rules` explica cuál): el reporte suma lo que se cobró,
y el descuento se deduce de la comparación contra el precio de
lista, no de una columna aparte.

**El promedio sale del total, no de las filas.**
`averageTicketCents = total / cantidad de comandas`. Calcularlo
promediando los promedios por día daría otro número cuando los
días tienen distinta cantidad de tickets.

**Top 50 por producto.** El desglose por producto es el único
con límite: una carta de cientos de ítems no necesita más de 50
filas para decidir qué empujar, y el resto queda en `category`.
