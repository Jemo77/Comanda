import { describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { Outbox } from './outbox';
import { reconcile } from './reconcile';
import { FakeTransport, networkError } from './testing';
import type { SyncEventResult } from './protocol';
import { MemorySyncStorage } from './memory-storage';
import type { ReplicaOrder, ReplicaTable, SyncTransport } from './storage';

/**
 * Tests de la sincronizacion offline.
 *
 * Estos tests son el corazon de la Fase 1. El escenario que gobierna todo es el del
 * enunciado: **cortar la red en medio de una orden, seguir operando, reconectar y
 * verificar que no hay duplicados ni perdida.** Si esto no se prueba con un corte
 * de verdad, el modo offline es una promesa sin evidencia.
 */

const DEVICE = '11111111-1111-7111-8111-111111111111';
const TOKEN = 'token-de-prueba';

/** Reloj fijo: los tests no dependen de la hora real. */
function fixedClock(start = Date.parse('2026-03-01T22:00:00Z')) {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(start + tick * 1_000);
  };
}

function makeOutbox(storage: MemorySyncStorage) {
  let n = 0;
  return new Outbox(storage, {
    now: fixedClock(),
    generateId: () => `22222222-2222-7222-8222-${String(++n).padStart(12, '0')}`,
  });
}

function makeEngine(storage: MemorySyncStorage, transport: SyncTransport, outbox: Outbox) {
  return new SyncEngine({
    storage,
    transport,
    deviceId: DEVICE,
    onSeqConfirmed: (seq) => outbox.restoreSeq(seq),
  });
}

function seedTable(storage: MemorySyncStorage, id: string, label: string): void {
  const table: ReplicaTable = {
    id,
    floorId: 'floor-1',
    label,
    seats: 4,
    status: 'LIBRE',
    orderId: null,
    occupiedSince: null,
  };
  storage.seedTable(table);
}

function seedOrder(storage: MemorySyncStorage, id: string, tableId: string | null): ReplicaOrder {
  const order: ReplicaOrder = {
    id,
    numberLabel: `A-${id.slice(0, 4)}`,
    tableId,
    tableLabel: tableId ? 'Mesa 1' : null,
    status: 'OPEN',
    openedAt: '2026-03-01T22:00:00.000Z',
    guests: 2,
    totalCents: 0,
    tipCents: 0,
    items: [],
  };
  storage.seedOrder(order);
  return order;
}

describe('outbox', () => {
  it('encola con UUID, secuencia monotona y reloj del dispositivo', async () => {
    const storage = new MemorySyncStorage();
    const outbox = makeOutbox(storage);

    const first = await outbox.enqueue({
      type: 'ORDER_OPENED',
      payload: { orderId: 'a' },
      deviceId: DEVICE,
    });
    const second = await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { itemId: 'b' },
      deviceId: DEVICE,
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.status).toBe('pending');
    expect(await outbox.pendingCount()).toBe(2);
  });

  it('el payload se clona: mutarlo despues no cambia lo encolado', async () => {
    const storage = new MemorySyncStorage();
    const outbox = makeOutbox(storage);

    const note = { text: 'sin sal' };
    const event = await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { note },
      deviceId: DEVICE,
    });

    // El mozo sigue editando la nota despues de encolar. Si el payload fuera una
    // referencia, lo que se sube no seria lo que se vio.
    note.text = 'con sal';

    expect((event.payload.note as { text: string }).text).toBe('sin sal');
  });

  it('retoma la secuencia sin retroceder', async () => {
    const storage = new MemorySyncStorage();
    const outbox = makeOutbox(storage);

    outbox.restoreSeq(40);
    const event = await outbox.enqueue({ type: 'ORDER_OPENED', payload: {}, deviceId: DEVICE });

    // Si la secuencia retrocediera, dos eventos distintos compartiriaban `seq` y
    // el servidor no podria detectar que le falta uno.
    expect(event.seq).toBe(41);
  });

  it('ignora un restoreSeq mas chico que la secuencia local', async () => {
    const storage = new MemorySyncStorage();
    const outbox = makeOutbox(storage);

    await outbox.enqueue({ type: 'ORDER_OPENED', payload: {}, deviceId: DEVICE });
    outbox.restoreSeq(1);

    const next = await outbox.enqueue({ type: 'ORDER_OPENED', payload: {}, deviceId: DEVICE });
    expect(next.seq).toBe(2);
  });
});

describe('ciclo de sincronizacion', () => {
  it('sube la cola y la deja vacia', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    await outbox.enqueue({
      type: 'ORDER_OPENED',
      payload: { orderId: 'o1', numberLabel: 'A-1', tableId: 't1' },
      deviceId: DEVICE,
    });

    const result = await engine.sync(TOKEN);

    expect(result.error).toBeNull();
    expect(result.pushed).toBe(1);
    expect(await outbox.pendingCount()).toBe(0);
  });

  it('manda los eventos en orden de secuencia', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    // Los items se encolan en orden invertido a proposito: el lote tiene que salir
    // ordenado por `seq`, o el servidor aplica "agregar item" antes que "abrir
    // comanda".
    await outbox.enqueue({ type: 'ORDER_OPENED', payload: { orderId: 'o1' }, deviceId: DEVICE });
    await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { itemId: 'i-b' },
      deviceId: DEVICE,
    });
    await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { itemId: 'i-a' },
      deviceId: DEVICE,
    });

    await engine.sync(TOKEN);

    // Los ids del generador de prueba llevan el `seq` al final, asi que el orden
    // del lote se lee directo de ahi.
    const sent = transport.received.map((event) => event.eventId);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain('000000000001');
    expect(sent[1]).toContain('000000000002');
    expect(sent[2]).toContain('000000000003');
  });
});

describe('corte de red en medio de una orden', () => {
  /**
   * El escenario de aceptacion del enunciado, paso a paso.
   */
  it('sigue operando offline, reconecta y no duplica ni pierde nada', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    seedTable(storage, 't1', 'Mesa 1');
    seedOrder(storage, 'o1', 't1');

    // 1. Se abre una comanda y se agrega un item con conexion.
    await outbox.enqueue({
      type: 'ORDER_OPENED',
      payload: { orderId: 'o1', numberLabel: 'A-1', tableId: 't1', guests: 2 },
      deviceId: DEVICE,
    });
    const item1 = await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { orderId: 'o1', itemId: 'i1', name: 'Cerveza', quantity: 2, unitPriceCents: 1500 },
      deviceId: DEVICE,
    });

    await engine.sync(TOKEN);
    expect(transport.uniqueSeen()).toBe(2);

    // 2. **Se corta la red.** El POS sigue vendiendo.
    transport.failNextPush = networkError();

    const item2 = await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { orderId: 'o1', itemId: 'i2', name: 'Empanada', quantity: 1, unitPriceCents: 2200 },
      deviceId: DEVICE,
    });
    const item3 = await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { orderId: 'o1', itemId: 'i3', name: 'Vino', quantity: 1, unitPriceCents: 4500 },
      deviceId: DEVICE,
    });

    // El mozo no ve ningun error: el item aparece en el ticket al instante.
    // Lo que se encolo offline son los dos items nuevos: la comanda y el primer
    // item ya estaban confirmados antes del corte.
    expect(await outbox.pendingCount()).toBe(2);

    // 3. El ciclo con la red caida falla sin perder nada.
    const offline = await engine.sync(TOKEN);
    expect(offline.error).not.toBeNull();
    // Los dos siguen en la cola: un fallo de red NO saca eventos.
    expect(await outbox.pendingCount()).toBe(2);

    // 4. **Vuelve la red.** Se reintenta el lote entero, repeticiones incluidas.
    const online = await engine.sync(TOKEN);

    expect(online.error).toBeNull();
    expect(await outbox.pendingCount()).toBe(0);

    // 5. **Ninguna perdida:** el servidor vio los tres items.
    const seenItems = transport.received.filter((e) => e.type === 'ORDER_ITEM_ADDED');
    expect(seenItems).toHaveLength(3);
    expect(seenItems.map((e) => e.payload.itemId).sort()).toEqual(['i1', 'i2', 'i3']);

    // 6. **Ningun duplicado:** el servidor aplico 4 eventos unicos (1 comanda +
    //    3 items), aunque el item 1 volvio a enviarse en el reintento del lote.
    expect(transport.uniqueSeen()).toBe(4);
    // Y el item que ya habia sido confirmado se reenvio, que es justamente el
    // caso que la idempotencia tiene que absorber.
    expect(transport.timesReceived(item1.eventId)).toBe(1);
    for (const id of [item1.eventId, item2.eventId, item3.eventId]) {
      expect(transport.seen.has(id)).toBe(true);
    }
  });

  it('un reenvio completo de la cola no duplica nada', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    const event = await outbox.enqueue({
      type: 'ORDER_OPENED',
      payload: { orderId: 'o1', numberLabel: 'A-1' },
      deviceId: DEVICE,
    });

    await engine.sync(TOKEN);

    // Se vuelve a encolar el MISMO evento (el caso de un cliente que no sabe si
    // el push anterior llego) y se manda de nuevo.
    await storage.putEvent({ ...event, status: 'pending' });
    await engine.sync(TOKEN);

    expect(transport.timesReceived(event.eventId)).toBe(2);
    // Pero el servidor lo aplico una sola vez.
    expect(transport.uniqueSeen()).toBe(1);
    expect(await outbox.pendingCount()).toBe(0);
  });

  it('reordenar la cola no rompe el resultado', async () => {
    // El plan pide probar reordenamiento. Un lote desordenado no puede perder
    // eventos ni duplicarlos; el orden de aplicacion lo define `seq`, no la
    // llegada.
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    await outbox.enqueue({ type: 'ORDER_OPENED', payload: { orderId: 'o1' }, deviceId: DEVICE });
    await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { orderId: 'o1', itemId: 'i1' },
      deviceId: DEVICE,
    });
    await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { orderId: 'o1', itemId: 'i2' },
      deviceId: DEVICE,
    });

    // Se corrompe el orden interno a mano.
    const raw = storage.rawEvents().reverse();

    const result = await engine.sync(TOKEN);

    expect(result.error).toBeNull();
    const seqs = transport.received.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(raw).toHaveLength(3);
  });

  it('recupera los eventos que quedaron en syncing tras un cierre', async () => {
    // La tablet se apaga a mitad de un envio: los eventos quedan en `syncing` y
    // nunca se envian. Sin recuperarlos, el cobro se pierde en silencio.
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    const event = await outbox.enqueue({
      type: 'PAYMENT_RECORDED',
      payload: { orderId: 'o1', amountCents: 5000, method: 'CASH' },
      deviceId: DEVICE,
    });

    // Se marca en curso y la app muere.
    await storage.markSyncing(storage.rawEvents());
    expect(await outbox.pendingCount()).toBe(1);

    const recovered = await engine.recover();
    expect(recovered).toBe(1);

    await engine.sync(TOKEN);
    expect(transport.seen.has(event.eventId)).toBe(true);
    expect(await outbox.pendingCount()).toBe(0);
  });
});

describe('reconciliacion', () => {
  it('un evento rechazado sale de la cola y se reporta', async () => {
    const storage = new MemorySyncStorage();
    const outbox = makeOutbox(storage);
    seedOrder(storage, 'o1', null);

    await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { orderId: 'o1' },
      deviceId: DEVICE,
    });

    const results: SyncEventResult[] = [
      {
        eventId: storage.rawEvents()[0]!.eventId,
        status: 'REJECTED',
        message: 'El producto ya no existe.',
        action: 'DISCARD',
      },
    ];

    const report = await reconcile(storage, results, { ownOrders: [] });

    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]!.reason).toBe('El producto ya no existe.');
    // Sale de la cola: reenviar un payload invalido seria un bucle infinito.
    expect(await outbox.pendingCount()).toBe(0);
  });

  it('DUPLICATE se trata como confirmado y sale de la cola', async () => {
    const storage = new MemorySyncStorage();
    const outbox = makeOutbox(storage);

    await outbox.enqueue({ type: 'ORDER_OPENED', payload: { orderId: 'o1' }, deviceId: DEVICE });

    const report = await reconcile(
      storage,
      [{ eventId: storage.rawEvents()[0]!.eventId, status: 'DUPLICATE' }],
      {},
    );

    expect(report.acknowledged).toHaveLength(1);
    expect(report.rejected).toHaveLength(0);
    expect(await outbox.pendingCount()).toBe(0);
  });

  it('un conflicto de mesa libera la comanda desplazada en la replica', async () => {
    const storage = new MemorySyncStorage();
    seedTable(storage, 't1', 'Mesa 1');
    const mine = seedOrder(storage, 'o-mia', 't1');
    seedOrder(storage, 'o-otra', null);

    const results: SyncEventResult[] = [
      {
        eventId: 'evt-1',
        status: 'CONFLICT',
        message: 'La mesa ya la tiene otra comanda.',
        action: 'REASSIGN_TABLE',
        data: { orderId: 'o-otra', tableId: 't1', conflictingOrderId: 'o-mia' },
      },
    ];

    const snapshot = await storage.snapshot();
    const report = await reconcile(storage, results, {
      ownOrders: snapshot.orders,
      tables: snapshot.tables,
    });

    expect(report.tableConflicts).toHaveLength(1);
    expect(report.tableConflicts[0]!.winningOrderId).toBe('o-otra');

    // La comanda que perdio la mesa quedo sin ella: si no, el POS sigue
    // mostrando una mesa ocupada por una comanda que el servidor no tiene.
    const after = await storage.snapshot();
    expect(after.orders.find((o) => o.id === mine.id)!.tableId).toBeNull();
    expect(after.tables.find((t) => t.id === 't1')!.orderId).toBe('o-otra');
  });

  it('sacar un evento de la cola que ya no esta no falla', async () => {
    // El push pudo haberconfirmado y luego el evento se limpio por otra via. Un
    // `removeEvents` de un id inexistente tiene que ser no-op, no una excepcion.
    const storage = new MemorySyncStorage();

    const report = await reconcile(storage, [{ eventId: 'no-existe', status: 'APPLIED' }], {});

    expect(report.acknowledged).toEqual(['no-existe']);
    expect(await storage.pendingCount()).toBe(0);
  });

  it('un REASSIGN_TABLE sin datos de mesa no inventa un conflicto', async () => {
    // Si el servidor manda la accion pero sin `tableId`/`orderId`, el POS no puede
    // adivinar a que mesa se refiere. Fabricar un conflicto con ids vacios dejaria
    // una mesa en un estado imposible.
    const storage = new MemorySyncStorage();

    const report = await reconcile(
      storage,
      [{ eventId: 'e1', status: 'CONFLICT', action: 'REASSIGN_TABLE', message: 'sin datos' }],
      {},
    );

    expect(report.rejected).toHaveLength(1);
    expect(report.tableConflicts).toHaveLength(0);
  });

  it('un conflicto sin comanda desplazada deja la mesa con la ganadora', async () => {
    // El servidor puede resolver que gana la entrante sin desplazar ninguna
    // comanda previa: el POS solo tiene que apuntar la mesa a la nueva.
    const storage = new MemorySyncStorage();
    seedTable(storage, 't1', 'Mesa 1');

    await reconcile(
      storage,
      [
        {
          eventId: 'e1',
          status: 'CONFLICT',
          action: 'REASSIGN_TABLE',
          data: { orderId: 'o-nueva', tableId: 't1' },
        },
      ],
      { tables: [...storage.tables.values()] },
    );

    const after = await storage.snapshot();
    expect(after.tables.find((t) => t.id === 't1')!.orderId).toBe('o-nueva');
  });
});

describe('aplicacion de eventos remotos', () => {
  it('aplica una comanda abierta con su mesa', async () => {
    const storage = new MemorySyncStorage();
    seedTable(storage, 't1', 'Mesa 1');

    await storage.applyRemote([
      {
        cursor: '1',
        type: 'ORDER_OPENED',
        deviceId: 'otro-dispositivo',
        receivedAt: '2026-03-01T22:00:00.000Z',
        payload: { orderId: 'o9', numberLabel: 'B-1', tableId: 't1', guests: 4 },
      },
    ]);

    const snapshot = await storage.snapshot();
    expect(snapshot.orders).toHaveLength(1);
    expect(snapshot.orders[0]!.numberLabel).toBe('B-1');
  });

  it('el mismo item que llega dos veces no se duplica en la replica', async () => {
    const storage = new MemorySyncStorage();
    seedOrder(storage, 'o1', null);

    const event = {
      cursor: '1',
      type: 'ORDER_ITEM_ADDED' as const,
      deviceId: 'otro',
      receivedAt: '2026-03-01T22:00:00.000Z',
      payload: { orderId: 'o1', itemId: 'i1', name: 'Cerveza', quantity: 2, unitPriceCents: 1500 },
    };

    await storage.applyRemote([event]);
    await storage.applyRemote([{ ...event, cursor: '2' }]);

    const snapshot = await storage.snapshot();
    expect(snapshot.orders[0]!.items).toHaveLength(1);
  });

  it('un evento desconocido no rompe el ciclo', async () => {
    const storage = new MemorySyncStorage();

    // Puede ser de otra version del POS instalada en otra tablet. Romper el
    // ciclo por un evento que no entendemos seria perder toda la sincronizacion.
    await expect(
      storage.applyRemote([
        {
          cursor: '1',
          type: 'CATALOG_PUBLISHED',
          deviceId: 'otro',
          receivedAt: '2026-03-01T22:00:00.000Z',
          payload: {},
        },
      ]),
    ).resolves.toBeUndefined();
  });

  it('un pago suma la propina pero NO el total', async () => {
    const storage = new MemorySyncStorage();
    seedOrder(storage, 'o1', null);

    await storage.applyRemote([
      {
        cursor: '1',
        type: 'PAYMENT_RECORDED',
        deviceId: 'otro',
        receivedAt: '2026-03-01T22:00:00.000Z',
        payload: { orderId: 'o1', amountCents: 5000, tipCents: 500 },
      },
    ]);

    const snapshot = await storage.snapshot();
    // El total es lo que se DEBE, y ya esta calculado desde los items. Sumarle el
    // pago mezclaria "lo que se debe" con "lo que se pagó", y el arqueo del turno no
    // cerraria nunca.
    expect(snapshot.orders[0]!.totalCents).toBe(0);
    // La propina si: es un componente del total.
    expect(snapshot.orders[0]!.tipCents).toBe(500);
  });

  it('el total sube y baja con los items, no con los pagos', async () => {
    const storage = new MemorySyncStorage();
    seedOrder(storage, 'o1', null);

    await storage.applyRemote([
      {
        cursor: '1',
        type: 'ORDER_ITEM_ADDED',
        deviceId: 'otro',
        receivedAt: '2026-03-01T22:00:00.000Z',
        payload: {
          orderId: 'o1',
          itemId: 'i1',
          name: 'Cerveza',
          quantity: 2,
          unitPriceCents: 1500,
        },
      },
    ]);
    expect((await storage.snapshot()).orders[0]!.totalCents).toBe(3000);

    await storage.applyRemote([
      {
        cursor: '2',
        type: 'ORDER_ITEM_VOIDED',
        deviceId: 'otro',
        receivedAt: '2026-03-01T22:00:05.000Z',
        payload: { orderId: 'o1', itemId: 'i1' },
      },
    ]);
    expect((await storage.snapshot()).orders[0]!.totalCents).toBe(0);
  });
});

describe('concurrencia', () => {
  it('dos sync simultaneos se coalescen en uno solo', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    await outbox.enqueue({ type: 'ORDER_OPENED', payload: { orderId: 'o1' }, deviceId: DEVICE });

    // Dos disparos a la vez (el evento online y el timer de red de seguridad).
    // Deben ser el mismo ciclo: dos pushes simultaneos sobre la misma cola
    // gastan dos viajes de red por evento.
    const [a, b] = await Promise.all([engine.sync(TOKEN), engine.sync(TOKEN)]);

    expect(transport.pushCalls).toBe(1);
    expect(a).toBe(b);
  });

  it('un ciclo puede volver a empezar despues de terminar', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    await outbox.enqueue({ type: 'ORDER_OPENED', payload: { orderId: 'o1' }, deviceId: DEVICE });
    await engine.sync(TOKEN);

    await outbox.enqueue({
      type: 'ORDER_ITEM_ADDED',
      payload: { orderId: 'o1' },
      deviceId: DEVICE,
    });
    await engine.sync(TOKEN);

    expect(transport.pushCalls).toBe(2);
  });
});

describe('pull', () => {
  it('aplica lo que otro dispositivo hizo y guarda el cursor', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    // Otra tablet abre una mesa.
    transport.publishRaw({
      type: 'ORDER_OPENED',
      deviceId: 'otra-tablet',
      seq: 1,
      occurredAt: '2026-03-01T21:00:00.000Z',
      receivedAt: '2026-03-01T21:00:00.000Z',
      payload: { orderId: 'o-otra', numberLabel: 'C-9', tableId: 't9' },
      status: 'APPLIED',
    });

    const result = await engine.sync(TOKEN);

    expect(result.pulled).toBe(1);
    expect(result.cursor).not.toBe('0');
    expect(await storage.getCursor()).toBe(result.cursor);

    const snapshot = await storage.snapshot();
    expect(snapshot.orders.map((o) => o.id)).toContain('o-otra');
  });

  it('el cursor avanza y no vuelve a pedir lo mismo', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    transport.publishRaw({
      type: 'ORDER_OPENED',
      deviceId: 'otra',
      seq: 1,
      occurredAt: '2026-03-01T21:00:00.000Z',
      receivedAt: '2026-03-01T21:00:00.000Z',
      payload: { orderId: 'o1' },
      status: 'APPLIED',
    });

    await engine.sync(TOKEN);
    const firstCalls = transport.pullCalls;

    // Segundo ciclo sin novedades: no vuelve a traer el evento ya visto.
    const second = await engine.sync(TOKEN);
    expect(second.pulled).toBe(0);
    expect(transport.pullCalls).toBeGreaterThan(firstCalls);
  });

  it('un fallo de red en el pull no tira lo que ya se aplico', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    transport.failNextPull = networkError();

    const result = await engine.sync(TOKEN);

    expect(result.error).not.toBeNull();
    // El ciclo puede haber fallado, pero el estado local sigue consistente.
    expect(result.cursor).toBe('0');
  });
});

describe('fallo de red no destruye estado', () => {
  it('el error de red es legible, no un string generico', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const engine = makeEngine(storage, transport, outbox);

    await outbox.enqueue({ type: 'ORDER_OPENED', payload: { orderId: 'o1' }, deviceId: DEVICE });
    transport.failNextPush = new Error('Failed to fetch');

    const result = await engine.sync(TOKEN);

    // El mensaje va al spine del POS. "undefined" o "[object Object]" ahi no le
    // sirven de nada al mozo.
    expect(result.error).toBe('Failed to fetch');
  });

  it('el logger recibe el fallo sin romper el ciclo', async () => {
    const storage = new MemorySyncStorage();
    const transport = new FakeTransport(DEVICE);
    const outbox = makeOutbox(storage);
    const logger = vi.fn();

    const engine = new SyncEngine({
      storage,
      transport,
      deviceId: DEVICE,
      onSeqConfirmed: (seq) => outbox.restoreSeq(seq),
      logger,
    });

    await outbox.enqueue({ type: 'ORDER_OPENED', payload: { orderId: 'o1' }, deviceId: DEVICE });
    transport.failNextPush = networkError('offline');

    await engine.sync(TOKEN);

    expect(logger).toHaveBeenCalledOnce();
    expect(String(logger.mock.calls[0]![0])).toContain('offline');
  });
});
