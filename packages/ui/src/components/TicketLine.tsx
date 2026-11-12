import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { formatMoney, money, type Currency } from '@comanda/domain';
import { cn } from '../lib/cn';

/**
 * Linea del rollo de comanda.
 *
 * Este es el elemento con el que el mozo trabaja: no lo lee, lo reconoce. Por
 * eso la guia de puntos y el precio alineado a la derecha no son adorno: son la
 * convencion de un comprobante impreso y hacen que dos precios se comparen de un
 * vistazo sin alinear mentalmente.
 */
export interface TicketLineProps extends HTMLAttributes<HTMLDivElement> {
  /** Cantidad y nombre, ya formateados ("2x" + "Capuchino"). */
  quantity?: string | number;
  /** Nombre del item y sus modificadores. */
  children: ReactNode;
  /** Importe de la linea. */
  totalCents: number;
  currency: Currency;
  locale?: string;
  /** Estado del item: ACTIVE o VOIDED. Un item anulado se ve tachado. */
  voided?: boolean;
  /** Nota del mozo o del cocina. */
  note?: string;
  /** Marca de la mesa o comensal (asiento). */
  badge?: ReactNode;
}

export const TicketLine = forwardRef<HTMLDivElement, TicketLineProps>(function TicketLine(
  {
    quantity,
    children,
    totalCents,
    currency,
    locale = 'es-AR',
    voided,
    note,
    badge,
    className,
    ...props
  },
  ref,
) {
  const formatted = formatMoney(money(totalCents, currency), locale);

  return (
    <div
      ref={ref}
      className={cn(
        'flex items-baseline gap-2 py-2 font-mono text-sm',
        voided && 'text-ink-faint line-through decoration-coca decoration-2',
        className,
      )}
      {...props}
    >
      {quantity !== undefined && (
        <span className="tabular shrink-0 font-semibold text-ink-soft">{quantity}x</span>
      )}

      <span className="min-w-0 flex-1">
        <span className="block">{children}</span>
        {note && (
          <span className={cn('block text-2xs text-ink-faint', voided && 'line-through')}>
            {note}
          </span>
        )}
      </span>

      {badge}

      <span aria-hidden className="ticket-leader" />

      <span className="tabular shrink-0 font-semibold">{formatted}</span>
    </div>
  );
});

/**
 * Subtotal o total del ticket.
 * Los importes intermedios van en tinta suave y el total en tinta fuerte: la
 * jerarquia se lee por el peso del numero, no por un recuadro alrededor.
 */
export interface TicketTotalProps {
  label: string;
  amountCents: number;
  currency: Currency;
  locale?: string;
  emphasis?: boolean;
  /** Muestra el importe negativo en rojo, como en un comprobante real. */
  negative?: boolean;
}

export function TicketTotal({
  label,
  amountCents,
  currency,
  locale = 'es-AR',
  emphasis = false,
  negative = false,
}: TicketTotalProps) {
  return (
    <div
      className={cn(
        'flex items-baseline gap-2 font-mono',
        emphasis ? 'text-base font-semibold' : 'text-sm text-ink-soft',
      )}
    >
      <span>{label}</span>
      <span aria-hidden className="ticket-leader" />
      <span className={cn('tabular shrink-0', emphasis && 'text-lg', negative && 'text-coca')}>
        {formatMoney(money(amountCents, currency), locale)}
      </span>
    </div>
  );
}

/** Separador de papel del rollo, con su linea punteada characteristic. */
export function TicketRule({ className }: { className?: string }) {
  return <div aria-hidden className={cn('my-2 border-t border-dashed border-steel', className)} />;
}
