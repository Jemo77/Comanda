import { getAccessToken } from './token';

/**
 * Guardado del plano.
 *
 * A diferencia de la venta, **ajustar el plano no pasa por la outbox**. Es una
 * operacion de configuracion del local, no una accion de mostrador: no tiene que
 * funcionar sin red y no debe quedar pendiente de sincronizar. Si el local esta
 * configuring su salon y no hay internet, tiene que saber que no guardo, y no
 * descubrirlo tres dias despues cuando reorganiza la terraza.
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

/**
 * Tope de cambios por lote.
 *
 * Es el mismo `LAYOUT_MAX_CHANGES` del servidor. Va en el cliente tambien para
 * poder partir sin preguntar: mandar 400 cambios y que el servidor los rechace
 * seria una sorpresa, y partir es lo que hay que hacer igual.
 */
const MAX_CHANGES = 200;

export interface LayoutChange {
  tableId: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

/**
 * Guarda las posiciones de varias mesas en una sola llamada.
 *
 * Un lote y no un request por mesa: el editor manda lo que se movio en los ultimos
 * 400 ms, que al acomodar un salon entero son quince mesas. Quince requests en un
 *Gesture de medio segundo es quince viajes y quince chances de que uno falle.
 *
 * Si el guardado falla, el error sube. No se reintenta solo: la pantalla revierte
 * a la posicion anterior, y reenviar una posicion que el servidor rechazo por
 * invalida seria insistir.
 */
export async function saveLayout(changes: readonly LayoutChange[]): Promise<void> {
  if (changes.length === 0) return;
  if (changes.length > MAX_CHANGES) {
    throw new Error('Demasiadas mesas movidas a la vez.');
  }

  const token = getAccessToken();
  if (!token) {
    throw new Error('Tu sesión venció. Entrá de nuevo para guardar el plano.');
  }

  const response = await fetch(`${API_URL}/tables/layout`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ changes }),
  });

  if (!response.ok) {
    throw new Error(await detailOf(response));
  }
}

/**
 * Crea una mesa en el sector.
 *
 * La posicion y la etiqueta las elige el servidor. Buscar un hueco libre y
 * encontrar el siguiente numero es logica del dominio, no del editor: el
 * navegador no tiene por que saber como numera las mesas el local.
 */
export async function createTable(floorId: string): Promise<string> {
  const token = getAccessToken();
  if (!token) throw new Error('Tu sesión venció. Entrá de nuevo.');

  const response = await fetch(`${API_URL}/tables`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ floorId, name: 'Nueva', kind: 'rect', seats: 4, x: 0, y: 0 }),
  });

  if (!response.ok) throw new Error(await detailOf(response));

  const body = (await response.json()) as { table?: { id?: string } };
  const id = body.table?.id;
  if (typeof id !== 'string') throw new Error('La API no devolvió la mesa creada.');
  return id;
}

/**
 * El mensaje del servidor, si lo hay.
 *
 * Un error generico tipo "fallo la request" no le dice al encargado que su mesa
 * tiene las coordenadas invalidas. El `detail` del problem+json si.
 */
async function detailOf(response: Response): Promise<string> {
  try {
    const problem = (await response.json()) as { detail?: string };
    if (typeof problem.detail === 'string' && problem.detail.length > 0) return problem.detail;
  } catch {
    // Respuesta que no es JSON. El codigo HTTP alcanza.
  }
  return `La API respondió ${response.status}.`;
}