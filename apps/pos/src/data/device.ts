import { db, type LocalDevice } from './db';

/**
 * Identidad del aparato y descubrimiento del local.
 *
 * El POS tiene que saber dos cosas antes de tener credenciales: cual es su huella
 * estable y si esta autorizado. Sin eso la pantalla de PIN no tiene nada que
 * mostrar y el POS no puede entrar nunca.
 *
 * La huella se genera una vez y se guarda. NO se regenera en cada arranque: es la
 * clave con la que el servidor reconoce este aparato, y si cambiara, cada reinicio
 * de la tablet seria un dispositivo nuevo esperando aprobacion.
 */

/** Llave donde vive la huella. */
const FINGERPRINT_KEY = 'comanda.fingerprint';

/**
 * Devuelve la huella de este aparato, creandola la primera vez.
 *
 * Usa `crypto.randomUUID` y no un valor derivado de la pantalla o del user agent:
 * la huella tiene que ser estable entre reinicios y distinta entre aparatos. Un
 * fingerprint derivado del user agent seria el mismo en dos tablets del mismo
 * modelo, que es justo el caso donde hace falta distinguirlas.
 */
export async function deviceFingerprint(): Promise<string> {
  const existing = localStorage.getItem(FINGERPRINT_KEY);
  if (existing) return existing;

  const fresh = crypto.randomUUID();
  localStorage.setItem(FINGERPRINT_KEY, fresh);
  return fresh;
}

/** Lo que devuelve `POST /devices/resolve`. */
export interface ResolvedDevice {
  device: { id: string; name: string; kind: string; status: string };
  venue: { id: string; name: string; kind: string };
  org: { id: string; name: string; currency: string; timezone: string };
}

/**
 * Pregunta al servidor si este aparato esta autorizado, y guarda el resultado.
 *
 * Devuelve `null` si no esta registrado o esta revocado. No lanza: un POS que no
 * esta autorizado tiene que poder **abrir igual** y mostrar el aviso, porque el
 * encargado puede estar ahi mismo registrando el aparato. Un POS que no abre por
 * un 404 deja al local sin sistema.
 */
export async function resolveDevice(): Promise<ResolvedDevice | null> {
  const fingerprint = await deviceFingerprint();

  try {
    const response = await fetch(
      `${import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1'}/devices/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint }),
      },
    );

    if (!response.ok) return null;

    const resolved = (await response.json()) as ResolvedDevice;

    // Se guarda en la replica local: al proximo arranque el POS muestra el nombre
    // del dispositivo sin volver a preguntar, incluso sin conexion.
    await db.devices.put({
      id: resolved.device.id,
      venueId: resolved.venue.id,
      name: resolved.device.name,
      kind: resolved.device.kind,
      fingerprint,
    });

    return resolved;
  } catch {
    // Sin red. Si ya hay un dispositivo en la replica, se sigue con ese: el POS
    // tiene que poder abrir sin conexion, que es el caso normal de un mostrador.
    return null;
  }
}

/**
 * Descubre el dispositivo al arrancar.
 *
 * Primero intenta la red; si no hay, usa lo que quedo en la replica local. Ese
 * orden es el que hace que un POS con internet reconozca un aparato nuevo y uno sin
 * internet abra igual con el ultimo dispositivo conocido.
 */
export async function discoverDevice(): Promise<{ device: LocalDevice | null; online: boolean }> {
  const resolved = await resolveDevice();

  if (resolved) {
    const device: LocalDevice = {
      id: resolved.device.id,
      venueId: resolved.venue.id,
      name: resolved.device.name,
      kind: resolved.device.kind,
      fingerprint: await deviceFingerprint(),
    };
    return { device, online: true };
  }

  const cached = await db.devices.toArray();
  return { device: cached[0] ?? null, online: false };
}
