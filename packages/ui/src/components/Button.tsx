import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Boton del sistema.
 *
 * Reglas del diseno que se respetan aca:
 *
 *  - `azulejo` (primario) y `coca` (destructivo) nunca juntos: un boton que
 *    anula es `destructivo` o no es nada. Por eso no hay `variant="danger-primary"`.
 *  - Todo target es de 48px minimos. El POS se usa parado y con guantes.
 *  - Radio de alambre (2px), no de "app".
 *  - Sin transicion de transform: `hover` cambia color y borde, nada mas.
 */
export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2',
    'rounded-wire font-display font-semibold',
    'min-h-touch min-w-touch px-4',
    'select-none whitespace-nowrap',
    'transition-[background-color,border-color,color] duration-80 ease-out-quick',
    'disabled:pointer-events-none disabled:opacity-45',
  ],
  {
    variants: {
      variant: {
        /** Accion principal: cobrar, guardar, continuar. */
        primary: 'bg-azulejo text-tile border border-azulejo-deep hover:bg-azulejo-deep',
        /** Accion secundaria: cancelar, volver. */
        secondary: 'bg-tile text-ink border border-steel hover:bg-tile-warm',
        /** Accion tercia: la que esta disponible pero no es la que se busca. */
        ghost:
          'bg-transparent text-ink-soft border border-transparent hover:bg-enamel-deep hover:text-ink',
        /** Irreversible: anular, descontar, cerrar caja. Siempre con cinta. */
        destructive: 'bg-coca text-tile border border-coca-deep hover:bg-coca-deep',
        /** Sobre superficie oscura: el spine y la barra de estado. */
        inverse: 'bg-ink text-tile border border-ink hover:bg-ink-soft',
      },
      size: {
        /** 48px: el default del POS. */
        md: 'h-12 text-base',
        /** 40px: admin, donde el mouse es el puntero principal. */
        sm: 'h-10 text-sm',
        /** 56px: la accion que se usa con una sola mano mientras se sirve. */
        lg: 'h-14 text-lg',
      },
      block: {
        true: 'w-full',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

/**
 * El rayado de caution no es una prop: se deriva de `variant="destructive"` y
 * no se puede apagar. Una accion irreversible lleva cinta siempre; dejar el rayado
 * en manos del que arma la pantalla es exactamente como se pierde el aviso.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, type = 'button', children, ...props },
  ref,
) {
  const isDestructive = variant === 'destructive';
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...props}
    >
      {isDestructive && (
        <span
          aria-hidden
          className="caution-tape -mx-4 -mt-12 shrink-0"
          data-testid="button-caution"
        />
      )}
      <span className={cn('inline-flex items-center gap-2', isDestructive && 'pt-1')}>
        {children}
      </span>
    </button>
  );
});
