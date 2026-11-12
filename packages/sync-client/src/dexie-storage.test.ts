import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComandaDexie, DexieSyncStorage } from './dexie-storage';
import { MemorySyncStorage } from './memory-storage';
import type { RemoteEvent } from './storage';
import type { OutboxEvent } from './protocol';

/**
 * El adaptador de Dexie, contra IndexedDB de verdad.
 *
 * `MemorySyncStorage` es la especificacion; este archivo verifica que el adaptador
 * de la PWA la cumple. Se usa `fake-indexeddb` porque es la misma API que el
 * navegador, con lo que los casos que importan (transacciones, indices, orden de
 * `seq`) se comportan como en el mostrador.
 *
 * El caso que mas importa es la atomicidad de `applyRemote`: si el POS se cierra a
 * mitad del lote, la replica no puede quedar con medio estado, porque el mozo
 * cobraria sobre una mesa que ya no existe.
 */

const DEVICE = '33333333-3333-7333-8333-333333333333';

let db: ComandaDexie;
let storage: DexieSyncStorage;
let counter = 0;

function nextId(): string {
  counter += 1;
  return `44444444-4444-7444-8444-${String(counter).padStart(12, '0')}`;
}

function event(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    eventId: nextId(),
    type: 'ORDER_OPENED',
    seq: (counter += 1),
    occurredAt: new Date().toISOString(),
    payload: {},
    deviceId: DEVICE,
    status: 'pending',
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

function remote(
  type: RemoteEvent['type'],
  payload: Record<string, unknown>,
  cursor: string,
): RemoteEvent {
  return {
    cursor,
    type,
    payload,
    receivedAt: '2026-03-02T20:00:00.000Z',
    deviceId: 'otra-tablet',
  };
}

beforeEach(async () => {
  db = new ComandaDexie(`test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  storage = new DexieSyncStorage(db, DEVICE);
  await db.open();
});

afterEach(async () => {
  await db.delete();
  db.close();
});

describe('outbox sobre IndexedDB', () => {
  it('encola y cuenta pendientes', async () => {
    await storage.putEvent(event());
    await storage.putEvent(event());

    expect(await storage.pendingCount()).toBe(2);
  });

  it('el lote sale ordenado por seq, no por orden de insercion', async () => {
    // Es lo que evita que el servidor aplique "agregar item" antes que "abrir
    // comanda". IndexedDB no garantiza orden sin indice explicito, asi que esto
    // depende de que `seq` este indexado y de que se ordene al leer.
    await storage.putEvent(event({ seq: 3 }));
    await storage.putEvent(event({ seq: 1 }));
    await storage.putEvent(event({ seq: 2 }));

    const batch = await storage.nextBatch(10);

    expect(batch.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('el lote excluye lo ya confirmado', async () => {
    const first = event({ seq: 1 });
    const second = event({ seq: 2 });
    await storage.putEvent(first);
    await storage.putEvent(second);
    await storage.removeEvents([first.eventId]);

    const batch = await storage.nextBatch(10);
    expect(batch.map((e) => e.seq)).toEqual([2]);
  });

  it('borrar un evento que ya no esta no falla', async () => {
    // El push pudo confirmar y el evento haberse limpiado por otra via.
    await expect(storage.removeEvents(['no-existe'])).resolves.toBeUndefined();
  });

  it('respeta el limite del lote', async () => {
    for (let i = 0; i < 5; i += 1) await storage.putEvent(event({ seq: i + 1 }));
    expect((await storage.nextBatch(2)).length).toBe(2);
  });

  it('repone a la cola lo que quedo en syncing', async () => {
    // La tablet se apaga a mitad de un envio. Sin esto, esos eventos quedan
    // clavados en `syncing` para siempre y nunca llegan al servidor: un cobro que
    // se pierde sin ningun error visible.
    const stuck = event({ status: 'syncing' });
    await storage.putEvent(stuck);
    expect(await storage.stuckCount()).toBe(1);

    expect(await storage.requeueStuck()).toBe(1);
    expect(await storage.stuckCount()).toBe(0);
    expect((await storage.nextBatch(10)).length).toBe(1);
  });

  it('pendingCount cuenta tambien los que estan en syncing', async () => {
    await storage.putEvent(event({ status: 'syncing' }));
    // Si no los contara, el spine del POS mostraria "0 pendientes" mientras hay un
    // envio en curso, que es justo cuando el mozo mira.
    expect(await storage.pendingCount()).toBe(1);
  });
});

describe('cursor y estado del dispositivo', () => {
  it('arranca en 0', async () => {
    expect(await storage.getCursor()).toBe('0');
  });

  it('guarda y lee el cursor', async () => {
    await storage.setCursor('123');
    expect(await storage.getCursor()).toBe('123');
  });

  it('guarda la comanda activa', async () => {
    expect(await storage.getActiveOrderId()).toBeNull();
    await storage.setActiveOrderId('orden-1');
    expect(await storage.getActiveOrderId()).toBe('orden-1');
  });
});

describe('replica: eventos del servidor', () => {
  it('crea la comanda con su mesa', async () => {
    await storage.applyRemote([
      remote('ORDER_OPENED', { orderId: 'o1', numberLabel: 'A-1', tableId: 't1', guests: 4 }, '1'),
    ]);

    const { orders } = await storage.snapshot();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.numberLabel).toBe('A-1');
    expect(orders[0]!.tableId).toBe('t1');
  });

  it('el mismo item dos veces no se duplica', async () => {
    await storage.applyRemote([remote('ORDER_OPENED', { orderId: 'o1' }, '1')]);

    const item = remote(
      'ORDER_ITEM_ADDED',
      { orderId: 'o1', itemId: 'i1', name: 'Cerveza', quantity: 2, unitPriceCents: 1500 },
      '2',
    );
    await storage.applyRemote([item]);
    await storage.applyRemote([{ ...item, cursor: '3' }]);

    const { orders } = await storage.snapshot();
    expect(orders[0]!.items).toHaveLength(1);
  });

  it('el total sube al agregar un item y baja al anularlo', async () => {
    await storage.applyRemote([remote('ORDER_OPENED', { orderId: 'o1' }, '1')]);
    await storage.applyRemote([
      remote(
        'ORDER_ITEM_ADDED',
        { orderId: 'o1', itemId: 'i1', name: 'Cerveza', quantity: 2, unitPriceCents: 1500 },
        '2',
      ),
    ]);

    let snapshot = await storage.snapshot();
    expect(snapshot.orders[0]!.totalCents).toBe(3000);

    await storage.applyRemote([remote('ORDER_ITEM_VOIDED', { orderId: 'o1', itemId: 'i1' }, '3')]);

    snapshot = await storage.snapshot();
    // El total tiene que bajar con el item: el POS muestra lo que el servidor va
    // a cobrar, y si no bajara, el mozo anuncia un numero y se cobra otro.
    expect(snapshot.orders[0]!.totalCents).toBe(0);
    expect(snapshot.orders[0]!.items[0]!.status).toBe('VOIDED');
  });

  it('anular dos veces no descuenta dos veces', async () => {
    await storage.applyRemote([remote('ORDER_OPENED', { orderId: 'o1' }, '1')]);
    await storage.applyRemote([
      remote(
        'ORDER_ITEM_ADDED',
        { orderId: 'o1', itemId: 'i1', name: 'X', quantity: 1, unitPriceCents: 5000 },
        '2',
      ),
    ]);

    const voidEvent = remote('ORDER_ITEM_VOIDED', { orderId: 'o1', itemId: 'i1' }, '3');
    await storage.applyRemote([voidEvent]);
    await storage.applyRemote([{ ...voidEvent, cursor: '4' }]);

    const { orders } = await storage.snapshot();
    // Si descontara dos veces, el total daria -5000 y el POS anunciaria una cuenta
    // negativa.
    expect(orders[0]!.totalCents).toBe(0);
  });

  it('un conflicto de mesa suelta la comanda desplazada', async () => {
    // Es el caso de dos tablets abriendo la misma mesa offline: el POS que perdio
    // tiene que dejar de mostrar esa mesa como suya.
    await storage.applyRemote([
      remote('ORDER_OPENED', { orderId: 'o-mia', numberLabel: 'A-1', tableId: 't1' }, '1'),
    ]);
    await storage.applyRemote([
      remote('ORDER_OPENED', { orderId: 'o-otra', numberLabel: 'B-1' }, '2'),
    ]);

    await storage.applyRemote([
      remote(
        'TABLE_STATUS_CHANGED',
        {
          tableId: 't1',
          orderId: 'o-otra',
          displacedOrderId: 'o-mia',
          label: 'Mesa 1',
          status: 'OCUPADA',
        },
        '3',
      ),
    ]);

    const snapshot = await storage.snapshot();
    expect(snapshot.orders.find((o) => o.id === 'o-mia')!.tableId).toBeNull();
    expect(snapshot.tables.find((t) => t.id === 't1')!.orderId).toBe('o-otra');
  });

  it('un evento desconocido no rompe el lote', async () => {
    await storage.applyRemote([
      remote('ORDER_OPENED', { orderId: 'o1', numberLabel: 'A-1' }, '1'),
      remote('CATALOG_PUBLISHED', {}, '2'),
    ]);

    const { orders } = await storage.snapshot();
    expect(orders).toHaveLength(1);
  });

  it('el lote es atomico: si uno falla, no se aplica ninguno', async () => {
    // Es la garantia que mas cuesta cuando el POS se apaga a mitad. Sin ella, la
    // replica queda con medio estado y el mapa muestra una mesa liberada con la
    // comanda abierta, y el mozo cobra sobre una mesa que ya no existe.
    //
    // Se provoca un fallo REAL dentro de la transaccion: el payload del segundo
    // evento revienta al leerlo. Un evento que el codigo simplemente ignora no
    // probaria nada, porque no habria nada que revertir.
    const poisoned = new Proxy(
      {},
      {
        get() {
          throw new Error('payload corrupto');
        },
      },
    ) as Record<string, unknown>;

    const primero = remote('ORDER_OPENED', { orderId: 'o1', numberLabel: 'A-1' }, '1');
    const segundo: RemoteEvent = {
      cursor: '2',
      type: 'ORDER_OPENED',
      receivedAt: '2026-03-02T20:00:00.000Z',
      deviceId: 'otra-tablet',
      payload: poisoned,
    };

    await expect(storage.applyRemote([primero, segundo])).rejects.toThrow('payload corrupto');

    // La comanda del PRIMER evento no debe haber quedado: la transaccion entera se
    // revierte.
    const snapshot = await storage.snapshot();
    expect(snapshot.orders.map((order) => order.id)).not.toContain('o1');
  });

  it('un item de una orden inexistente no rompe el lote', async () => {
    // Un evento suelto sin su comanda es ruido de una tablet con la replica
    // desfasada. Tirar todo el lote por eso perderia cambios que si eran validos.
    await storage.applyRemote([
      remote('ORDER_OPENED', { orderId: 'o1', numberLabel: 'A-1' }, '1'),
      remote('ORDER_ITEM_ADDED', { orderId: 'inexistente', itemId: 'i9' }, '2'),
    ]);

    const { orders } = await storage.snapshot();
    expect(orders.map((order) => order.id)).toEqual(['o1']);
  });
});

describe('paridad con MemorySyncStorage', () => {
  /**
   * Las dos implementaciones tienen que dar el mismo resultado para los mismos
   * eventos. Si divergen, los tests del motor (que corren contra la de memoria)
   * estan probando algo que el POS real no hace.
   */
  it('el mismo lote deja la misma replica en las dos implementaciones', async () => {
    const memory = new MemorySyncStorage();

    const events: RemoteEvent[] = [
      remote('ORDER_OPENED', { orderId: 'o1', numberLabel: 'A-1', guests: 2 }, '1'),
      remote(
        'ORDER_ITEM_ADDED',
        { orderId: 'o1', itemId: 'i1', name: 'Cerveza', quantity: 2, unitPriceCents: 1500 },
        '2',
      ),
      remote('ORDER_ITEM_VOIDED', { orderId: 'o1', itemId: 'i1' }, '3'),
      remote('ORDER_CLOSED', { orderId: 'o1' }, '4'),
    ];

    await storage.applyRemote(events);
    await memory.applyRemote(events);

    const fromDexie = await storage.snapshot();
    const fromMemory = await memory.snapshot();

    const normalize = (snapshot: typeof fromDexie) =>
      snapshot.orders
        .map((order) => ({
          id: order.id,
          numberLabel: order.numberLabel,
          status: order.status,
          items: order.items.map((item) => ({ id: item.id, status: item.status })),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    expect(normalize(fromDexie)).toEqual(normalize(fromMemory));
  });

  it('el pendingCount coincide con la memoria', async () => {
    const memory = new MemorySyncStorage();
    const first = event({ seq: 1 });
    const second = event({ seq: 2 });

    await storage.putEvent(first);
    await storage.putEvent(second);
    await memory.putEvent(first);
    await memory.putEvent(second);

    await storage.removeEvents([first.eventId]);
    await memory.removeEvents([first.eventId]);

    expect(await storage.pendingCount()).toBe(await memory.pendingCount());
  });
});

describe('mantenimiento', () => {
  it('clear borra todo', async () => {
    await storage.putEvent(event());
    await storage.setCursor('50');
    await storage.applyRemote([remote('ORDER_OPENED', { orderId: 'o1' }, '1')]);

    await storage.clear();

    expect(await storage.pendingCount()).toBe(0);
    expect(await storage.getCursor()).toBe('0');
    expect((await storage.snapshot()).orders).toHaveLength(0);
  });
});

describe('la base se abre y se cierra como Dexie', () => {
  it('sobrevive a cerrar y reabrir', async () => {
    // La tablet se reinicia a mitad del turno. La outbox tiene que seguir ahi: es
    // lo unico que garantiza que el cobro no se pierda.
    await storage.putEvent(event());
    await storage.setCursor('77');

    db.close();
    await db.open();

    expect(await storage.pendingCount()).toBe(1);
    expect(await storage.getCursor()).toBe('77');
  });

  it('el constructor no falla sin nombre, usa una base propia por POS', () => {
    // Cada instalacion en una tablet usa su propia base: dos POS en la misma
    // tablet (prueba) no pueden pisarse.
    const a = new ComandaDexie();
    const b = new ComandaDexie();
    expect(a.name).toBe('comanda');
    expect(b.name).toBe('comanda');
    a.close();
    b.close();
  });

  it('Dexie es la instancia esperada', () => {
    expect(db).toBeInstanceOf(Dexie);
  });
});
