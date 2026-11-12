import {
  ComandaDexie,
  DexieSyncStorage,
  HttpSyncTransport,
  Outbox,
  SyncEngine,
  type SyncEventType,
} from '@comanda/sync-client';
import { getAccessToken } from './token';
import { db as catalogDb, clearReplica as clearCatalogReplica } from './db';

/**
 * Cableado del POS con el motor de sincronizacion.
 *
 * Todo el motor vive en `@comanda/sync-client`. Acá solo se instancia, porque cada
 * uno de estos objetos necesita algo que el POS conoce y el paquete no: el nombre
 * de la base, el id del dispositivo y de donde sale el token.
 *
 * Que el motor sea un paquete y no un archivo del POS no es cosmetico: los tests
 * de reconciliacion corren en Node contra `MemorySyncStorage`. Con la logica
 * adentro de la app, probarla exigiria un navegador por cada caso de corte de red,
 * y los casos de corte de red son justamente los que hay que probar mucho.
 */

/** Base local del POS. El nombre va con el origen para no chocar en pruebas. */
const database = new ComandaDexie(import.meta.env.VITE_POS_DB_NAME ?? 'comanda');

/**
 * El id del dispositivo.
 *
 * Viene de la sesion: es el mismo con el que el servidor autorizo los pushes, y
 * mandarlo por header no serviria de nada porque el servidor lo toma de la sesion.
 * Sin sesion todavia no hay dispositivo, y sin dispositivo no hay outbox.
 */
let deviceId: string | null = null;

const storage = new DexieSyncStorage(database, 'pendiente');

const transport = new HttpSyncTransport({
  baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1',
  getAccessToken,
});

let engine: SyncEngine | null = null;
let outbox: Outbox | null = null;

export interface PosSync {
  storage: DexieSyncStorage;
  outbox: Outbox;
  engine: SyncEngine;
  /** Dispositivo emisor. El servidor lo toma de la sesion, no del payload. */
  deviceId: string;
}

/**
 * Prepara el motor para un dispositivo.
 *
 * Se llama al entrar con PIN. El `storage` se recrea porque lleva el `deviceId` en
 * su constructor, y un dispositivo distinto es una base de outbox distinta: si dos
 * tablets compartieran la misma cola, una sube los eventos de la otra.
 */
export function setupSync(nextDeviceId: string): PosSync {
  deviceId = nextDeviceId;

  const nextStorage = new DexieSyncStorage(database, nextDeviceId);
  const nextOutbox = new Outbox(nextStorage);

  nextEngine = new SyncEngine({
    storage: nextStorage,
    transport,
    deviceId: nextDeviceId,
    // El motor no genera ids, asi que le avisa al `Outbox` cual es la ultima
    // secuencia confirmada para que no genere una repetida al reconectar.
    onSeqConfirmed: (seq) => nextOutbox.restoreSeq(seq),
  });

  engine = nextEngine;
  outbox = nextOutbox;

  return { storage: nextStorage, outbox: nextOutbox, engine: nextEngine, deviceId: nextDeviceId };
}

let nextEngine: SyncEngine | null = null;

/**
 * El motor, o `null` si todavia no entro nadie.
 *
 * Devolver `null` y no una promesa que espera es a proposito: la UI consulta esto
 * en el render, y bloquear el render esperando un dispositivo seria pintar la
 * pantalla de "cargando" cada vez que se monta.
 */
export function getSync(): PosSync | null {
  if (!engine || !outbox || !deviceId) return null;
  return { storage, outbox, engine, deviceId };
}

/**
 * Corre un ciclo de sincronizacion, si hay sesion.
 *
 * Devuelve `null` y no un error cuando no hay dispositivo: es el estado normal
 * antes del login por PIN, no una falla.
 */
export async function syncNow(accessToken: string | null) {
  const current = getSync();
  if (!current || !accessToken) return null;

  // Lo que quedo en `syncing` por un cierre de app se repone antes de nada: si no,
  // esos eventos nunca se envian.
  await current.engine.recover();

  return current.engine.sync(accessToken);
}

/** Numero de eventos esperando envio, para el indicador del spine. */
export async function pendingCount(): Promise<number> {
  const current = getSync();
  if (!current) return 0;
  return current.outbox.pendingCount();
}

/**
 * Encola un evento del POS y **no espera** a la red.
 *
 * Es la pieza que hace que la UI sea optimista: la pantalla ya escribio en la
 * replica local, esta funcion deja el evento en IndexedDB, y el motor lo sube en
 * el proximo ciclo. El mozo no ve un spinner por agregar un capuchino.
 *
 * Devuelve una promesa porque el llamador tiene que poder esperar en los tests y
 * en un cierre de app, pero ningun llamador de pantalla la espera: en la practica
 * se descarta con `void`.
 *
 * Sin sesion devuelve `false` y no un error: todavia no entro nadie, y un rechazo
 * sin manejar seria una excepcion en la consola del mostrador cada vez que una
 * pantalla monta antes del login.
 */
export async function enqueueEvent(
  type: SyncEventType,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const current = getSync();
  if (!current) return false;

  try {
    await current.outbox.enqueue({ type, payload, deviceId: current.deviceId });
    return true;
  } catch (error) {
    // Una excepcion sin manejar en una promesa flotante es un rechazo sin ver: en
    // el mostrador, un cobro que nadie sabe que quedo sin registrar.
    console.error(`No se pudo encolar el evento ${type}`, error);
    return false;
  }
}

/**
 * Cierra la sesion y borra la replica local.
 *
 * Se borra porque la replica es del local y del usuario: dejarla haria que el
 * siguiente que entre en la tablet vea las comandas del anterior.
 */
export async function logoutAndClear(): Promise<void> {
  const current = getSync();
  engine = null;
  outbox = null;
  deviceId = null;
  nextEngine = null;

  if (current) await current.storage.clear();
  // La carta (categorias, productos) vive en otra base, del POS. Se limpia tambien:
  // es del local, no del usuario.
  await clearCatalogReplica();
}

/**
 * Replica de la carta.
 *
 * El paquete trae la de ordenes y mesas. La carta (categorias, productos,
 * modificadores) la maneja el POS porque es de solo lectura y no pasa por la
 * outbox: no hay conflicto posible sobre un precio que el dueño ya fijo.
 */
export { catalogDb, database };
