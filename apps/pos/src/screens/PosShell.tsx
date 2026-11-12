import { useEffect, useState, type ReactElement } from 'react';
import { ConnectionBadge, Spine, SpineDivider, SpineGroup, SpineItem } from '@comanda/ui';
import { formatMoney, money } from '@comanda/domain';
import { useSession } from '../state/session';
import { useOrder, useTotals } from '../state/order';
import { TableMap } from './TableMap';
import { OrderEntry } from './OrderEntry';
import { Kitchen } from './Kitchen';
import { FloorPlan } from './FloorPlan';

/**
 * Barra de trabajo del POS.
 *
 * Reproduce el wireframe de `docs/DESIGN.md`: spine fijo a la izquierda, superficie
 * central con el rollo de comanda, bloque de cuenta a la derecha.
 *
 * **No hay scroll global.** El spine es `sticky`, las tres zonas scrollean por
 * separado, y el alto es el de la pantalla. Es la diferencia entre un mostrador y
 * una app: en un mostrador el pulgar del mozo esta siempre en el mismo lugar, y
 * una pagina que scrollea sola se lo mueve.
 *
 * Las tres zonas se montan una sola vez y se cambian por estado, no por ruta: cada
 *montaje de la comanda perderia la seleccion y el scroll del rollo, que es
 * exactamente lo que el mozo esta usando.
 */

/**
 * Las pantallas.
 *
 * `mesas`, `comanda` y `cocina` son las tres del turno: las usa el mozo, que las
 * abre y cierra cientos de veces. `plano` es la cuarta y es distinta: la usa el
 * dueño una vez, cuando arma el salon. Por eso no comparte grupo en el spine.
 */
type Section = 'mesas' | 'comanda' | 'cocina' | 'plano';

export function PosShell(): ReactElement {
  const { user, devices, selectedDeviceId, pendingEvents, online, logout } = useSession();
  const order = useOrder((state) => state.order);
  const totals = useTotals();

  const [section, setSection] = useState<Section>(order ? 'comanda' : 'mesas');
  // La moneda viene de la replica del local. ARS es el default de todos los locales
  // del mercado inicial, pero el token trae la suya y el POS tiene que formatear con
  // esa, no con una constante.
  const currency = 'ARS';

  // Cuando el mozo abre una mesa desde el mapa, la pantalla tiene que cambiar sola.
  // Si no, abre la comanda y sigue mirando el salon.
  useEffect(() => {
    if (order) setSection('comanda');
  }, [order?.id]);

  const backToMap = (): void => {
    // Cerrar la comanda es una accion del cobro, no un boton suelto: el bloque de
    // cuenta tiene el "Cobrar". Volver al mapa deja la comanda como esta.
    setSection('mesas');
  };

  return (
    <div className="flex h-screen overflow-hidden bg-enamel text-ink">
      <Spine
        className="sticky top-0"
        header={
          <div className="border-b border-tile/15 px-3 py-4">
            <p className="font-display text-sm font-bold text-tile">
              {devices.find((device) => device.id === selectedDeviceId)?.name ?? 'POS'}
            </p>
            <p className="mt-0.5 truncate font-display text-2xs text-tile/50">
              {user?.name ?? 'Sin sesion'}
            </p>
          </div>
        }
        footer={
          <div className="flex flex-col gap-3 border-t border-tile/15 px-3 py-4">
            {/*
              El estado de conexion vive en el spine, no en un badge flotante: si
              cambia, tiene que cambiar en el lugar donde el mozo ya mira. Y muestra
              cuantos eventos van esperando, que es lo que explica un total que aun
              no aparece en el servidor.
            */}
            <ConnectionBadge
              status={online ? (pendingEvents > 0 ? 'syncing' : 'online') : 'offline'}
              pendingEvents={pendingEvents}
            />
            <button
              type="button"
              onClick={() => void logout()}
              className="min-h-touch rounded-wire border border-tile/20 px-3 font-display text-sm font-semibold text-tile/85 transition-colors duration-80 hover:bg-tile/10"
            >
              Salir
            </button>
          </div>
        }
      >
        <SpineGroup>Turno</SpineGroup>
        <SpineItem label="Mesas" active={section === 'mesas'} onSelect={backToMap} />
        <SpineItem
          label="Comanda"
          active={section === 'comanda'}
          onSelect={() => setSection('comanda')}
        />
        <SpineItem
          label="Cocina"
          active={section === 'cocina'}
          onSelect={() => setSection('cocina')}
        />

        <SpineDivider />

        {/*
          La comanda abierta se announces en el spine, no solo en el bloque de
          cuenta: el mozo esta mirando el salon la mayor parte del turno y tiene que
          saber de un vistazo que hay una mesa sin cobrar.
        */}
        {order && (
          <>
            <SpineGroup>Abierta</SpineGroup>
            <button
              type="button"
              onClick={() => setSection('comanda')}
              className="flex min-h-touch w-full flex-col items-start gap-0.5 border-l-2 border-caution bg-tile/10 px-3 py-2 text-left transition-colors duration-80 hover:bg-tile/15"
            >
              <span className="font-display text-sm font-semibold text-tile">
                {order.tableLabel ? `Mesa ${order.tableLabel}` : 'Comanda'}
              </span>
              <span className="tabular font-mono text-2xs text-tile/60">
                {formatTotal(totals.totalCents, currency)}
              </span>
            </button>
          </>
        )}

        {/*
          El editor de planos va aparte, en su propio grupo, y no junto a las
          pantallas del turno. El mozo no lo usa nunca: si compartiera grupo con
          "Mesas", tarde o temprano alguien mueve una mesa a las tres de la mañana
          creyendo que esta cargando otra cosa.
        */}
        <SpineDivider />
        <SpineGroup>Local</SpineGroup>
        <SpineItem
          label="Planos"
          active={section === 'plano'}
          onSelect={() => setSection('plano')}
        />
      </Spine>

      <main className="flex min-w-0 flex-1 flex-col">
        {section === 'mesas' && <TableMap />}
        {section === 'comanda' && <OrderEntry currency={currency} />}
        {section === 'cocina' && <Kitchen />}
        {section === 'plano' && <FloorPlan />}
      </main>
    </div>
  );
}

/**
 * Importe del bloque del spine.
 *
 * Se formatea con el mismo helper del dominio que el ticket. Es el mismo numero que
 * el mozo va a cobrar: si el spine y el bloque de cuentaaran distintos, el mozo
 * deja de creer a los dos.
 */
function formatTotal(cents: number, currency: string): string {
  return formatMoney(money(cents, currency));
}
