/**
 * Aritmetica del arrastre, separada de la pantalla.
 *
 * Vive en su archivo y se importa desde `FloorPlan` para que se pueda probar sin
 * DOM. La razon no es el tamaño: es que el error mas caro de un editor de planos
 * es el que mueve la mesa **un centimetro** de donde deberia. Se ve en el plano
 * como desorden, y no hay forma de debugearlo desde el mostrador.
 */

/**
 * Ajusta un valor al multiplo de grilla mas cercano.
 *
 * Se usa `Math.round` y no truncar: truncar deja todo corrido hacia el mismo lado
 * y dos mesas que se sueltan a la misma altura quedan en filas distintas.
 *
 * El `+ 0` del final no es cosmetico. `Math.round(-0.5)` devuelve `-0`, y `-0` no
 * es `0` para `Object.is`: una asercion `expect(x).toBe(0)` falla, el `JSON.stringify`
 * lo manda como `0`, y el `===` lo da por igual. Ese desajuste hace que un test
 * falle por un motivo que no existe, y aprender a "arreglarlo" con `Math.abs`
 * esconde el problema real.
 */
export function snapToGrid(value: number, grid: number): number {
  if (grid <= 0) return value + 0;
  // El `+ 0` tambien normaliza `-0` a `0` en JavaScript.
  return Math.round(value / grid) * grid + 0;
}

/**
 * Acota `value` al intervalo `[min, max]`.
 *
 * Si `max` es menor que `min` —un lienzo mas chico que la mesa—, devuelve `min`.
 * Devolver `max` pondria la mesa en coordenadas negativas, que es peor que
 * superponerla con el borde: una mesa invisible no se nota, una mesa en `-20`
 * desaparece del mapa.
 */
export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Posicion final de una mesa despues de arrastrarla.
 *
 * El clamp descuenta el tamano de la mesa del limite del lienzo. Limitar solo la
 * posicion (`x <= maxX`) deja la mitad de la mesa fuera del borde, y el mozo no
 * la ve en el mapa de mesas aunque el editor la muestre entera.
 */
export function moveTo(params: {
  x: number;
  y: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
  grid: number;
  boundsW: number;
  boundsH: number;
}): { x: number; y: number } {
  const snappedX = snapToGrid(params.dx, params.grid);
  const snappedY = snapToGrid(params.dy, params.grid);

  return {
    x: clamp(params.x + snappedX, 0, params.boundsW - params.w),
    y: clamp(params.y + snappedY, 0, params.boundsH - params.h),
  };
}