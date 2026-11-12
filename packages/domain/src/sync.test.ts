import { describe, expect, it } from 'vitest';
import {
  CLIENT_PRODUCED_EVENT_TYPES,
  MONEY_EVENT_TYPES,
  REASON_REQUIRED_EVENT_TYPES,
  SERVER_ONLY_EVENT_TYPES,
  SYNC_ACTIONS,
  SYNC_EVENT_STATUSES,
  SYNC_EVENT_TYPES,
  SyncEventTypeSchema,
} from './sync';

/**
 * El catalogo de eventos esta escrito en tres lugares y tienen que coincidir:
 * esta lista, la constraint de `sync_events.type` y lo que el POS y la API
 * importan. Si divergen, el sintoma es un `REJECTED` con un mensaje que no
 * explica nada en un local a las dos de la mañana, y no hay forma de debugearlo
 * desde el POS.
 *
 * Estos tests son la red que avisa de la divergencia **antes** del deploy.
 */

/**
 * Los tipos que acepta la constraint `sync_events_type_valid`.
 *
 * El estado actual es el de la migracion `0005_sync_eventos_de_servidor.sql`,
 * que sumo los dos eventos que emite el servidor. Copiada a proposito: si se
 * cambia la constraint, este test falla y obliga a actualizar la lista de ahi, en
 * vez de dejar que el primer push en produccion choque con un check.
 */
const DB_CONSTRAINT_TYPES = [
  'ORDER_OPENED',
  'ORDER_ITEM_ADDED',
  'ORDER_ITEM_VOIDED',
  'ORDER_NOTE_SET',
  'ORDER_CLOSED',
  'ORDER_CANCELED',
  'ORDER_ITEM_COURSE_SET',
  'ORDER_SEAT_SET',
  'PAYMENT_RECORDED',
  'TIP_ADDED',
  'SPLIT_SAVED',
  'ORDER_CHARGES_SET',
  'SHIFT_OPENED',
  'SHIFT_CASH_MOVEMENT',
  'KDS_STATUS_SET',
  'TABLE_OPENED',
  'TABLE_ITEM_ADDED',
  'TABLE_ITEM_VOIDED',
  'TABLE_NOTE_SET',
  'TABLE_STATUS_CHANGED',
  'CATALOG_PUBLISHED',
] as const;

describe('catalogo de eventos de sincronizacion', () => {
  it('la lista del dominio tiene los mismos tipos que la constraint de la base', () => {
    const fromDomain = new Set<string>(SYNC_EVENT_TYPES);
    const fromDb = new Set<string>(DB_CONSTRAINT_TYPES);

    const missingInDomain = [...fromDb].filter((type) => !fromDomain.has(type));
    const missingInDb = [...fromDomain].filter((type) => !fromDb.has(type));

    expect({ missingInDomain, missingInDb }).toEqual({ missingInDomain: [], missingInDb: [] });
  });

  it('no hay tipos repetidos', () => {
    // Un repetido no rompe nada en JS, pero hace que un `find` por tipo encuentre
    // el equivocado sin avisar.
    expect(new Set(SYNC_EVENT_TYPES).size).toBe(SYNC_EVENT_TYPES.length);
  });

  it('todo tipo del catalogo pasa el schema de Zod', () => {
    for (const type of SYNC_EVENT_TYPES) {
      expect(SyncEventTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('un tipo desconocido no pasa el schema', () => {
    expect(SyncEventTypeSchema.safeParse('ORDER_INVENTADO').success).toBe(false);
  });
});

describe('eventos que produce el POS', () => {
  it('un POS no puede encolar los eventos que son del servidor', () => {
    // `TABLE_STATUS_CHANGED` y `CATALOG_PUBLISHED` los decide el servidor. Un POS
    // que los encole esta affirmando una mesa ocupada que el servidor no confirmo.
    for (const type of SERVER_ONLY_EVENT_TYPES) {
      expect(CLIENT_PRODUCED_EVENT_TYPES).not.toContain(type);
    }
  });

  it('todo evento del servidor es de tipo servidor', () => {
    for (const type of SERVER_ONLY_EVENT_TYPES) {
      expect(SYNC_EVENT_TYPES).toContain(type);
    }
  });
});

describe('subconjuntos', () => {
  it('los eventos que tocan dinero son eventos validos', () => {
    for (const type of MONEY_EVENT_TYPES) {
      expect(SYNC_EVENT_TYPES).toContain(type);
    }
  });

  it('los eventos que exigen motivo son eventos validos', () => {
    for (const type of REASON_REQUIRED_EVENT_TYPES) {
      expect(SYNC_EVENT_TYPES).toContain(type);
    }
  });

  it('anular un item exige motivo, porque el motivo es el dato', () => {
    // Sin motivo no hay forma de responder "por que se descontó esto", y el
    // arqueo de anulaciones queda sin explicar.
    expect(REASON_REQUIRED_EVENT_TYPES).toContain('ORDER_ITEM_VOIDED');
  });
});

describe('estados y acciones', () => {
  it('los cuatro estados de resultado son los que el POS sabe manejar', () => {
    expect(SYNC_EVENT_STATUSES).toEqual(['APPLIED', 'DUPLICATE', 'REJECTED', 'CONFLICT']);
  });

  it('DUPLICATE es un estado de exito, no un error', () => {
    // Es lo que permite reenviar la cola entera tras un corte de red: el
    // servidor responde DUPLICATE y el evento sale de la cola igual.
    expect(SYNC_EVENT_STATUSES).toContain('DUPLICATE');
    expect(SYNC_EVENT_STATUSES).not.toContain('FAILED');
  });

  it('las acciones que el POS puede recibir son las tres del protocolo', () => {
    expect(SYNC_ACTIONS).toEqual(['REASSIGN_TABLE', 'DISCARD', 'NONE']);
  });
});
