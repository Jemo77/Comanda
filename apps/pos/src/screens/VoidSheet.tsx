import { useState, type ReactElement } from 'react';
import { Button, FormError } from '@comanda/ui';

/**
 * Hoja de anulacion.
 *
 * **El motivo es obligatorio**, y no es una formalidad: `ORDER_ITEM_VOIDED` esta en
 * `REASON_REQUIRED_EVENT_TYPES` del dominio, y sin el la pregunta "cuanto se
 * descuento por anulaciones" no tiene respuesta posible. El servidor rechaza el
 * evento sin motivo, asi que una anulacion sin motivo no es una anulacion
 * silenciosa: es una linea que el mozo cree que borro y que sigue cobrandose.
 *
 * El boton es `destructive` (rojo coca) y lleva la cinta de caution sola. Nunca
 * primario junto a destructivo: el mozo tiene que poder ver de un vistazo que lo
 * que esta por pasar no se puede deshacer.
 */
export function VoidSheet({
  label,
  onCancel,
  onConfirm,
}: {
  /** Que se esta anulando. Va en el titulo: el mozo necesita ver que, no solo como. */
  label: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}): ReactElement {
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 3;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Anular ${label}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-wire border border-steel-dark bg-tile shadow-tray">
        <header className="border-b border-steel px-4 py-3">
          <h2 className="font-display text-base font-bold tracking-tight">Anular {label}</h2>
          <p className="mt-0.5 text-xs text-ink-soft">
            El item queda en el ticket, tachado, con el motivo y tu nombre.
          </p>
        </header>

        <div className="space-y-3 px-4 py-4">
          <label className="block">
            <span className="text-xs font-semibold text-ink-soft">Motivo</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
              autoFocus
              placeholder="Se cayo la mesa, error de coccion, cambio de turno..."
              className={[
                'mt-1.5 min-h-touch w-full rounded-wire border border-steel bg-tile px-3',
                'font-display text-sm placeholder:text-ink-faint',
                'transition-[border-color] duration-80',
              ].join(' ')}
            />
          </label>

          {!valid && reason.length > 0 && (
            <FormError>Conta un poco mas: el motivo queda en el registro.</FormError>
          )}
        </div>

        <footer className="flex gap-2 border-t border-steel bg-tile-warm px-4 py-3">
          <Button block onClick={onCancel}>
            Volver
          </Button>
          <Button
            variant="destructive"
            block
            disabled={!valid}
            onClick={() => onConfirm(reason.trim())}
          >
            Anular item
          </Button>
        </footer>
      </div>
    </div>
  );
}
