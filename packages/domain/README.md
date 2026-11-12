# @comanda/domain

Contratos compartidos entre la API y los clientes: dinero, identificadores,
permisos, roles, tenancy, auditoria y formato de errores.

Este paquete es **isomorfico**: se importa igual en Node (API, workers) y en el
navegador (POS, admin). Por eso no depende de `lib.dom` ni de `@types/node`, y
por eso el motor de promociones futuro podra correr en ambos lados sin forks.

## Por que dinero en enteros

`0.1 + 0.2 !== 0.3` en IEEE-754. En un local que procesa 50 pedidos por minuto,
ese error se acumula en el arqueo de caja y en la factura fiscal. Todo importe
es `{ cents: number, currency: string }` con `cents` entero. El unico lugar donde
se redondea es explicito y auditable (`applyBasisPoints`, `allocate`,
`roundFromSubunits`, `fromMajorUnits`).

Reglas que el paquete impone:

- no se suman importes de monedas distintas (lanza `MoneyError`);
- `allocate` reparte sin perder ni inventar centavos (metodo del resto mayor);
- `discountClamped` nunca devuelve un importe negativo;
- el redondeo es half-up hacia el valor absoluto, igual que las Bolsas.

## Identificadores

UUIDv7 (`uuidv7`), no UUIDv4. La outbox offline genera ids en el cliente y el
servidor los ordena por tiempo de recepcion: con v7 el orden del indice coincide
con el orden temporal y el rango "cambios desde X" es un range scan.

El generador tiene estado monotono propio (`createUuidV7Generator`) y, si se
agotan los 4096 ids de un milisegundo, toma prestado un milisegundo en lugar de
fallar: un pico de trafico no puede dejar al POS sin poder crear ids.

## Permisos y roles

La unidad de autorizacion es la **clave de permiso** (`order.item.void`), nunca el
nombre del rol. Los guards del backend verifican claves; la UI solo las refleja.
Los roles por defecto (`mozo`, `cajero`, `encargado`, `dueno`) derivan de la
matriz del PLAN §6 y son editables por cada local.

El limite de descuento del Cajero no es un permiso sino una constraint numerica
(`RoleConstraints.discountMaxBps`), porque "puede aplicar descuentos" no es
binario.

## Errores

`problemDetails()` construye respuestas RFC 7807 con un `code` estable. El POS
necesita distinguir "no tenes permiso" de "el servidor se cayo" para decidir si
reintenta, si pide PIN de supervisor o si muestra un error de red.

## Tests

```bash
pnpm test              # 82 tests
pnpm test:coverage     # umbral 80% (real: 98%)
```