import { create } from 'zustand';
import type { SessionUser } from '@comanda/domain';
import { clearReplica, db, type LocalDevice } from '../data/db';
import { pendingCount } from '../data/sync';
import { setAccessToken } from '../data/token';

/**
 * Sesion del POS.
 *
 * Zustand y no un context: el estado de sesion lo leen el spine, el ticket y el
 * bloque de cuenta, que son arboles distintos. Con context habria que pasar props
 * por tres niveles para que el boton de cobrar sepa si puede cobrar.
 *
 * El POS guarda el access token en memoria y el refresh en IndexedDB. En memoria y
 * no en `localStorage`: un token en `localStorage` queda exposed a cualquier XSS, y
 * en el POS el costo de un robo de sesion es acceso a la caja.
 */

interface SessionState {
  user: SessionUser | null;
  accessToken: string | null;
  devices: LocalDevice[];
  selectedDeviceId: string | null;
  error: string | null;
  busy: boolean;
  /** Eventos esperando envio. Vive en el spine porque si cambia se ve ahi. */
  pendingEvents: number;
  online: boolean;

  loginWithPin: (deviceId: string, pin: string) => Promise<void>;
  selectDevice: (deviceId: string) => void;
  /** Dispositivos aprobados, leidos de la replica al abrir la app. */
  setDevices: (devices: LocalDevice[]) => void;
  logout: () => Promise<void>;
  refreshPending: () => Promise<void>;
  setOnline: (online: boolean) => void;
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export const useSession = create<SessionState>((set, get) => ({
  user: null,
  accessToken: null,
  devices: [],
  selectedDeviceId: null,
  error: null,
  busy: false,
  pendingEvents: 0,
  online: navigator.onLine,

  selectDevice: (deviceId) => set({ selectedDeviceId: deviceId, error: null }),

  // Se ordena por nombre para que la pantalla de PIN sea estable entre arranques: si
  // la lista cambia de orden cada vez que la app abre, el mozo toca el boton de otro
  // dispositivo y entra con el PIN en la tablet que no es.
  setDevices: (devices) =>
    set({ devices: [...devices].sort((a, b) => a.name.localeCompare(b.name, 'es')) }),

  setOnline: (online) => set({ online }),

  refreshPending: async () => {
    // El contador sale de la cola del motor de sync, no de la replica: la replica
    // no tiene outbox. Antes se contaba sobre `db.outbox`, que era la misma tabla
    // declarada en las dos bases; ahora cada una tiene su dueño.
    set({ pendingEvents: await pendingCount() });
  },

  loginWithPin: async (deviceId, pin) => {
    set({ busy: true, error: null });
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'pin', deviceId, pin }),
      });

      if (!response.ok) {
        const problem = await safeProblem(response);
        set({ busy: false, error: problem.detail });
        return;
      }

      const body = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
        user: SessionUser;
      };

      // El refresh token se persiste: sin el, cerrar la app pierde la sesion y el
      // mozo tiene que volver a pedirle el PIN al encargado. Va en su propia tabla,
      // no en la outbox de sync: mezclar un token de sesion con los eventos de venta
      // hace que vaciar la cola borre la sesion.
      await db.refreshTokens.put({ userId: body.user.id, token: body.refreshToken });

      // El token tambien va a la variable del modulo: el transporte de sync lo lee
      // de ahi sin depender de React.
      setAccessToken(body.accessToken);

      set({
        user: body.user,
        accessToken: body.accessToken,
        busy: false,
        error: null,
      });
    } catch (error) {
      set({
        busy: false,
        error: navigator.onLine
          ? 'No pudimos conectarnos con el servidor.'
          : 'Sin conexión. El POS sigue operando: los cambios se guardan y se suben después.',
      });
      void error;
    }
  },

  logout: async () => {
    const { accessToken } = get();
    if (accessToken) {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => undefined);
    }
    // El token del modulo se limpia antes que el store, para que ningun request en
    // vuelo pueda resurrecto con un token viejo.
    setAccessToken(null);
    await clearReplica();
    set({ user: null, accessToken: null, pendingEvents: 0, error: null });
  },
}));

/**
 * Lee un problem+json.
 *
 * Si la respuesta no es problem+json (un 502 de un proxy, por ejemplo), el mensaje
 * es generico: mostrarle al mozo el HTML de un error de infraestructura lo
 * confunde y no le sirve para hacer nada.
 */
async function safeProblem(response: Response): Promise<{ detail: string }> {
  try {
    const body = await response.json();
    if (typeof body?.detail === 'string') return body;
  } catch {
    // respuesta no JSON
  }
  return { detail: 'No pudimos iniciar sesión. Probá de nuevo.' };
}
