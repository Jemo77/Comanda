import { useEffect, useState, type ReactElement } from 'react';
import { PinLogin } from './screens/PinLogin';
import { PosShell } from './screens/PosShell';
import { discoverDevice } from './data/device';
import { useSession } from './state/session';
import { useSyncLifecycle } from './state/useSync';

/**
 * Raiz del POS.
 *
 * Arranca en el login por PIN y, una vez autenticado, pasa a la barra de trabajo.
 * La sincronizacion se engancha aca y en ningun otro lado: el motor tiene que vivir
 * durante toda la sesion, no depender de que una pantalla este montada.
 */
export function App(): ReactElement {
  const { user, selectDevice, setDevices, refreshPending } = useSession();
  const [ready, setReady] = useState(false);
  /** Sin autorizacion no se entra, pero el POS abre igual para poder avisar. */
  const [unregistered, setUnregistered] = useState(false);

  useSyncLifecycle();

  // El aparato se descubre al arrancar: primero por la red, y si no hay, desde la
  // replica local. Sin esto, `PinLogin` no tendria que mostrar y el mostrador no
  // podria entrar: `GET /devices` exige sesion, y no hay sesion todavia.
  useEffect(() => {
    let alive = true;

    void (async () => {
      const { device } = await discoverDevice();
      if (!alive) return;

      if (device) {
        setDevices([device]);
        selectDevice(device.id);
      } else {
        setUnregistered(true);
      }

      await refreshPending();
      if (alive) setReady(true);
    })();

    return () => {
      alive = false;
    };
  }, [selectDevice, setDevices, refreshPending]);

  if (!ready) {
    // La PWA abre siempre el shell cacheado: sin conexion tiene que pintar igual.
    return (
      <div className="flex min-h-screen items-center justify-center bg-enamel">
        <p className="text-sm text-ink-faint">Abriendo…</p>
      </div>
    );
  }

  if (unregistered) {
    return <UnregisteredNotice />;
  }

  return user ? <PosShell /> : <PinLogin />;
}

/**
 * Aviso de aparato no registrado.
 *
 * Se muestra en vez de un error porque la accion para resolverlo no la hace el mozo:
 * la hace el dueño o el encargado. Decir "no autorizado" sin decir a quien le
 * corresponde deja al mozo sin poder hacer nada.
 */
function UnregisteredNotice(): ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center bg-enamel p-6">
      <div className="w-full max-w-sm">
        <div className="caution-tape mb-5" aria-hidden />
        <h1 className="font-display text-2xl font-bold text-ink">
          Este aparato no está registrado
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Pedile al encargado o al dueño del local que registre esta tablet desde el backoffice.
          Cuando la aprueben, cerrá la app y volvé a abrirla.
        </p>
        <p className="mt-4 text-sm text-ink-faint">
          El POS sigue guardando los cambios en este aparato mientras tanto: si cargaste algo, no se
          pierde.
        </p>
      </div>
    </div>
  );
}
