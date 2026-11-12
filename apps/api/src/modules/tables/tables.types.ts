import { TableStatus } from '@comanda/domain';
import { z } from 'zod';

/**
 * Contratos de entrada del salon: sectores y mesas.
 *
 * Viven en el modulo y no en `@comanda/domain` a proposito. Los esquemas de
 * `domain` son el **formato de la replica y de la outbox** (el POS los corre en el
 * navegador para validar antes de subir); estos son peticiones de administracion
 * del local. Meterlos en `domain` obligaria al POS a cargar el contrato del editor de
 * planos para no hacer nada con el.
 *
 * El rango de la grilla si es dominio compartido, porque el POS lo necesita para
 * acotar el drag antes de que cada request sea un 422.
 */

/**
 * Rango de las coordenadas del plano.
 *
 * La columna es `numeric(8,2)`: admite hasta 999999.99, o sea que la base no acota
 * nada por si sola. El editor trabaja en unidades de grilla (una mesa mide 100x100
 * por default), asi que 5000 es "cinco locales de mesas" y -1000 alcanza para que una
 * mesa medio arrastrada fuera del lienzo siga siendo representable en vez de
 * pegarse al borde.
 *
 * Ademas hay una razon de UI: el editor calcula hit-testing y escalado sobre estos
 * numeros, y un valor de 999999 (un arrastre que se escapó del canvas) lo hace
 * renderizar fuera de la pantalla sin error visible, que es peor que un 422.
 */
export const GRID_MIN = -1000;
export const GRID_MAX = 5000;

/**
 * Rango del ancho y el alto. Mas chico que 1 no se puede arrastrar; mas grande que
 * 2000 taparia el salon entero, que casi siempre es un arrastre con el valor
 * duplicado por un bug del editor y no una mesa gigante de verdad.
 */
export const SIZE_MIN = 1;
export const SIZE_MAX = 2000;

/** Maximo de mesas por lote del editor. Acota el largo del UPDATE ... FROM VALUES. */
export const LAYOUT_MAX_CHANGES = 200;

/** Posicion en la grilla. Finito y acotado: un `Infinity` llega al `numeric` y rompe. */
const gridPosition = z
  .number()
  .finite('La posicion tiene que ser un numero finito.')
  .min(GRID_MIN)
  .max(GRID_MAX);

/** Ancho o alto en la grilla. */
const gridSize = z
  .number()
  .finite('El tamano tiene que ser un numero finito.')
  .min(SIZE_MIN)
  .max(SIZE_MAX);

/** Cantidad de lugares. El tope de 40 sale del dominio (`floorTableSchema`). */
const seats = z.number().int().min(1).max(40);

/** Etiqueta visible de la mesa: `varchar(20)` en la base, 20 en el dominio. */
const label = z.string().trim().min(1, 'La mesa necesita un nombre.').max(20);

const floorName = z.string().trim().min(1, 'El sector necesita un nombre.').max(60);

const shape = z.enum(['rect', 'round', 'square']);

/**
 * Alta de sector.
 *
 * `sort` es manual y no `position`: el orden del plano lo decide el local ("Patio"
 * al final), y no se reordena solo porque se creo despues.
 */
export const createFloorSchema = z.object({
  name: floorName,
  sort: z.number().int().min(0).max(999).default(0),
});
export type CreateFloorInput = z.infer<typeof createFloorSchema>;

/**
 * Renombre (o reordenamiento) de sector.
 *
 * Es un PATCH, pero se rechaza el cuerpo vacio: un `{}` que responde 200 y no cambia
 * nada hace creer al POS que guardo cuando en realidad no guardo.
 */
export const renameFloorSchema = z
  .object({
    name: floorName.optional(),
    sort: z.number().int().min(0).max(999).optional(),
  })
  .refine((value) => value.name !== undefined || value.sort !== undefined, {
    message: 'Mandá al menos el nuevo nombre o el nuevo orden del sector.',
  });
export type RenameFloorInput = z.infer<typeof renameFloorSchema>;

/**
 * Alta de mesa.
 *
 * La geometria tiene default en el servidor y no en el editor: las cuatro columnas
 * son `NOT NULL`, y un default aqui evita que el POS tenga que conocer los valores
 * magicos de la migracion.
 */
export const createTableSchema = z.object({
  floorId: z.string().uuid(),
  label,
  seats: seats.default(2),
  x: gridPosition.default(0),
  y: gridPosition.default(0),
  w: gridSize.default(100),
  h: gridSize.default(100),
  shape: shape.default('rect'),
});
export type CreateTableInput = z.infer<typeof createTableSchema>;

/**
 * Edicion de mesa: nombre, lugares y geometria.
 *
 * NO acepta `status`. El estado de una mesa no se edita: se deriva de si tiene
 * comanda abierta, y el unico camino para ocuparla es el sync (ver `setStatus`).
 */
export const updateTableSchema = z
  .object({
    label: label.optional(),
    seats: seats.optional(),
    x: gridPosition.optional(),
    y: gridPosition.optional(),
    w: gridSize.optional(),
    h: gridSize.optional(),
    shape: shape.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Mandá al menos un campo para cambiar.',
  });
export type UpdateTableInput = z.infer<typeof updateTableSchema>;

/**
 * Cambio de estado manual.
 *
 * Acepta el enum completo a proposito: el enum es el contrato, y el rechazo de
 * `OCUPADA`/`PIDIO_CUENTA` lo hace el servicio con un mensaje que explica que hacer.
 * Aca una lista recortada devolveria un 422 de validacion ("valor invalido") sin
 * decir que abrir la comanda es lo que ocupa la mesa.
 */
export const setTableStatusSchema = z.object({
  status: TableStatus,
});
export type SetTableStatusInput = z.infer<typeof setTableStatusSchema>;

/** Filtro de `GET /tables`. */
export const listTablesQuerySchema = z.object({
  floorId: z.string().uuid().optional(),
});
export type ListTablesQuery = z.infer<typeof listTablesQuerySchema>;

/**
 * Una mesa movida en el plano.
 *
 * `w`/`h` son opcionales a proposito: arrastrar cambia la posicion, redimensionar
 * cambia el tamano, y el editor manda solo lo que el gesto toco. Enviar `w`/`h` en
 * cada arrastre los sobreescribiria con el valor anterior si la mesa venia de otro
 * dispositivo con otra escala.
 */
export const layoutChangeSchema = z.object({
  tableId: z.string().uuid(),
  x: gridPosition,
  y: gridPosition,
  w: gridSize.optional(),
  h: gridSize.optional(),
});
export type LayoutChange = z.infer<typeof layoutChangeSchema>;

/**
 * Lote del editor de planos: varias posiciones en una sola llamada.
 *
 * Existe porque la alternativa (un request por mesa al soltar el arrastre) convierte
 * un gesto de medio segundo en treinta requests en un local con Salon y Terraza.
 */
export const bulkLayoutSchema = z.object({
  changes: z
    .array(layoutChangeSchema)
    .min(1, 'Mandá al menos una mesa.')
    .max(LAYOUT_MAX_CHANGES, `Mandá de a ${LAYOUT_MAX_CHANGES} mesas por lote.`),
});
export type BulkLayoutInput = z.infer<typeof bulkLayoutSchema>;
