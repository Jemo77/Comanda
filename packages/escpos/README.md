# `@comanda/escpos`

Genera tickets ESC/POS y los escribe en una impresora. Isomorfico: el POS lo corre en
el navegador (WebUSB) y la API en Node (TCP).

## Por que un paquete y no un archivo del POS

Tres razones, todas del mismo tipo:

1. **La API tambien imprime.** El comprobante de la caja se reimprime desde el
   servidor cuando el POS esta caido, y esa reimpresion no puede depender de una tablet
   que esta sin bateria.
2. **El POS lo corre en dos runtimes.** La barra imprime por USB desde el navegador y
   la caja por TCP desde Node. La logica del ticket es la misma y no puede estar
   duplicada en dos paquetes.
3. **Los bytes exactos hay que probarlos.** Un test que compara `toEqual` sobre un
   fixture de bytes corre en milisegundos y sin impresora. Probarlo en el POS exige
   un navegador y una impresora por cada caso.

## Estructura

```
src/
  commands.ts              Los bytes del protocolo. Sin contexto de negocio.
  text.ts                  Texto a bytes en la pagina de codigos de la impresora.
  ticket.ts                El ticket de cocina y el comprobante.
  drivers/
    printer-driver.ts      La interfaz. Todos los drivers la implementan.
    console-driver.ts      A stdout. Desarrollo y tests.
    tcp-driver.ts          Socket crudo a `printer_target`. El de produccion.
    browser-usb-driver.ts  WebUSB, desde el navegador.
    README.md              Por que hay tres y como se agrega uno.
```

## Lo que decide este paquete

**La página de códigos: CP850** (ver `text.ts`). No CP437, porque los tickets llevan
`€` y `º`, y CP437 no los tiene. CP858 está disponible y es la que hay que elegir si
el local factura en euros.

**El corte: `GS V 66`** (corte parcial, avanzando el papel). El 65 corta sin avanzar y
deja el último renglón adentro del rollo.

**El cortador se arma antes de cortar** (`ESC p 1 19 fa`). Sin eso, el corte funciona
una vez y el ticket siguiente se imprime entero adentro del rollo.

**Sin importes en el papel de cocina.** El que lo mira no lo cobra, y un total
escrito a mano es un total que se puede equivocar. El total va en el comprobante.

**Los totales del comprobante salen de `orderTotals()`** del dominio. No se recalculan
aca: es la misma función pura que corre el POS sobre su réplica, y reimplementar la
aritmética es exactamente el modo de falla de "me cobraron 120 y el ticket dice 118".

## Cómo se usa

```ts
import { buildKitchenTicket, toUint8Array } from '@comanda/escpos';
import { TcpDriver, parseTcpTarget } from '@comanda/escpos/drivers';

const bytes = buildKitchenTicket(ticket, venue.name, { codepage: 'CP850' });
const driver = new TcpDriver({ target: station.printerTarget ?? 'tcp://127.0.0.1:9100' });
await driver.write(toUint8Array(bytes));
```

En el navegador, `BrowserUsbDriver` en lugar de `TcpDriver`, y `await driver.open()`
desde un gesto del usuario.

## Por qué `write` no tira

Una impresora sin papel, un cable desenchufado o un socket caído son el estado normal de
un local. Si `write` tirara, el error terminaría en una promesa flotante y el síntoma en
el mostrador sería una pantalla en blanco. Perder el aviso, no: `onError` lo recibe.

## Pruebas

Los bytes se comparan con `toEqual` sobre fixtures escritos a mano, **no** con
snapshots. Un snapshot se regenera con `--update` sin que nadie lo lea, y un byte de
corte cambiado es el fallo más caro del sistema de impresión: nadie lo detecta hasta
que el papel se acumula en el rollo.

Sin umbral de cobertura a propósito: si los bytes están verificados con `toEqual`, el
porcentaje de cobertura no dice nada que los tests no digan ya.