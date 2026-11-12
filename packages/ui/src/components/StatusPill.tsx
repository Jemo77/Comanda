import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Estado de mesa o de sesion, pintado como la señalética del local.
 *
 * `LIBRE` en verde, `OCUPADA` en tinta, `PIDIÓ CUENTA` en amarillo. Son los
 * colores de los letreros de "ABIERTO" y "CERRADO", que es lo que el mozo ya
 * conoce: no hay que aprender un codigo de color nuevo.
 *
 * Nota de diseno: sin punto ni icono de circulo. Un punto de color no cambia
 * la lectura para quien tiene baja vision, y el texto dice exactamente lo que
 * pasa.
 */
export const statusPillVariants = cva(
  [
    'inline-flex items-center gap-1.5 rounded-wire px-2 py-1',
    'font-display text-2xs font-semibold uppercase tracking-wide',
    'border',
  ],
  {
    variants: {
      tone: {
        /** Mesa libre, sesion activa. */
        open: 'border-abierto/40 bg-abierto-soft text-abierto',
        /** Mesa ocupada, en curso. */
        busy: 'border-steel-dark bg-tile text-ink',
        /** Pidio cuenta: hay que ir a cobrar. */
        pending: 'border-caution/50 bg-caution-soft text-caution',
        /** Bloqueada, anulada, error. */
        blocked: 'border-coca/40 bg-coca-soft text-coca',
        /** Accion secundaria, sin urgencia. */
        muted: 'border-steel bg-enamel-deep text-ink-soft',
      },
    },
    defaultVariants: { tone: 'muted' },
  },
);

export interface StatusPillProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof statusPillVariants> {
  children: ReactNode;
}

export function StatusPill({ className, tone, children, ...props }: StatusPillProps) {
  return (
    <span className={cn(statusPillVariants({ tone }), className)} {...props}>
      {children}
    </span>
  );
}

/**
 * Estado de conexion del POS. Vive en el spine, no flotando: si cambia, tiene
 * que cambiar en el lugar donde el mozo ya mira.
 */
export function ConnectionBadge({
  status,
  pendingEvents,
}: {
  status: 'online' | 'offline' | 'syncing';
  /** Eventos en la outbox esperando envio. */
  pendingEvents?: number;
}) {
  const label =
    status === 'offline'
      ? 'Sin conexión'
      : status === 'syncing'
        ? pendingEvents && pendingEvents > 0
          ? `Sincronizando ${pendingEvents}`
          : 'Sincronizando'
        : 'En línea';

  const tone = status === 'offline' ? 'blocked' : status === 'syncing' ? 'pending' : 'open';

  return (
    <StatusPill tone={tone} aria-live="polite" title={`Estado de conexión: ${label}`}>
      <span>{label}</span>
      {status === 'offline' && pendingEvents !== undefined && pendingEvents > 0 && (
        <span className="tabular opacity-80">· {pendingEvents}</span>
      )}
    </StatusPill>
  );
}
