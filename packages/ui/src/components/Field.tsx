import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Campo de formulario.
 *
 * El label va siempre visible y en sentence case: no hay eyebrow en versalitas
 * ni placeholder como etiqueta. Un placeholder desaparece en cuanto se escribe,
 * y en el mostrador eso deja un campo sin nombre.
 *
 * El mensaje de error esta enlazado con `aria-describedby` y el campo recibe
 * `aria-invalid`, para que un lector de pantalla lo anuncie.
 */
export const fieldVariants = cva(
  [
    'w-full rounded-wire bg-tile text-ink',
    'border border-steel',
    'min-h-touch px-3',
    'placeholder:text-ink-faint',
    'transition-[border-color,box-shadow] duration-80',
    'disabled:bg-enamel-deep disabled:text-ink-faint',
    'read-only:bg-tile-warm',
  ],
  {
    variants: {
      size: {
        md: 'h-12 text-base',
        lg: 'h-14 text-lg tracking-wide', // PIN y codigos
      },
      invalid: {
        true: 'border-coca focus-visible:shadow-[0_0_0_2px_var(--color-enamel),0_0_0_4px_var(--color-coca)]',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, VariantProps<typeof fieldVariants> {
  label: string;
  error?: string;
  /** Ayuda persistente, distinta del error. */
  hint?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, className, size, invalid, id, ...props },
  ref,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-xs font-semibold text-ink-soft">
        {label}
      </label>

      <input
        ref={ref}
        id={fieldId}
        aria-invalid={invalid || Boolean(error)}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={cn(fieldVariants({ size, invalid: invalid || Boolean(error) }), className)}
        {...props}
      />

      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-coca">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

/**
 * Teclado numerico en pantalla para el PIN.
 *
 * El PIN se tipea con el dedo gordo, con guantes, aOften mirando la comanda y no
 * la pantalla. Por eso los digitos son targets enormes y el orden es el del
 * teclado telefonico, que es el que todos ya conocen de memoria.
 */
export function PinPad({
  onDigit,
  onBackspace,
  onSubmit,
  disabled,
}: {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className="grid grid-cols-3 gap-2">
      {digits.map((digit) => (
        <button
          key={digit}
          type="button"
          onClick={() => onDigit(digit)}
          disabled={disabled}
          className={cn(
            'h-16 rounded-wire border border-steel bg-tile font-mono text-xl font-semibold',
            'transition-[background-color,border-color] duration-80',
            'hover:bg-tile-warm active:bg-enamel-deep',
            'disabled:pointer-events-none disabled:opacity-45',
          )}
        >
          {digit}
        </button>
      ))}

      <button
        type="button"
        onClick={onBackspace}
        disabled={disabled}
        className="h-16 rounded-wire border border-steel bg-enamel-deep font-display text-sm font-semibold text-ink-soft transition-colors duration-80 hover:bg-steel disabled:pointer-events-none disabled:opacity-45"
      >
        Borrar
      </button>

      <button
        type="button"
        onClick={() => onDigit('0')}
        disabled={disabled}
        className="h-16 rounded-wire border border-steel bg-tile font-mono text-xl font-semibold transition-colors duration-80 hover:bg-tile-warm active:bg-enamel-deep disabled:pointer-events-none disabled:opacity-45"
      >
        0
      </button>

      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled}
        className="h-16 rounded-wire border border-azulejo-deep bg-azulejo font-display text-sm font-semibold text-tile transition-colors duration-80 hover:bg-azulejo-deep disabled:pointer-events-none disabled:opacity-45"
      >
        Entrar
      </button>
    </div>
  );
}

/** Puntos del PIN tipeado. Muestra la longitud sin revelar el valor. */
export function PinDots({ length, max = 6 }: { length: number; max?: number }) {
  return (
    <div
      className="flex items-center justify-center gap-3 py-2"
      role="status"
      aria-label={`${length} de ${max} digitos`}
    >
      {Array.from({ length: max }, (_, index) => (
        <span
          key={index}
          aria-hidden
          className={cn(
            'h-4 w-4 rounded-full border-2 transition-colors duration-80',
            index < length ? 'border-azulejo bg-azulejo' : 'border-steel-dark bg-transparent',
          )}
        />
      ))}
    </div>
  );
}

/** Aviso de error de formulario. Muestra que paso y como corregirlo. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-wire border border-coca/40 bg-coca-soft px-3 py-2.5 text-sm font-medium text-coca"
    >
      {children}
    </div>
  );
}
