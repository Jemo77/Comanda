import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { cn } from '@comanda/ui';
import type { TableStatus } from '@comanda/domain';
import { db, type LocalFloor, type LocalFloorTable } from '../data/db';
import { EmptyState, useLiveTable } from '../data/useLiveTable';
import { useOrder } from '../state/order';

/**
 * Mapa de mesas.
 *
 * Es la pantalla de arranque del turno y la que el mozo mira de reojo mientras
 * trabaja: por eso lo unico que se actualiza solo es el temporizador de ocupacion.
 * Alguien tiene que poder ver, de un vistazo y sin tocar nada, que la mesa 5 hace
 * dos horas que esta ahi y que la 3 pidio la cuenta hace un rato.
 *
 * Minutos a partir de los cuales el mapa avisa que la mesa esta hace rato. Vive en
 * la app y no en la base porque es una politica **por local**: un bar de copas no
 * advierte a los veinte minutos lo que un restaurante de familias avisa a la hora
 * y media.
 */
const OCCUPANCY_ALERT_MINUTES = 120;

/** Cada cuanto se recalcula el temporizador. */
const TICK_MS = 15_000;

/**
 * Pixels por unidad de grilla del plano.
 *
 * El plano se dibuja a escala y este es el tope. Con 1.6, una mesa de 100x100
 * queda en 160x160 px: bastante para leer la etiqueta sin esfuerzo y bastante
 * pequena para que las seis mesas de un salon entren en una pantalla.
 *
 * El minimo real lo pone `min-h-touch` (48px), no este numero: si un local carga un
 * plano con mesas de 20 unidades, el target se agranda y el plano se ve raro, pero
 * el dedo del mozo sigue llegando.
 */
const UNIT_PX = 1.6;

/**
 * Barras de ocupacion al exceeded el umbral.
 *
 * El color de las mesas sale de los mismos tokens que los letreros de "ABIERTO" y
 * "CERRADO" del local. El mozo ya sabe leerlos: no hay que aprender un codigo de
 * color nuevo el primer dia.
 */
const STATUS_TONE: Record<TableStatus, 'open' | 'busy' | 'pending' | 'blocked' | 'muted'> = {
  LIBRE: 'open',
  OCUPADA: 'busy',
  PIDIO_CUENTA: 'pending',
  RESERVADA: 'muted',
  BLOQUEADA: 'blocked',
};

/** Texto del estado, tal como lo diria el mozo. */
const STATUS_LABEL: Record<TableStatus, string> = {
  LIBRE: 'Libre',
  OCUPADA: 'Ocupada',
  PIDIO_CUENTA: 'Pidio cuenta',
  RESERVADA: 'Reservada',
  BLOQUEADA: 'Bloqueada',
};

export function TableMap(): ReactElement {
  // Se lee vivo, no solo al montar: la carta y el plano se hidratan despues del
  // login, y con una lectura de montaje la pantalla se quedaria diciendo que el local
  // no tiene salon cargado.
  const floors = useLiveTable<LocalFloor>(
    async () => (await db.floors.toArray()).sort((a, b) => a.sort - b.sort),
    [],
  );
  const tables = useLiveTable<LocalFloorTable>(() => db.floorTables.toArray(), []);

  const [activeFloorId, setActiveFloorId] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const openTable = useOrder((state) => state.openTable);
  const activeOrder = useOrder((state) => state.order);

  // El sector activo sigue al primero que aparece: si el plano se hidrata despues del
  // primer render, sin esto la pantalla queda en el sector `null` mirando un salon
  // vacio.
  useEffect(() => {
    if (activeFloorId === null && floors.length > 0) {
      setActiveFloorId(floors[0]!.id);
    }
  }, [floors, activeFloorId]);

  // El unico temporizador de la app. Cada 15 segundos es mas que suficiente: el
  // dato que cambia es "cuantos minutos lleva", y un minuto de granularidad ya
  // esta en el redondeo del texto.
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(interval);
  }, []);

  const visible = useMemo(
    () => tables.filter((table) => table.floorId === activeFloorId),
    [tables, activeFloorId],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Mapa de mesas">
      <header className="flex items-end justify-between gap-4 border-b border-steel bg-tile px-4 py-3">
        <div>
          <h1 className="font-display text-lg font-bold tracking-tight">Salon</h1>
          <p className="text-xs text-ink-soft">
            {countSummary(tables)} · {floors.length} {floors.length === 1 ? 'sector' : 'sectores'}
          </p>
        </div>

        {/* Sectores como pestañas: son pocas y se cambian seguido. Un menu desplegable
            obliga a dos toques para lo que se resuelve de reojo. */}
        <nav aria-label="Sectores" className="flex flex-wrap gap-1">
          {floors.map((floor) => (
            <button
              key={floor.id}
              type="button"
              onClick={() => setActiveFloorId(floor.id)}
              aria-current={floor.id === activeFloorId ? 'page' : undefined}
              className={cn(
                'min-h-touch rounded-wire border px-3 font-display text-xs font-semibold',
                'transition-[background-color,border-color] duration-80',
                floor.id === activeFloorId
                  ? 'border-ink bg-ink text-tile'
                  : 'border-steel bg-tile text-ink-soft hover:border-steel-dark hover:text-ink',
              )}
            >
              {floor.name}
            </button>
          ))}
        </nav>
      </header>

      {visible.length === 0 ? (
        <EmptyFloor hasFloors={floors.length > 0} />
      ) : (
        <TableGrid
          tables={visible}
          now={now}
          activeTableId={activeOrder?.tableId ?? null}
          onPick={(table) => openTable(table.id, table.label, table.seats)}
        />
      )}
    </section>
  );
}

/**
 * Rejilla de mesas del sector, con la geometria real del plano.
 *
 * Se posiciona con coordenadas relativas en vez de una grilla CSS porque el plano
 * del local es un plano: la mesa 5 esta al lado de la 3, no en la fila 2. Con una
 * grilla, un salon con doce mesas queda con seis huecos que el mozo tiene que
 * aprender a saltarse.
 */
function TableGrid({
  tables,
  now,
  activeTableId,
  onPick,
}: {
  tables: readonly LocalFloorTable[];
  now: number;
  activeTableId: string | null;
  onPick: (table: LocalFloorTable) => void;
}): ReactElement {
  // El plano tiene unidades propias. Se pasa a porcentajes para que el mismo plano
  // se vea igual en una tablet de 8" y en la pantalla de la barra: es lo que el
  // dominio quiere cuando dice que `x/y/w/h` son unidades de grilla y no pixeles.
  const maxX = Math.max(...tables.map((t) => t.x + t.w));
  const maxY = Math.max(...tables.map((t) => t.y + t.h));

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {/*
        El contenedor respeta la **proporcion** del plano con `aspect-ratio` y se
        limita en ancho. Sin el limite, un salon de seis mesas de 100 unidades se
        estira a 1.300 px y las mesas quedan de 300 de alto: el mozo tiene que
        scrollear para ver las dos filas, y un salon se mira de un vistazo.
      */}
      <div
        className="relative mx-auto w-full"
        style={{ aspectRatio: `${maxX} / ${maxY}`, maxWidth: `${maxX * UNIT_PX}px` }}
      >
        {tables.map((table) => {
          const minutes = occupiedMinutes(table, now);
          const overdue = minutes !== null && minutes >= OCCUPANCY_ALERT_MINUTES;

          return (
            <TableTile
              key={table.id}
              table={table}
              maxX={maxX}
              maxY={maxY}
              minutes={minutes}
              overdue={overdue}
              active={table.id === activeTableId}
              onPick={onPick}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Una mesa del plano.
 *
 * Es el objeto fisico del salon: un rectangulo con la etiqueta escrita adentro. El
 * color es el estado y el texto dice el estado, para que el color no sea el unico
 * que porta la informacion.
 */
function TableTile({
  table,
  maxX,
  maxY,
  minutes,
  overdue,
  active,
  onPick,
}: {
  table: LocalFloorTable;
  maxX: number;
  maxY: number;
  minutes: number | null;
  overdue: boolean;
  active: boolean;
  onPick: (table: LocalFloorTable) => void;
}): ReactElement {
  const tone = STATUS_TONE[table.status];
  // Bloqueada no es "ocupada": es "no la uses". Se pinta igual de apagada para que
  // se lea de reojo, pero no es tappable: una mesa rota no se abre.
  const disabled = table.status === 'BLOQUEADA' || table.status === 'RESERVADA';

  return (
    <button
      type="button"
      onClick={() => onPick(table)}
      disabled={disabled}
      aria-label={`Mesa ${table.label}, ${STATUS_LABEL[table.status]}`}
      style={{
        left: `${(table.x / maxX) * 100}%`,
        top: `${(table.y / maxY) * 100}%`,
        width: `${(table.w / maxX) * 100}%`,
        height: `${(table.h / maxY) * 100}%`,
      }}
      className={cn(
        // `min-w/min-h` de 48px: el plano se escala, pero el dedo del mozo no.
        'absolute flex min-h-touch min-w-touch flex-col items-center justify-center gap-1 p-2',
        'border-2 font-display transition-[background-color,border-color] duration-80',
        // La forma del plano se respeta: una mesa redonda del salon es redonda en el
        // mapa. Es informacion real (dice como esta puesta la mesa), no decoracion,
        // y ademas distingue de un vistazo las mesas de barra de las de salon.
        shapeClass(table.shape),
        toneClasses(tone, overdue),
        active && 'ring-2 ring-azulejo ring-offset-2 ring-offset-enamel',
        disabled && 'pointer-events-none opacity-55',
      )}
    >
      <span className="text-lg font-bold leading-none">{table.label}</span>
      <span className="tabular text-2xs leading-none opacity-80">{table.seats} lug.</span>

      {minutes !== null && (
        <span
          className={cn(
            'tabular font-mono text-2xs leading-none',
            overdue ? 'font-semibold text-coca' : 'opacity-70',
          )}
        >
          {overdue ? `${minutes} min` : `${minutes}'`}
        </span>
      )}
    </button>
  );
}

/**
 * Radio segun la forma de la mesa.
 *
 * `rounded-wire` (2px) es el radio del sistema y va en las mesas cuadradas, que en
 * el salon son las de barra. Las redondas usan un radio grande para que se lean
 * como redondas. Ninguna usa radio de "app": el plano es un plano.
 */
function shapeClass(shape: LocalFloorTable['shape']): string {
  switch (shape) {
    case 'round':
      return 'rounded-full';
    case 'square':
      return 'rounded-none';
    default:
      return 'rounded-wire';
  }
}

/** Clases de superficie y borde segun estado. El tono vive en una sola tabla. */
function toneClasses(
  tone: 'open' | 'busy' | 'pending' | 'blocked' | 'muted',
  overdue: boolean,
): string {
  if (overdue) {
    // La mesa vencida pisa el color del estado: el motivo de ir a cobrar es la
    // hora, no que este ocupada.
    return 'border-coca bg-coca-soft text-coca';
  }
  switch (tone) {
    case 'open':
      return 'border-abierto/50 bg-abierto-soft text-abierto';
    case 'busy':
      return 'border-ink bg-ink text-tile';
    case 'pending':
      return 'border-caution bg-caution-soft text-caution';
    case 'blocked':
      return 'border-steel-dark bg-enamel-deep text-ink-faint';
    default:
      return 'border-steel bg-tile text-ink-soft';
  }
}

/**
 * Minutos que lleva ocupada la mesa.
 *
 * Truncados hacia abajo y no redondeados: el temporizador tiene que decir "hace 119
 * min" mientras faltan segundos para la hora, porque un redondeo que salta a 120 un
 * minuto antes hace que la alerta vibre.
 *
 * Una mesa que no esta ocupada no tiene temporizador, aunque le quede un
 * `occupiedSince` viejo: pintar "hace 3h" sobre una mesa libre es peor que no
 * pintar nada.
 */
function occupiedMinutes(table: LocalFloorTable, now: number): number | null {
  if (table.status !== 'OCUPADA' && table.status !== 'PIDIO_CUENTA') return null;
  if (!table.occupiedSince) return null;
  const since = Date.parse(table.occupiedSince);
  if (Number.isNaN(since)) return null;
  return Math.max(0, Math.floor((now - since) / 60_000));
}

/** "12 mesas · 3 ocupadas" en una linea, que es como lo lee el mozo. */
function countSummary(tables: readonly LocalFloorTable[]): string {
  const total = tables.length;
  const busy = tables.filter((t) => t.status === 'OCUPADA' || t.status === 'PIDIO_CUENTA').length;
  return `${total} ${total === 1 ? 'mesa' : 'mesas'} · ${busy} con gente`;
}

/** Sin plano cargado. Dice que falta, no solo que no hay nada. */
function EmptyFloor({ hasFloors }: { hasFloors: boolean }): ReactElement {
  return (
    <EmptyState pill="Sin plano">
      {hasFloors
        ? 'Este sector todavia no tiene mesas cargadas.'
        : 'Este local todavia no tiene el salon cargado. Pedile al encargado que lo cargue.'}
    </EmptyState>
  );
}
