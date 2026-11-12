import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Button, cn, StatusPill } from '@comanda/ui';
import type { TableStatus } from '@comanda/domain';
import { db, type LocalFloor, type LocalFloorTable } from '../data/db';
import { saveLayout } from '../data/layout';
import { getSync } from '../data/sync';
import { clamp, moveTo } from './drag';
import { useSession } from '../state/session';

/**
 * Editor de planos.
 *
 * Es la pantalla con la que el dueño o el encargado **arma** el salon: donde van
 * las mesas, cuantas lugares tiene cada una y si es redonda o cuadrada. Una vez
 * armado, el mozo nunca la vuelve a ver — para el es solo el mapa de `TableMap`.
 *
 * ## Por que Pointer Events y no `draggable`
 *
 * El plano se edita en una tablet, con el dedo, y a veces con guantes. El HTML5
 * drag and drop fue disenado para el mouse: en tactil no hay `dragstart` fiable, no
 * hay cursor de arrastre y no hay forma de saber cuando "termino" el gesto. Los
 * Pointer Events (`pointerdown/move/up` + `setPointerCapture`) son el mismo
 * mecanismo en mouse, dedo y lapiz, y dan control del gesto de punta a punta.
 *
 * ## Por que la UI es optimista
 *
 * Igual que el resto del POS: la mesa se mueve al instante y el guardado va
 * atras. Un encargado acomodando treinta mesas no puede esperar un request por
 * cada una. Si el guardado falla, se revierte **a la geometria anterior** y se
 * avisa: es preferible que la mesa vuelva a donde estaba a que el plano quede
 * mostrando una posicion que el servidor no tiene.
 *
 * ## La grilla es de 20
 *
 * No de 10 ni de 25. Es un valor que a 1.6 px por unidad da 32 px: dos pasos de
 * grilla se distinguen a simple vista y el dedo no tiene que ser preciso. Con una
 * grilla muy fina el arrastre se vuelve un ejercicio de puntería, y el plano
 * termina con mesas a tres pixeles de diferencia que no dicen nada.
 */

const GRID = 20;

/** Pixels por unidad, igual que el mapa: el editor y el mapa tienen que coincidir. */
const UNIT_PX = 1.6;

/** Margen del lienzo, en unidades de grilla, para que ninguna mesa quede pegada al borde. */
const PADDING = 20;

/** Cuanto se espera antes de guardar tras el ultimo movimiento. */
const SAVE_DEBOUNCE_MS = 400;

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

interface DragState {
  tableId: string;
  /** Desplazamiento en unidades de grilla desde la posicion original. */
  dx: number;
  dy: number;
  /** Donde estaba la mesa antes de arrastrar, para revertir. */
  originX: number;
  originY: number;
}

export function FloorPlan(): ReactElement {
  const { user } = useSession();
  const deviceId = getSync()?.deviceId ?? null;

  // Ajustar el plano es del Encargado o del Dueño, no del Mozo ni del Cajero
  // (`table.manage`). La UI **refleja** el permiso; la verificacion real la hace
  // el servidor en cada `PUT`.
  //
  // Se comprueba aca y no se espera al 403 porque el modo de falla de no hacerlo es
  // silencioso y malo: las mesas se mueven en pantalla, el mozo acomoda veinte
  // mesas, y al recargar todo volvio a su sitio. No hay ningun error visible.
  const canEdit = user?.permissions.includes('table.manage') ?? false;

  const [floors, setFloors] = useState<LocalFloor[]>([]);
  const [tables, setTables] = useState<LocalFloorTable[]>([]);
  const [activeFloorId, setActiveFloorId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  const pending = useRef<Map<string, { x: number; y: number }>>(new Map());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [loadedFloors, loadedTables] = await Promise.all([
        db.floors.orderBy('sort').toArray(),
        db.floorTables.toArray(),
      ]);
      if (!alive) return;
      setFloors(loadedFloors);
      setTables(loadedTables);
      setActiveFloorId((current) => current ?? loadedFloors[0]?.id ?? null);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const floorTables = useMemo(
    () => tables.filter((table) => table.floorId === activeFloorId),
    [tables, activeFloorId],
  );

  /**
   * Extremos del lienzo.
   *
   * Se calculan de las mesas mas el padding, no con un numero fijo: el plano se
   * ajusta a lo que hay puesto. Un lienzo de 5000x5000 con trece mesas deja todo
   * juntado en un rincon y no se puede agarrar nada.
   */
  const bounds = useMemo(() => {
    let maxX = PADDING * 4;
    let maxY = PADDING * 4;
    for (const table of floorTables) {
      maxX = Math.max(maxX, table.x + table.w + PADDING);
      maxY = Math.max(maxY, table.y + table.h + PADDING);
    }
    // Multiple de la grilla: un lienzo que no termina en la grilla hace que el
    // ultimo column sea mas angosto que los demas y el arrastre "resbale".
    return {
      w: Math.ceil(maxX / GRID) * GRID,
      h: Math.ceil(maxY / GRID) * GRID,
    };
  }, [floorTables]);

  /** Guarda lo pendiente, agrupado en un solo lote. */
  const flush = useCallback(async () => {
    timer.current = null;
    const changes = [...pending.current.entries()].map(([tableId, pos]) => ({ tableId, ...pos }));
    pending.current.clear();
    if (changes.length === 0) return;

    setSave({ kind: 'saving' });
    try {
      await saveLayout(changes);
      setSave({ kind: 'saved' });
    } catch (error) {
      // Se revierte a la posicion anterior. Un plano que muestra una posicion que
      // el servidor no tiene es peor que una mesa que quedo donde estaba.
      for (const change of changes) {
        const table = tables.find((candidate) => candidate.id === change.tableId);
        if (table) await db.floorTables.update(table.id, { x: table.x, y: table.y });
      }
      setTables(await db.floorTables.toArray());
      setSave({
        kind: 'error',
        message: error instanceof Error ? error.message : 'No pudimos guardar el plano.',
      });
    }
  }, [tables]);

  /** Encola un movimiento y rearma el debounce. */
  const queue = useCallback(
    (tableId: string, x: number, y: number) => {
      pending.current.set(tableId, { x, y });
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  // Sin sesion o sin permiso no se edita. `deviceId === null` es el caso de una
  // tablet recien abierta; `canEdit` es el de un rol que no administra el local.
  const disabled = deviceId === null || !canEdit;

  const selected = floorTables.find((table) => table.id === selectedId) ?? null;

  if (floors.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-ink-faint">Este local todavia no tiene sectores.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-steel bg-tile px-4 py-3">
        <div className="flex items-center gap-2">
          {floors.map((floor) => (
            <Button
              key={floor.id}
              variant={floor.id === activeFloorId ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => {
                setActiveFloorId(floor.id);
                setSelectedId(null);
                setDrag(null);
              }}
            >
              {floor.name}
            </Button>
          ))}
        </div>

        {canEdit ? (
          <SaveBadge state={save} />
        ) : (
          <StatusPill tone="muted">Solo el encargado puede acomodar el plano</StatusPill>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto bg-enamel p-4">
          <div
            data-canvas
            className="relative touch-none select-none border border-steel-dark bg-tile"
            style={{
              width: `${bounds.w * UNIT_PX}px`,
              height: `${bounds.h * UNIT_PX}px`,
              // La grilla se dibuja con lineas de 1px cada GRID unidades. Es lo
              // unico que ayuda a poner una mesa "en linea" con otra sin medir.
              backgroundImage:
                'linear-gradient(to right, var(--color-steel) 1px, transparent 1px),' +
                'linear-gradient(to bottom, var(--color-steel) 1px, transparent 1px)',
              backgroundSize: `${GRID * UNIT_PX}px ${GRID * UNIT_PX}px`,
            }}
          >
            {floorTables.map((table) => {
              const isDragging = drag?.tableId === table.id;
              const offsetX = isDragging ? drag.dx : 0;
              const offsetY = isDragging ? drag.dy : 0;

              return (
                <div
                  key={table.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Mesa ${table.label}, ${table.seats} lugares`}
                  data-table-id={table.id}
                  onPointerDown={(event) => {
                    if (disabled) return;
                    // `setPointerCapture` es lo que hace que el gesto siga siendo
                    // nuestro aunque el dedo se salga de la mesa a media forma: sin
                    // esto, el arrastre se corta en el borde.
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setSelectedId(table.id);
                    setDrag({
                      tableId: table.id,
                      dx: 0,
                      dy: 0,
                      originX: event.clientX,
                      originY: event.clientY,
                    });
                  }}
                  onPointerMove={(event) => {
                    if (!drag || drag.tableId !== table.id) return;
                    const canvas = event.currentTarget.closest('[data-canvas]');
                    if (!canvas) return;
                    const rect = canvas.getBoundingClientRect();

                    const rawDx = (event.clientX - drag.originX) / rect.width * bounds.w;
                    const rawDy = (event.clientY - drag.originY) / rect.height * bounds.h;

                    // De pixeles a unidades de grilla, y despues a la posicion
                    // final. Va en `drag.ts` y no aca para que se pueda probar sin
                    // DOM: ver ese modulo.
                    const next = moveTo({
                      x: table.x,
                      y: table.y,
                      w: table.w,
                      h: table.h,
                      dx: rawDx,
                      dy: rawDy,
                      grid: GRID,
                      boundsW: bounds.w,
                      boundsH: bounds.h,
                    });

                    const dx = next.x - table.x;
                    const dy = next.y - table.y;
                    if (dx === drag.dx && dy === drag.dy) return;

                    setDrag({ ...drag, dx, dy });
                    void db.floorTables.update(table.id, { x: next.x, y: next.y });
                    setTables((current) =>
                      current.map((t) => (t.id === table.id ? { ...t, ...next } : t)),
                    );
                    queue(table.id, next.x, next.y);
                  }}
                  onPointerUp={(event) => {
                    if (drag?.tableId !== table.id) return;
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    setDrag(null);
                  }}
                  onKeyDown={(event) => {
                    // Flechas mueven la mesa de a una unidad de grilla. Es lo que
                    // hace el editor accesible: el arrastre con el dedo no es la
                    // unica forma de mover una mesa, y con teclado se llega a
                    // posiciones que con el dedo no salen.
                    const step: Record<string, [number, number]> = {
                      ArrowUp: [0, -GRID],
                      ArrowDown: [0, GRID],
                      ArrowLeft: [-GRID, 0],
                      ArrowRight: [GRID, 0],
                    };
                    const delta = step[event.key];
                    if (!delta || disabled) return;
                    event.preventDefault();
                    const x = clamp(table.x + delta[0], 0, bounds.w - table.w);
                    const y = clamp(table.y + delta[1], 0, bounds.h - table.h);
                    setTables((current) =>
                      current.map((t) => (t.id === table.id ? { ...t, x, y } : t)),
                    );
                    void db.floorTables.update(table.id, { x, y });
                    queue(table.id, x, y);
                  }}
                  className={cn(
                    'absolute flex touch-none flex-col items-center justify-center gap-0.5 border-2 border-ink-soft bg-tile',
                    'font-display transition-shadow duration-80',
                    shapeClass(table.shape),
                    isDragging && 'z-10 shadow-lg',
                    selectedId === table.id && 'border-azulejo',
                    disabled && 'opacity-60',
                  )}
                  style={{
                    left: `${(table.x + offsetX) * UNIT_PX}px`,
                    top: `${(table.y + offsetY) * UNIT_PX}px`,
                    width: `${table.w * UNIT_PX}px`,
                    height: `${table.h * UNIT_PX}px`,
                    cursor: disabled ? 'not-allowed' : 'grab',
                    // El pulso de "recien guardado" se ve sin tener que leer nada:
                    // es la unica confirmacion visual que hace falta para un gesto
                    // que el usuario ya siente que hizo.
                    boxShadow: isDragging ? '0 8px 24px rgba(0,0,0,.25)' : undefined,
                  }}
                >
                  <span className="text-base font-bold leading-none">{table.label}</span>
                  <span className="tabular font-mono text-2xs leading-none text-ink-soft">
                    {table.seats}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="w-72 shrink-0 overflow-y-auto border-l border-steel bg-tile p-4">
          {selected ? (
            <TableInspector
              table={selected}
              onChange={async (patch) => {
                setTables((current) =>
                  current.map((t) => (t.id === selected.id ? { ...t, ...patch } : t)),
                );
                await db.floorTables.update(selected.id, patch);
                if (patch.x !== undefined && patch.y !== undefined) {
                  queue(selected.id, patch.x, patch.y);
                }
              }}
            />
          ) : (
            <p className="text-sm text-ink-faint">
              Elegí una mesa del plano para editar su capacidad y su forma.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Radio segun la forma. Igual que en el mapa: el plano respeta como esta puesta
 * la mesa, y el editor tiene que mostrar lo mismo que va a ver el mozo.
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

/**
 * Estado del guardado.
 *
 * El POS nunca muestra un spinner por guardar un plano: el encargado esta
 * moviendo mesas, no esperando. El cartel solo dice cuando **algo no esta bien**,
 * y "guardado" aparece y se va: es la confirmacion minima que hace falta para un
 * gesto que el usuario ya siente que hizo.
 */
function SaveBadge({ state }: { state: SaveState }): ReactElement {
  if (state.kind === 'error') {
    return <StatusPill tone="blocked">{state.message}</StatusPill>;
  }
  if (state.kind === 'saving') {
    return <StatusPill tone="pending">Guardando…</StatusPill>;
  }
  if (state.kind === 'saved') {
    return <StatusPill tone="open">Plano guardado</StatusPill>;
  }
  return <StatusPill tone="muted">Plano</StatusPill>;
}

/**
 * Datos de una mesa.
 *
 * Capacidad y forma son lo que el dueño cambia seguido; la geometria no se toca
 * aca a proposito, porque moverla con un numero es peor que moverla con el dedo y
 * mucho mas facil de arruinar.
 */
function TableInspector({
  table,
  onChange,
}: {
  table: LocalFloorTable;
  onChange: (patch: Partial<LocalFloorTable>) => Promise<void>;
}): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-lg font-bold text-ink">Mesa {table.label}</h2>
        <p className="mt-0.5 text-2xs text-ink-faint">
          {table.x} · {table.y} · {table.w}×{table.h}
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="font-display text-xs font-semibold text-ink-soft">Etiqueta</span>
        <input
          type="text"
          value={table.label}
          maxLength={20}
          onChange={(event) => void onChange({ label: event.target.value })}
          className="min-h-touch rounded-wire border border-steel bg-tile px-3 font-display text-sm"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-display text-xs font-semibold text-ink-soft">Lugares</span>
        <input
          type="number"
          min={1}
          max={40}
          value={table.seats}
          onChange={(event) => {
            const seats = Number(event.target.value);
            if (Number.isInteger(seats) && seats >= 1 && seats <= 40) {
              void onChange({ seats });
            }
          }}
          className="tabular min-h-touch rounded-wire border border-steel bg-tile px-3 font-mono text-sm"
        />
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className="font-display text-xs font-semibold text-ink-soft">Forma</legend>
        <div className="flex gap-2">
          {(['rect', 'square', 'round'] as const).map((shape) => (
            <Button
              key={shape}
              size="sm"
              variant={table.shape === shape ? 'primary' : 'secondary'}
              onClick={() => void onChange({ shape })}
            >
              {shape === 'rect' ? 'Rectangular' : shape === 'square' ? 'Cuadrada' : 'Redonda'}
            </Button>
          ))}
        </div>
      </fieldset>

      <TableStatusPicker
        status={table.status}
        onChange={(status) => void onChange({ status })}
      />

      <p className="text-2xs leading-relaxed text-ink-faint">
        Mové la mesa con el dedo, o con las flechas del teclado si la mesa esta
        enfocada.
      </p>
    </div>
  );
}

/**
 * Estado de la mesa desde el editor.
 *
 * `OCUPADA` y `PIDIO_CUENTA` **no estan**: los deriva el servidor al abrir y
 * cerrar una comanda. Editarlos a mano produce una mesa ocupada sin comanda, que es
 * un estado que el resto del sistema no sabe mostrar.
 */
function TableStatusPicker({
  status,
  onChange,
}: {
  status: TableStatus;
  onChange: (status: TableStatus) => void;
}): ReactElement {
  const options: Array<{ value: TableStatus; label: string }> = [
    { value: 'LIBRE', label: 'Libre' },
    { value: 'RESERVADA', label: 'Reservada' },
    { value: 'BLOQUEADA', label: 'Bloqueada' },
  ];

  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="font-display text-xs font-semibold text-ink-soft">Estado</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={status === option.value ? 'primary' : 'secondary'}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {status === 'OCUPADA' || status === 'PIDIO_CUENTA' ? (
        <p className="mt-1 text-2xs text-ink-faint">
          El estado lo cambia el servidor cuando se abre o cierra una comanda.
        </p>
      ) : null}
    </fieldset>
  );
}