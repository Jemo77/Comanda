# Drivers de impresión

Cada driver implementa la misma interfaz:

```ts
interface PrinterDriver {
  readonly name: string;
  write(bytes: Uint8Array): Promise<void>;
  close?(): Promise<void>;
}
```

## Por qué el contrato es `write(bytes)` y no `printTicket(ticket)`

El driver **no sabe qué es un ticket**. Recibe bytes ya armados.

Eso es lo que hace posibles tres cosas:

1. **El generador se prueba entero sin impresora.** Los tests de `ticket.test.ts`
   comparan bytes con `toEqual`. Si el driver recibiera un `KitchenTicket`, habría que
   probarlo con una impresora.
2. **Un error de la impresora no puede cambiar lo que el ticket dice.** El formateo
   está en un solo lugar, y ese lugar no depende del destino.
3. **Agregar un driver es agregar un archivo.** Bluetooth, PrintBridge, una cola en la
   nube: no se toca el generador. Es la regla 6 del plan (adaptadores para todo lo
   externo) aplicada a la impresión.

## Por qué `write` no tira

Una impresora sin papel, un cable desenchufado o un socket caído son el **estado normal**
de un local, no una excepción de programación.

Si `write` tirara, el error terminaba en una promesa flotante en el POS y el síntoma en
el mostrador es una pantalla en blanco. Peor: el ticket que se perdió es el del plato que
el cliente está esperando, y no hay forma de avisarle al mozo.

Lo que sí se hace: **loguear y avisar por `onError`**. El error no se tira, pero tampoco
se pierde. `write` resuelve siempre; que el papel haya salido o no, lo decide el
`onError`.

## Los tres

| Driver | Dónde corre | Cuándo |
| - | - | - |
| [`console-driver.ts`](./console-driver.ts) | Node y navegador | Desarrollo y tests. Es el destino por defecto. |
| [`tcp-driver.ts`](./tcp-driver.ts) | Node | Impresora de red. **El de producción.** |
| [`browser-usb-driver.ts`](./browser-usb-driver.ts) | Navegador | Impresora plugged al apparatus, sin servidor de impresión en medio. |

### Por qué TCP es el de producción

Una impresora térmica de 80 mm de barra o de cocina casi siempre está en la red local
con IP fija y habla **impresión cruda** en el puerto 9100: se abre un socket, se
escriben bytes, se cierra. Sin protocolo, sin handshake, sin acuse. Esa simplicidad es
la que lo hace predecible: si el paquete no salió, no salió.

El socket se abre y se cierra en **cada** `write`, aunque se podría mantener abierto.
Una impresora apagada deja un socket abierto colgado sin error visible (el `write`
"tiene éxito" porque el sistema operativo metió los bytes en su buffer) y el ticket se
pierde en silencio. Abriendo por escrito, el fallo aparece en el momento del envío.

### Por qué WebUSB necesita un gesto explícito

WebUSB no deja escribir en un dispositivo que no esté abierto, y abrirlo pide **permiso
al usuario**. `open()` es un método aparte de `write()` justamente por eso: si `write`
abriera el dispositivo solo, el navegador rechazaría la petición y el POS creería que
el papel salió.

Por la misma razón, `pickDevice()` reintenta con `getDevices()` antes de llamar a
`requestDevice()`: un permiso concedido se **recuerda** entre recargas de la página, y
un POS que abre el KDS treinta veces por hora no puede abrir treinta diálogos por hora.

### Por qué `node:net` se importa adentro del método

El POS importa este paquete entero para usar WebUSB. Un `import { createConnection }
from 'node:net'` en el tope de `tcp-driver.ts` hace fallar el bundle del navegador por
un driver que ahí no se usa. El import es dinámico y vive dentro de `write`.

## Agregar un driver

1. Implementá `PrinterDriver`.
2. **No tires en `write`.** Logueá y avisá por `onError`.
3. Si toca una API que no existe en el otro runtime (Bluetooth, `node:usb`), resolvela
   por `globalThis` o con import dinámico dentro del método. El paquete se importa
   desde Node **y** desde el navegador.
4. Inyectá lo que se pueda (el `connect` de `TcpDriver`, el `usb` de `BrowserUsbDriver`)
   para que el test no abra un puerto real ni pida permiso a un navegador.