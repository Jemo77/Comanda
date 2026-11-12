/**
 * Carga `fake-indexeddb` antes de que corra cualquier test.
 *
 * Va en `setupFiles` y no como import arriba de cada test porque Dexie busca el
 * `indexedDB` global en el momento de abrir la base. Un import en el cuerpo del
 * test se ejecuta tarde, cuando Dexie ya resolvio el global y no lo encuentra.
 */
import 'fake-indexeddb/auto';
