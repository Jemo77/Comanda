import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Spine del POS: la columna vertical de categorias, a la izquierda, fija.
 *
 * Modela la cartelera de indices de la barra. No navega y no scrollea con la
 * pagina: el mozo elige siempre de la misma columna, con el pulgar en el mismo
 * lugar. Por eso es `sticky` y no un menu desplegable.
 */
export interface SpineProps {
  children: ReactNode;
  className?: string;
  /** Estado de conexion, arriba del spine. */
  header?: ReactNode;
  footer?: ReactNode;
}

export function Spine({ children, className, header, footer }: SpineProps) {
  return (
    <nav
      aria-label="Categorías"
      className={cn(
        'flex h-screen w-40 shrink-0 flex-col border-r border-ink/15 bg-ink text-tile',
        className,
      )}
    >
      {header}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {children}
      </div>

      {footer}
    </nav>
  );
}

/** Ficha de categoria. Estado activo con marca de seleccion, no con color de fondo. */
export interface SpineItemProps {
  label: string;
  active?: boolean;
  /** Cantidad de items de la categoria, si conviene mostrarla. */
  count?: number;
  onSelect?: () => void;
  /** SubmENU: el item esta desplegado. */
  expanded?: boolean;
  disabled?: boolean;
}

export function SpineItem({ label, active, count, onSelect, expanded, disabled }: SpineItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex min-h-touch w-full items-center justify-between gap-1',
        'px-3 py-3 text-left font-display text-sm font-semibold',
        'transition-[background-color,color] duration-80',
        'disabled:pointer-events-none disabled:opacity-40',
        active ? 'bg-tile text-ink' : 'text-tile/85 hover:bg-tile/10 hover:text-tile',
      )}
    >
      {active && (
        // Marca de seleccion: una barra de canto, como la ficha que uno saca del
        // cajon. Un fondo de color seria ambiguo en un panel oscuro.
        <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-azulejo" />
      )}
      <span className="min-w-0 truncate">{label}</span>
      {count !== undefined && (
        <span
          className={cn('tabular shrink-0 text-2xs', active ? 'text-ink-faint' : 'text-tile/50')}
        >
          {count}
        </span>
      )}
      {expanded && (
        <span
          aria-hidden
          className={cn('shrink-0 text-2xs', active ? 'text-ink-faint' : 'text-tile/50')}
        >
          ▾
        </span>
      )}
    </button>
  );
}

/** Separador entre grupos de categorias. */
export function SpineDivider() {
  return <div aria-hidden className="my-1 border-t border-tile/15" />;
}

/** Rotulo de grupo dentro del spine. */
export function SpineGroup({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-4 font-display text-2xs font-semibold text-tile/45">
      {children}
    </div>
  );
}
