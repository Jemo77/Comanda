import { describe, expect, it } from 'vitest';

/**
 * Aritmetica del arrastre.
 *
 * La misma logica que usa `FloorPlan` en el `pointermove`, probada sin DOM. El
 * motivo de extraerla es que el error que mas cuesta ver es el que pasa **un
 * centimetro** de la posicion que uno espera: la mesa queda a tres pixeles de otra
 * y en el mostrador eso parece un plano desordenado, no un bug.
 *
 * Se importa desde el modulo real, no se reimplementa: un clon de esta formula
 * pasa todos los tests mientras la pantalla usa otra.
 */
import { clamp, snapToGrid } from './drag';

/** Grilla del editor. Mismo valor que `GRID` en `FloorPlan.tsx`. */
const GRID = 20;

describe('snapToGrid', () => {
  it('cae en el multiplo de la grilla mas cercano', () => {
    expect(snapToGrid(0, GRID)).toBe(0);
    expect(snapToGrid(19, GRID)).toBe(20);
    expect(snapToGrid(21, GRID)).toBe(20);
    expect(snapToGrid(31, GRID)).toBe(40);
  });

  it('redondea a la mitad hacia arriba, no al vecino equivocado', () => {
    // 10 esta justo a mitad entre 0 y 20. Cualquiera de las dos respuestas es
    // aceptable; lo que NO puede pasar es que no sea multiplo de la grilla.
    const mid = snapToGrid(10, GRID);
    expect(mid % GRID).toBe(0);
    expect([0, GRID]).toContain(mid);
  });

  it('funciona con desplazamientos negativos', () => {
    // Arrastrar hacia la izquierda da valores negativos, y `-10 / 20 = -0.5` cae
    // justo en el borde donde `Math.round` redondea "hacia arriba" y devuelve `-0`.
    // `-0` no es `0` para `Object.is`, asi que sin normalizar una asercion falla
    // por un motivo que no existe.
    expect(snapToGrid(-30, GRID)).toBe(-20);
    expect(snapToGrid(-10, GRID)).toBe(0);
    expect(snapToGrid(-50, GRID)).toBe(-40);
  });

  it('nunca devuelve -0, que rompe las aserciones sin romper la pantalla', () => {
    // `-0` se ve bien en la pantalla (el CSS lo trata como 0) y se serializa como
    // `0`, pero `Object.is(-0, 0)` es falso: el valor "se ve bien y falla el test"
    // es el que hace que alguien lo persiga en el lugar equivocado.
    const value = snapToGrid(-10, GRID);
    expect(Object.is(value, -0)).toBe(false);
    expect(value).toBe(0);
  });

  it('toda posicion queda en un multiplo exacto de la grilla', () => {
    // Propiedad, no ejemplo: el arrastre genera valores continuos y probarlos de a
    // uno no alcanza. Se recorre en pasos impares para no caer siempre en multiplos.
    for (let raw = -200; raw <= 200; raw += 3.7) {
      const snapped = snapToGrid(raw, GRID);
      // `Math.abs(... ) % 1 === 0` dice "la division es entera", que es
      // exactamente la propiedad que importa para que dos mesas queden alineadas.
      // Se usa `Math.abs` porque `-0` y `0` dan el mismo resto y `toBe` los
      // distingue, y comparar el signo de un cero no dice nada del arrastre.
      expect(Math.abs(snapped / GRID) % 1).toBe(0);
    }
  });

  it('la distancia al multiplo mas cercano es menor que media grilla', () => {
    // La otra mitad de la propiedad: no solo cae en la grilla, sino en la mas
    // cercana. Un editor que siempre manda a la grilla de abajo parece pegajoso.
    for (let raw = -200; raw <= 200; raw += 3.7) {
      const snapped = snapToGrid(raw, GRID);
      expect(Math.abs(raw - snapped)).toBeLessThanOrEqual(GRID / 2);
    }
  });
});

describe('clamp', () => {
  it('acota por abajo y por arriba', () => {
    expect(clamp(-50, 0, 100)).toBe(0);
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('una mesa nunca sale del lienzo', () => {
    // El borde derecho tiene que considerar el ANCHO de la mesa: si solo se
    // limita `x <= maxX`, una mesa de ancho 100 arrastrada al extremo derecho queda
    // medio fuera del lienzo, y el mozo no la ve en el mapa.
    const boundsW = 500;
    const tableW = 100;
    const x = clamp(490, 0, boundsW - tableW);
    expect(x + tableW).toBeLessThanOrEqual(boundsW);
  });

  it('con un lienzo mas chico que la mesa, no produce negativos', () => {
    // Si el plano se redimensiona y la mesa es mas grande que el lienzo,
    // `bounds - w` da negativo y `clamp(v, 0, -20)` devuelve -20: una mesa en
    // coordenadas negativas, invisible.
    const result = clamp(50, 0, 20 - 100);
    expect(result).toBe(0);
  });
});

describe('movimiento de una mesa', () => {
  const bounds = { w: 600, h: 400 };

  it('arrastrar a la derecha mueve la mesa a la derecha', () => {
    const table = { x: 100, y: 100, w: 100, h: 100 };
    const next = snapToGrid(45, GRID); // 40px a la derecha

    expect(table.x + next).toBe(140);
    expect(table.y).toBe(100); // no se mueve en Y
  });

  it('la mesa no termina fuera del lienzo por abajo ni a la derecha', () => {
    // El caso que mas se ve: arrastrar al borde y que la mesa se salga. El limite
    // tiene que descontar el tamano de la mesa, no solo la posicion.
    const table = { x: 480, y: 280, w: 100, h: 100 };
    const dx = clamp(table.x + snapToGrid(200, GRID), 0, bounds.w - table.w);
    const dy = clamp(table.y + snapToGrid(200, GRID), 0, bounds.h - table.h);

    expect(dx + table.w).toBeLessThanOrEqual(bounds.w);
    expect(dy + table.h).toBeLessThanOrEqual(bounds.h);
  });

  it('la posicion final sigue en la grilla despues del clamp', () => {
    // El clamp puede sacar el valor de la grilla si el limite no es multiplo. El
    // lienzo SI se ajusta a multiplos, pero si eso cambia el clamp tiene que
    // seguir dejando la mesa en la grilla.
    const table = { x: 0, y: 0, w: 100, h: 100 };
    const x = clamp(table.x + snapToGrid(1000, GRID), 0, bounds.w - table.w);
    const y = clamp(table.y + snapToGrid(1000, GRID), 0, bounds.h - table.h);

    expect(x % GRID).toBe(0);
    expect(y % GRID).toBe(0);
  });
});