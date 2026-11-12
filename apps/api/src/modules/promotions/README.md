# `promotions` · Promociones y happy hour

El CRUD de las reglas que evalúa `@comanda/pricing-engine`. La decisión
de fondo es que **el motor es uno solo**: el POS lo corre offline sobre
la réplica de `price_rules` en Dexie, el servidor lo corre sobre la base,
y este módulo es la única forma en que las reglas cambian.

## Las piezas

| Archivo | Qué es |
| - | - |
| `promotions.controller.ts` | CRUD: listar (con filtros), crear, actualizar, dar de baja. |
| `promotions.service.ts` | Validación de coherencia al editar y auditoría de alta/baja. |
| `promotions.types.ts` | Esquemas Zod de creación y actualización, con las dos refinaciones. |
| `rules.ts` | `loadActiveRules`: lo que llama `orders.service#addItem` antes de `priceLine`. |

## Reglas que no se rompen

**La coherencia se verifica dos veces.** Al crear y al actualizar:
`ORDER` no lleva `scopeId`; `PRODUCT`/`CATEGORY` lo exigen; y cada tipo
exige sus parámetros (`PERCENT` → `bps`, `FIXED` → `cents`, `PRICE_OVERRIDE`
→ `priceCents`, `NXM` → `n` y `m`). Una regla `PERCENT` sin `bps` no
erroriza al evaluarse: descuenta cero, en silencio. Esa es la razón del
doble chequeo, no la formalidad.

**Una promo no se crea para otro local.** El body puede llevar `venueId`,
pero si no es el local de la sesión es 409: el dueño de dos sucursales
puede crear una promo *global* (`venue_id` nula) o *de este local*, y
desde acá no se toca la otra sucursal.

**La baja es lógica.** `DELETE` pone `active = false`; la fila nunca se
borra. Las comandas pasadas guardan el snapshot en `applied_rules`, y
ese snapshot tiene que poder explicarse aunque la promo ya no exista.

**Actualizar no puede dejar una regla incoherente.** Cambiar solo `type`
sin cambiar `params` dejaría una `PERCENT` sin `bps`: el `UPDATE` valida
la fila *mergeada* (lo que hay en base + lo que llega) antes de escribir.

**El listado respeta el local.** `venue_id IS NULL OR venue_id = $1`: las
globales y las propias. Las de otro local no se filtran por confianza —el
motor las descartaría igual— sino para no gastar ciclos por línea.

## Permisos

- `promotion.read` (listar): lo tiene el mozo, porque el POS las
  hidrata al arrancar (`GET /promotions` es parte de la hidratación
  de la carta).
- `promotion.manage` (crear, editar, dar de baja): dueño.

## El otro lado

La evaluación no vive acá: `priceLine()` de `@comanda/pricing-engine`
(ver su README). Y en el POS, la hidratación de estas reglas a la réplica
local es `hydrateCatalog` (`apps/pos/src/data/catalog.ts`), que valida
cada regla con `promotionRuleSchema` —el esquema de lectura que el motor
exporta— antes de escribirla en Dexie.
