import {
  productWithModifiersSchema,
  type Category,
  type Product,
  type Station,
  type Venue,
} from '@comanda/domain';
import { promotionRuleSchema } from '@comanda/pricing-engine';
import {
  db,
  type LocalFloor,
  type LocalFloorTable,
  type LocalPriceRule,
  type LocalProduct,
} from './db';
import { getAccessToken } from './token';
import { setActiveRules, setVenuePricing } from '../state/pricing';

/**
 * Hidratacion de la carta, el salon y las promociones.
 *
 * La carta (categorias, productos con sus modificadores, estaciones), el
 * plano (sectores y mesas) y las reglas de precio son de **solo lectura**
 * para el POS y no pasan por la outbox: son datos que el dueno fijo, y no
 * hay conflicto posible sobre un precio que ya esta decidido. Por eso viven
 * en una replica propia (`data/db.ts`) y se hidratan por HTTP, en vez de
 * bajar por el `pull` de sincronizacion.
 *
 * Todo lo que baja se valida con los esquemas del dominio (o del motor,
 * para las promos) antes de escribirse. Una carta corrupta en la replica
 * es peor que una carta ausente: el mozo cobra con el numero que tiene en
 * pantalla, no con el que quiere el servidor.
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

/** Cuantos productos se piden `/full` a la vez. */
const PRODUCT_BATCH = 6;

/** Lo que el seed y la API dejan escrito, resumido para el log de hidratacion. */
export interface HydrationResult {
  categories: number;
  products: number;
  stations: number;
  floors: number;
  tables: number;
  /** Reglas de promo validas en la replica al terminar. */
  rules: number;
}

/** Sector con sus mesas: la forma de `GET /tables/plan`. */
interface FloorPlanFloor extends LocalFloor {
  tables: LocalFloorTable[];
}

/**
 * Descarga la carta del local y la escribe en la replica.
 *
 * Se llama al entrar con PIN y despues de cada ciclo de sync: el POS tiene
 * que seguir funcionando sin red, pero cuando hay red la carta del dueno manda.
 *
 * `venueId` es el local de la sesion: permite tomar la moneda y la zona
 * horaria del local de la lista de locales, que son los dos datos que el
 * motor de precios necesita para saber si un happy hour esta vigente.
 *
 * Falla sin tocar la replica anterior. Una carta a medio hidratar es peor que
 * la carta de ayer: el mozo cobra con lo que ve, y si ve la mitad, cobra la mitad.
 */
export async function hydrateCatalog(venueId: string): Promise<HydrationResult> {
  // La cache de precios arranca con lo que ya esta en la replica, **antes**
  // de tocar la red: un arranque sin conexion sigue aplicando las promos de
  // la ultima sincronizacion, que es justamente el momento en que mas se
  // vende. Si la red despues responde, la cache se actualiza con las
  // reglas frescas al final de la hidratacion.
  await loadPricingFromReplica();

  const token = getAccessToken();
  const empty: HydrationResult = {
    categories: 0,
    products: 0,
    stations: 0,
    floors: 0,
    tables: 0,
    rules: 0,
  };
  if (!token) return empty;

  const headers = { Authorization: `Bearer ${token}` };

  // Los pedidos base van en paralelo: son la latencia de la red del local,
  // que es la variable que mas fluctua, y el POS esta parado mientras hidrata.
  //
  // Las promociones y los locales tienen su propio `catch` a proposito: un
  // rol sin `promotion.read` (o un 500 de esos caminos) no puede sacar al
  // POS de la carta. Las reglas que ya estan en la replica siguen rigiendo,
  // que es exactamente el comportamiento de una caida de red.
  const [stations, categories, products, plan, promotionList, venueList] =
    await Promise.all([
      get<{ stations: Station[] }>('/catalog/stations', headers),
      get<{ categories: Category[] }>('/catalog/categories', headers),
      get<{ products: Product[] }>('/catalog/products', headers),
      get<{ floors: FloorPlanFloor[] }>('/tables/plan', headers),
      get<unknown>('/promotions', headers).catch(() => null),
      get<{ venues: Venue[] }>('/venues', headers).catch(() => ({
        venues: [],
      })),
    ]);

  const rules = hydrateRules(promotionList);
  const venue = venueList.venues.find((candidate) => candidate.id === venueId);

  const full = await withModifierGroups(products.products, headers);

  const nextProducts: LocalProduct[] = full.map((product) => ({
    ...product,
    // El endpoint de listado no trae la categoria ni la disponibilidad como el POS
    // las necesita: se leen del mismo objeto de la API, no de otra consulta.
    categoryId: product.categoryId,
    name: product.name,
    priceCents: product.priceCents,
    taxRate: product.taxRate,
    stationId: product.stationId,
    available: product.available,
  }));

  await db.transaction(
    'rw',
    [db.stations, db.categories, db.products, db.floors, db.floorTables, db.priceRules],
    async () => {
      await db.stations.bulkPut(stations.stations);
      await db.categories.bulkPut(categories.categories);
      await db.products.bulkPut(nextProducts);
      await db.floors.bulkPut(
        plan.floors.map((floor) => ({ id: floor.id, name: floor.name, sort: floor.sort })),
      );
      await db.floorTables.bulkPut(plan.floors.flatMap((floor) => floor.tables));
      await db.priceRules.bulkPut(rules);
    },
  );

  // La cache de precios se actualiza **despues** de escribir la replica: si
  // algo revienta aca, la replica ya tiene las reglas y el proximo arranque
  // las levanta solo.
  setActiveRules(rules);
  if (venue) setVenuePricing(venue.currency, venue.timezone);

  return {
    categories: categories.categories.length,
    products: nextProducts.length,
    stations: stations.stations.length,
    floors: plan.floors.length,
    tables: plan.floors.reduce((acc, floor) => acc + floor.tables.length, 0),
    rules: rules.length,
  };
}

/**
 * Llena la cache de precios desde la replica.
 *
 * Es lo primero que hace la hidratacion y no necesita red: las reglas
 * ya sincronizadas son las que rigen un arranque offline, y dejarlas
 * afuera hasta la primera sincronizacion exitosa seria vender sin
 * Happy Hour toda la manana en que se cayo el cable.
 */
async function loadPricingFromReplica(): Promise<void> {
  const rules = await db.priceRules.toArray();
  setActiveRules(rules);
}

/**
 * Valida las reglas de la respuesta de `/promotions` una a uno.
 *
 * Una promo corrupta se salta y se loguea, no se lleva puesta la
 * hidratacion entera: el mozo sigue vendiendo con la carta y las demas
 * promos siguen rigiendo. La fila mala vuelve a bajar en la proxima
 * sincronizacion, cuando el dueno la arregle.
 */
function hydrateRules(response: unknown): LocalPriceRule[] {
  const candidates =
    response && typeof response === 'object'
      ? (response as { rules?: unknown }).rules
      : null;
  if (!Array.isArray(candidates)) return [];

  const rules: LocalPriceRule[] = [];
  for (const candidate of candidates) {
    const parsed = promotionRuleSchema.safeParse(candidate);
    if (parsed.success) {
      rules.push(parsed.data);
    } else {
      console.warn('Promo descartada por no validar:', parsed.error.issues);
    }
  }
  return rules;
}

/**
 * Reemplaza los productos por su version con los grupos de modificadores anidados.
 *
 * `GET /catalog/products` devuelve la carta plana; el arbol de configurables vive
 * en `products/:id/full`, que es una consulta por producto. Con una carta de 40
 * productos son 40 viajes de red, asi que van en tandas: de a uno tarda mas que la
 * patience del mostrador, y de a cuarenta satura el pool de la API con una pantalla
 * por item.
 *
 * Un producto que falla se queda sin grupos: el POS lo agrega directo al ticket,
 * que es exactamente lo que hacia antes de que existiera el concepto de
 * modificador. Perder un configurable es una molestia; perder la carta entera es
 * que el local no pueda vender.
 */
async function withModifierGroups(
  products: readonly Product[],
  headers: Record<string, string>,
): Promise<ReturnType<typeof productWithModifiersSchema.parse>[]> {
  const out: ReturnType<typeof productWithModifiersSchema.parse>[] = [];

  for (let start = 0; start < products.length; start += PRODUCT_BATCH) {
    const batch = products.slice(start, start + PRODUCT_BATCH);
    const resolved = await Promise.all(
      batch.map(async (product) => {
        try {
          const body = await get<{ product: unknown }>(
            `/catalog/products/${product.id}/full`,
            headers,
          );
          // Se revalida lo que vino de la red antes de guardarlo: el POS no
          // formatea importes ni elige modificadores sobre un objeto que nunca
          // paso por el esquema del dominio.
          return productWithModifiersSchema.parse(body.product);
        } catch {
          return productWithModifiersSchema.parse({ ...product, groups: [] });
        }
      }),
    );
    out.push(...resolved);
  }

  return out;
}

/**
 * Un `GET` autenticado contra la API.
 *
 * No reintenta y no espera: el motor de sincronizacion ya tiene su propio ciclo de
 * reintentos, y duplicar la espera aca seria mostrar una pantalla "cargando" que
 * el mozo no puede hacer otra cosa que mirar.
 */
async function get<T>(path: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`La API respondio ${response.status} a ${path}`);
  }
  return (await response.json()) as T;
}
