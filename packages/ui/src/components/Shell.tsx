import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Layout del admin: barra superior con navegacion y contenido como planilla.
 *
 * No hay tarjetas flotantes con sombra difusa (el kit de dashboard generico que
 * el plan descarta explicitamente). El admin es densidad: filas con filete de
 * acero, tipografia pequena, y el contenido pegado al borde de la ventana.
 */
export function AdminShell({
  title,
  nav,
  children,
  actions,
  className,
}: {
  title: string;
  nav: ReactNode;
  children: ReactNode;
  /** Acciones de la pagina, a la derecha de la barra. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-screen flex-col bg-enamel text-ink', className)}>
      <header className="sticky top-0 z-20 border-b border-steel bg-tile">
        <div className="flex items-center gap-6 px-6">
          <span className="font-display text-lg font-bold tracking-tight text-ink">{title}</span>
          <nav aria-label="Secciones" className="flex min-w-0 flex-1 items-stretch gap-1">
            {nav}
          </nav>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      </header>

      <main className="flex-1 px-6 py-5">{children}</main>
    </div>
  );
}

/** Item de navegacion del admin. Activo con subrayado de acero, no con fondo. */
export function AdminNavItem({
  label,
  active,
  href,
  onSelect,
}: {
  label: string;
  active?: boolean;
  href?: string;
  onSelect?: () => void;
}) {
  const className = cn(
    'relative px-3 py-3.5 font-display text-sm font-semibold',
    'transition-colors duration-80',
    active ? 'text-ink' : 'text-ink-soft hover:text-ink',
  );

  const content = (
    <>
      {label}
      {active && <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 bg-ink" />}
    </>
  );

  if (href) {
    return (
      <a href={href} aria-current={active ? 'page' : undefined} className={className}>
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={className}
    >
      {content}
    </button>
  );
}

/**
 * Tabla de planilla. Filas con filete de acero, sin cards.
 * `dense` activa el modo de 13px que se usa para leer volumenes de datos.
 */
export function DataTable({
  headers,
  children,
  dense = true,
  className,
}: {
  headers: ReactNode[];
  children: ReactNode;
  dense?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-steel-dark">
            {headers.map((header, index) => (
              <th
                key={index}
                scope="col"
                className={cn(
                  'px-3 py-2 font-display text-2xs font-semibold uppercase tracking-wide text-ink-faint',
                  dense ? 'text-2xs' : 'text-xs',
                )}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={dense ? 'text-sm' : 'text-base'}>{children}</tbody>
      </table>
    </div>
  );
}

/** Fila de la tabla. */
export function DataRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr className={cn('rule-row transition-colors duration-80 hover:bg-tile-warm', className)}>
      {children}
    </tr>
  );
}

/** Celda. `align="right"` para columnas de dinero: el unico lugar justificado a la derecha. */
export function DataCell({
  children,
  align = 'left',
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={cn(
        'px-3 py-2.5 align-middle',
        align === 'right' && 'tabular text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Titulo de seccion dentro del admin. */
export function SectionHeading({
  title,
  detail,
  actions,
}: {
  title: string;
  detail?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div>
        <h2 className="font-display text-lg font-bold tracking-tight text-ink">{title}</h2>
        {detail && <p className="mt-0.5 text-xs text-ink-soft">{detail}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
