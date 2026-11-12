import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category, Station, Venue } from '@comanda/domain';

// La replica y el token se stubean antes de importar la hidratacion:
// lo que se prueba aca es la logica de validacion y de escritura, no
// Dexie ni la red real.
const store = vi.hoisted(() => ({
  token: 'token-1' as string | null,
  priceRuleWrites: [] as unknown[],
  promotionsStatus: 200 as number,
  fetched: [] as string[],
}));

vi.mock('../data/token', () => ({
  getAccessToken: () => store.token,
}));

vi.mock('../data/db', () => ({
  db: {
    stations: { bulkPut: async () => undefined },
    categories: { bulkPut: async () => undefined },
    products: { bulkPut: async () => undefined },
    floors: { bulkPut: async () => undefined },
    floorTables: { bulkPut: async () => undefined },
    priceRules: {
      bulkPut: async (rules: unknown[]) => {
        store.priceRuleWrites.push(...rules);
      },
      // `toArray` es lo que lee la hidratacion para llenar la cache
      // de precios desde la replica al arrancar.
      toArray: async () => [...store.priceRuleWrites],
    },
    transaction: async (
      _mode: string,
      _stores: unknown,
      run: () => Promise<void>,
    ) => {
      await run();
    },
  },
}));

const { hydrateCatalog } = await import('./catalog');
const {
  getActiveRules,
  getVenueCurrency,
  setActiveRules,
  setVenuePricing,
} = await import('../state/pricing');

const VENUE_ID = '11111111-1111-4111-8111-111111111111';

const station: Station = {
  id: '22222222-2222-4222-8222-222222222222',
  venueId: VENUE_ID,
  name: 'Barra',
  kind: 'bar',
  printerTarget: null,
  sort: 0,
  active: true,
};

const category: Category = {
  id: '33333333-3333-4333-8333-333333333333',
  venueId: null,
  name: 'Cafeteria',
  sort: 0,
  active: true,
};

const venue: Venue = {
  id: VENUE_ID,
  orgId: '44444444-4444-4444-8444-444444444444',
  name: 'Local Centro',
  kind: 'bar',
  address: null,
  timezone: 'America/Argentina/Buenos_Aires',
  currency: 'ARS',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Promo valida: 10% sobre un producto puntual. */
const validRule = {
  id: '55555555-5555-4555-8555-555555555555',
  name: 'Happy Hour cafe',
  venueId: null,
  type: 'PERCENT',
  scope: 'PRODUCT',
  scopeId: '66666666-6666-4666-8666-666666666666',
  schedule: null,
  params: { bps: 1000 },
  priority: 0,
  stackable: false,
  active: true,
};

/** Promo invalida: ORDER no puede llevar scopeId. */
const invalidRule = {
  id: '77777777-7777-4777-8777-777777777777',
  name: 'Rota',
  type: 'PERCENT',
  scope: 'ORDER',
  scopeId: '66666666-6666-4666-8666-666666666666',
  params: { bps: 1000 },
  priority: 0,
  stackable: false,
  active: true,
};

function jsonFor(url: string): unknown {
  if (url.endsWith('/catalog/stations')) return { stations: [station] };
  if (url.endsWith('/catalog/categories')) return { categories: [category] };
  if (url.endsWith('/catalog/products')) return { products: [] };
  if (url.endsWith('/tables/plan')) return { floors: [] };
  if (url.endsWith('/promotions')) return { rules: [validRule, invalidRule] };
  if (url.endsWith('/venues')) return { venues: [venue] };
  throw new Error(`URL no prevista en el test: ${url}`);
}

beforeEach(() => {
  store.token = 'token-1';
  store.priceRuleWrites.length = 0;
  store.promotionsStatus = 200;
  store.fetched.length = 0;
  // Estado de modulo: sin reset, la promo de un test se aplicaria
  // en el siguiente. La moneda y la zona arrancan en valores que
  // ningun local devuelve, para ver si la hidratacion las pisotea.
  setActiveRules([]);
  setVenuePricing('XXX', 'Pacific/Auckland');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    store.fetched.push(url);
    const ok = !(url.endsWith('/promotions') && store.promotionsStatus !== 200);
    return {
      ok,
      status: url.endsWith('/promotions') ? store.promotionsStatus : 200,
      json: async () => jsonFor(url),
    } as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hydrateCatalog', () => {
  it('hidrata la carta, las promos validas y la moneda del local', async () => {
    const result = await hydrateCatalog(VENUE_ID);

    expect(result).toEqual({
      categories: 1,
      products: 0,
      stations: 1,
      floors: 0,
      tables: 0,
      rules: 1,
    });
    // La promo invalida no se escribe y la valida si: una regla
    // incoherente no es una regla.
    expect(store.priceRuleWrites).toHaveLength(1);
    expect((store.priceRuleWrites[0] as { id: string }).id).toBe(
      validRule.id,
    );
    // La cache de precios es lo que va a evaluar el motor offline.
    expect(getActiveRules().map((rule) => rule.id)).toEqual([validRule.id]);
    // La moneda y la zona del local son los datos que definen si
    // un happy hour esta vigente.
    expect(getVenueCurrency()).toBe('ARS');
  });

  it('una lista de promos entera rota no saca la carta', async () => {
    store.promotionsStatus = 500;

    const result = await hydrateCatalog(VENUE_ID);

    // El 500 de /promotions se aisla: el mozo sigue vendiendo con
    // la carta y con las reglas que ya tenia.
    expect(result.categories).toBe(1);
    expect(result.stations).toBe(1);
    expect(result.rules).toBe(0);
    expect(getActiveRules()).toEqual([]);
  });

  it('un local que no esta en la lista no cambia moneda ni zona', async () => {
    // Si el local de la sesion no aparece (raro, pero posible si
    // acabaron de transferir el usuario), la hidratacion no debe
    // inventar una moneda: los precios ya congelados siguen en la
    // moneda en que se tomaron.
    await hydrateCatalog('99999999-9999-4999-8999-999999999999');

    expect(getVenueCurrency()).toBe('XXX');
  });

  it('sin token no pide nada y no toca la cache', async () => {
    store.token = null;

    const result = await hydrateCatalog(VENUE_ID);

    expect(result).toEqual({
      categories: 0,
      products: 0,
      stations: 0,
      floors: 0,
      tables: 0,
      rules: 0,
    });
    expect(store.fetched).toHaveLength(0);
  });

  it('la replica es la que llena la cache cuando no hay red', async () => {
    // Un arranque offline: la hidratacion pide y falla, pero la
    // cache ya se lleno con la replica antes de tocar la red.
    store.priceRuleWrites.push(validRule);
    vi.stubGlobal('fetch', async () => {
      throw new Error('sin red');
    });

    await expect(hydrateCatalog(VENUE_ID)).rejects.toThrow();
    expect(getActiveRules().map((rule) => rule.id)).toEqual([validRule.id]);
  });
});
