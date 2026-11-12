import { z } from 'zod';
import {
  categorySchema,
  modifierGroupSchema,
  modifierSchema,
  productSchema,
  stationSchema,
  uuidSchema,
} from '@comanda/domain';

/**
 * Contratos de entrada del catalogo.
 *
 * Los esquemas de solo lectura (que describes una estacion, un producto) viven en
 * `@comanda/domain`: son la frontera compartida con el POS y con la replica local.
 * Aca van los de **escritura**, que no tienen por que coincidir con el POS: la
 * replica nunca crea un producto, la hace el backend desde la pantalla de
 * administracion del local.
 *
 * Aun asi, los campos se toman de los esquemas del dominio (`productSchema.shape`)
 * en lugar de reescribirlos. Si el dominio agrega un maximo o cambia el tipo de un
 * campo, el input de la API lo hereda sin que nadie tenga que acordarse.
 */

/** Campos del dominio de una estacion, para no duplicar reglas de largo y tipo. */
const stationFields = stationSchema.shape;
/** Campos del dominio de una categoria. */
const categoryFields = categorySchema.shape;
/** Campos del dominio de un producto. */
const productFields = productSchema.shape;
/** Campos del dominio de un grupo de modificadores. */
const modifierGroupFields = modifierGroupSchema.shape;
/** Campos del dominio de un modificador. */
const modifierFields = modifierSchema.shape;

/** Precios en enteros, sin excepciones. Un float en un cobro no llega al cierre. */
const priceCentsSchema = productFields.priceCents;

/**
 * Alta de una estacion de trabajo.
 *
 * `kind` decide a que impresora o KDS manda el pedido. El default es `cocina`
 * porque es el caso mayoritario y equivocarse manda la comanda al lugar menos
 * molesto.
 */
export const createStationSchema = z.object({
  name: stationFields.name,
  kind: stationFields.kind.default('cocina'),
  printerTarget: stationFields.printerTarget.default(null),
  sort: stationFields.sort.default(0),
});
export type CreateStationInput = z.infer<typeof createStationSchema>;

/**
 * Edicion de una estacion.
 *
 * Todo opcional y en un solo `PATCH`: el POS no tiene un "editar estacion en
 * Blanco", tiene un formulario con algunos campos tocados. Un endpoint de
 * reemplazo completo obligaria al cliente a mandar la fila entera y a riesgo de
 * pisar con `undefined` lo que no edita.
 */
export const updateStationSchema = createStationSchema.partial();
export type UpdateStationInput = z.infer<typeof updateStationSchema>;

/**
 * Alta de una categoria.
 *
 * `venueId` NO se acepta desde el body: sale de la sesion. Si el cliente pudiera
 * declararlo, un Encargado podria crear una categoria en un local de otra
 * organizacion escribiendo un id a mano.
 */
export const createCategorySchema = z.object({
  name: categoryFields.name,
  sort: categoryFields.sort.default(0),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema.partial().extend({
  /** Reactivar una categoria archivada. Archivar y reactivar son la misma fila. */
  active: z.boolean().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

/**
 * Filtros del listado de productos. Todos opcionales: sin filtros, lista todo.
 *
 * Los dos booleanos viajan como el string `"true"`/`"false"` y NO como `boolean`.
 * Dos razones, y las dos importan:
 *
 *  1. Vienen de un query string, donde todo llega como texto.
 *  2. `z.coerce.boolean()` convierte cualquier string no vacio en `true`, asi que
 *     `available=false` se volveria `true` y el filtro invertido esconderia
 *     productos en vez de mostrarlos. Es un bug silencioso: el endpoint responde
 *     200 y devuelve la lista equivocada.
 *
 * Por eso son strings y los interpreta el servicio, que es donde se decide que
 * "no vino el filtro" y "vino `false`" son cosas distintas.
 */
export const productFilterSchema = z.object({
  categoryId: uuidSchema.optional(),
  stationId: uuidSchema.optional(),
  /**
   * Sin este campo el listado devuelve SOLO lo disponible.
   *
   * Es el default del POS: un producto agotado o deshabilitado tiene que salir de
   * la pantalla sin que el mozo este mirando ningun filtro. Se puede pedir
   * explicitamente `available=false` para ver lo que esta dado de baja, que es lo
   * que necesita la pantalla de administracion.
   */
  available: z.enum(['true', 'false']).optional(),
  /** Busqueda por nombre, insensible a mayusculas. Es lo que usa el buscador. */
  search: z.string().trim().min(1).max(120).optional(),
  /** Traer tambien lo dado de baja. Solo administracion; el POS nunca lo pide. */
  includeUnavailable: z.enum(['true', 'false']).optional(),
});
export type ProductFilter = z.infer<typeof productFilterSchema>;

/**
 * Alta de un producto.
 *
 * `modifierGroupIds` viaja en el alta en vez de tener un endpoint aparte: un
 * producto sin sus grupos es un producto que el POS no sabe mostrar, y el mozo
 * recien lo cargaria en un formulario a medias. Los ids tienen que ser de esta
 * organizacion (lo resuelve la RLS, no un `WHERE org_id` escrito a mano).
 */
export const createProductSchema = z.object({
  categoryId: productFields.categoryId,
  name: productFields.name,
  sku: productFields.sku.default(null),
  priceCents: priceCentsSchema,
  taxRate: productFields.taxRate.default(0),
  stationId: productFields.stationId.default(null),
  available: z.boolean().default(true),
  tracksStock: z.boolean().default(true),
  allergens: productFields.allergens.default([]),
  tags: productFields.tags.default([]),
  sort: productFields.sort.default(0),
  modifierGroupIds: z.array(uuidSchema).max(20).default([]),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

/**
 * Edicion de un producto.
 *
 * `reason` es opcional en el esquema y obligatorio en el servicio **cuando el
 * precio cambia**: la regla depende del valor anterior, que aca no se conoce. El
 * dominio ya marca `product.price_changed` como accion que exige motivo escrito
 * (`AUDIT_ACTIONS_REQUIRING_REASON`), asi que la regla se aplica donde se puede
 * decidir y no se copia una validacion incompleta en el borde HTTP.
 */
export const updateProductSchema = z
  .object({
    categoryId: productFields.categoryId.optional(),
    name: productFields.name.optional(),
    sku: productFields.sku.nullable().optional(),
    priceCents: priceCentsSchema.optional(),
    taxRate: productFields.taxRate.optional(),
    stationId: productFields.stationId.nullable().optional(),
    available: z.boolean().optional(),
    tracksStock: z.boolean().optional(),
    allergens: productFields.allergens.optional(),
    tags: productFields.tags.optional(),
    sort: productFields.sort.optional(),
    modifierGroupIds: z.array(uuidSchema).max(20).optional(),
    reason: z.string().min(3, 'Conta por que cambias el precio.').max(300).optional(),
  })
  .refine(
    // Un PATCH sin ningun campo no es un error de validacion de un campo sino una
    // peticion sin sentido. Se filtra aca para que el servicio no tenga que
    // distinguir "no hay nada que hacer" de "no me pasaste nada".
    (value) =>
      Object.entries(value).some(([key, field]) => key !== 'reason' && field !== undefined),
    { message: 'No mandaste ningun campo para cambiar.' },
  );
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

/** Activar o desactivar un producto. Es una accion puntual, no un PATCH. */
export const setAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().min(3, 'Conta por que lo das de baja.').max(300).optional(),
});
export type SetAvailabilityInput = z.infer<typeof setAvailabilitySchema>;

/** Alta de un grupo de modificadores ("Leche", "Punto de coccion", "Extras"). */
export const createModifierGroupSchema = z.object({
  name: modifierGroupFields.name,
  minSelect: modifierGroupFields.minSelect.default(0),
  maxSelect: modifierGroupFields.maxSelect.default(1),
  sort: modifierGroupFields.sort.default(0),
});
export type CreateModifierGroupInput = z.infer<typeof createModifierGroupSchema>;

/**
 * `maxSelect >= minSelect` se valida aca y no solo en la base.
 *
 * La constraint `modifier_groups` la impone igual, pero una constraint rechazada
 * llega al cliente como 500 con el texto de Postgres. Un mensaje que diga "el maximo
 * no puede ser menor que el minimo" es la diferencia entre un formulario que se
 * explica y un ticket al que nadie responde.
 */
export const updateModifierGroupSchema = createModifierGroupSchema
  .partial()
  .extend({ active: z.boolean().optional() })
  .refine(
    (value) =>
      value.minSelect === undefined ||
      value.maxSelect === undefined ||
      value.maxSelect >= value.minSelect,
    {
      message: 'El maximo no puede ser menor que el minimo.',
      path: ['maxSelect'],
    },
  );
export type UpdateModifierGroupInput = z.infer<typeof updateModifierGroupSchema>;

/**
 * Alta de un modificador.
 *
 * `priceDeltaCents` acepta negativos a proposito: "menos queso" descuenta y "sin
 * hielo" vale 0. Lo que no existe es un delta flotante.
 */
export const createModifierSchema = z.object({
  groupId: modifierFields.groupId,
  name: modifierFields.name,
  priceDeltaCents: modifierFields.priceDeltaCents.default(0),
  recipeOverride: modifierFields.recipeOverride.default({}),
  sort: modifierFields.sort.default(0),
});
export type CreateModifierInput = z.infer<typeof createModifierSchema>;

export const updateModifierSchema = createModifierSchema
  .partial()
  .extend({ active: z.boolean().optional() });
export type UpdateModifierInput = z.infer<typeof updateModifierSchema>;

/** Opciones de listado de categorias. */
export interface ListCategoriesOptions {
  /** Mostrar tambien las archivadas. Solo la pantalla de administracion lo pide. */
  includeArchived?: boolean;
}
