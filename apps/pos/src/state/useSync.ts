import { useEffect, useRef } from 'react';
import { useSession } from './session';
import { setupSync, syncNow, logoutAndClear } from '../data/sync';
import { setAccessToken } from '../data/token';
import { getAccessToken } from '../data/token';
import { hydrateCatalog } from '../data/catalog';

/**
 * Ciclo de vida de la sincronizacion.
 *
 * Se monta una sola vez, arriba de todo, y hace tres cosas:
 *
 *  1. **Prepara el motor** cuando hay dispositivo. Sin esto no hay outbox.
 *  2. **Sincroniza al entrar**, para hidratar la replica con lo que paso mientras
 *     la app estuvo cerrada.
 *  3. **Sincroniza cada N segundos y al volver la red.** El intervalo es la red de
 *     seguridad: sin el, un POS que se quedó sin conexion treinta segundos y vuelve
 *     no se entera hasta la proxima venta.
 *
 * El intervalo es generoso a proposito (20 s). Sincronizar cada venta seria un
 * request por item en un local con fifty pedidos por minuto, y la idempotencia
 * protege de duplicados pero no de gastar la bateria ni el ancho de banda del
 * mostrador.
 */

const SYNC_INTERVAL_MS = 20_000;

export function useSyncLifecycle(): void {
  const { user, accessToken, selectedDeviceId, setOnline, refreshPending } = useSession();

  // El token vive tambien en un modulo hoja: el transporte lo lee de ahi sin
  // depender de React.
  useEffect(() => {
    setAccessToken(accessToken);
  }, [accessToken]);

  // 1. Preparar el motor cuando hay dispositivo.
  useEffect(() => {
    if (!selectedDeviceId) return;
    setupSync(selectedDeviceId);
  }, [selectedDeviceId]);

  // 2 y 3. Sincronizar al entrar y periodicamente.
  useEffect(() => {
    if (!user || !selectedDeviceId) return;

    let alive = true;

    const run = async (): Promise<void> => {
      // La carta se hidrata **antes** del push a proposito. La comanda se escribe
      // contra la carta local, asi que si el push de "abrir mesa" llegara al
      // servidor antes de que el POS sepa que la mesa existe, el servidor no tiene
      // contra que validarla. El orden de la red y el orden de la replica no son el
      // mismo, y por eso la hidratacion va primera.
      await hydrateCatalog(user.venueId).catch(() => {
        // Sin red la carta no cambia: la replica anterior sigue sirviendo y el POS
        // sigue vendiendo con ella. Un fallo de hidratacion no es motivo para
        // parar el ciclo de sincronizacion.
      });

      const result = await syncNow(getAccessToken());
      if (!alive || !result) return;
      // El contador del spine cambia aca, porque si cambia tiene que cambiar en el
      // lugar donde el mozo ya mira.
      await refreshPending();
    };

    // Al entrar: hidrata la replica con lo que paso mientras estuvo cerrada.
    void run();

    const interval = window.setInterval(() => void run(), SYNC_INTERVAL_MS);

    // Volver la conexion es el momento que mas rinde: durante el corte se acumulo
    // trabajo, y fuerarlo ahi hace que el mozo vea la replica al dia cuanto antes.
    const onOnline = (): void => {
      setOnline(true);
      void run();
    };
    const onOffline = (): void => setOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [user, selectedDeviceId, setOnline, refreshPending]);

  // 4. Al **salir de una sesion**, borrar la replica local: es del local y del
  //    usuario, y dejarla haria que el siguiente que entre en la tablet vea las
  //    comandas del anterior.
  //
  //    La condicion es "hubo sesion y ya no la hay". Antes era `user ||
  //    devices.length === 0`, que en una tablet recien instalada se cumplia siempre:
  //    `devices` esta vacio hasta que alguien siembra la replica, asi que el POS
  //    borraba su propia replica en cada arranque y nuncaesia ver nada. El
  //    sintoma era una carta que se cargaba y desaparecia sola, y que hacia
  //    pensar que la hidratacion estaba rota.
  const hadSession = useRef(false);
  useEffect(() => {
    if (user) {
      hadSession.current = true;
      return;
    }
    if (!hadSession.current) return;
    hadSession.current = false;
    void logoutAndClear();
  }, [user]);
}
