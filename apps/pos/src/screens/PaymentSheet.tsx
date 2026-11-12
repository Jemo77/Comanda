import { useMemo, useState, type ReactElement } from 'react';
import { Button, FormError, TicketTotal, cn } from '@comanda/ui';
import {
  formatMoney,
  money,
  suggestedTips,
  type OrderTotals,
  type PaymentMethod,
} from '@comanda/domain';
import { useOrder } from '../state/order';

/**
 * Hoja de cobro.
 *
 * Es la pantalla donde el mozo y el cliente se miran. Por eso el importe esta en
 * mono tabular de 44px y no en un campo editable: es lo que se **dice** en voz
 * alta, y un total que se puede editar es un total que se puede editar por error.
 *
 * Lo que si se edita son las lineas de pago, porque el pago mixto es el caso normal:
 * media hora en efectivo y el resto con tarjeta, o una parte por QR. Cada linea
 * es un metodo y un importe, y quedan en la outbox como `PAYMENT_RECORDED`
 * separadas, que es lo que el servidor necesita para el arqueo.
 *
 * Las propinas salen de `suggestedTips()` con basis points: un 10% de $3.333 son
 * $333 y no $333,3, y el redondeo se hace una sola vez, en el dominio.
 */

/** Porcentajes de propina que ofrece el local, en basis points. */
const TIP_BPS = [1000, 1500, 2000] as const;

/** Metodos en el orden en que se usan. */
const METHODS: ReadonlyArray<{ method: PaymentMethod; label: string }> = [
  { method: 'CASH', label: 'Efectivo' },
  { method: 'CARD', label: 'Tarjeta' },
  { method: 'QR', label: 'QR' },
  { method: 'TRANSFER', label: 'Transferencia' },
];

/** Una linea de pago en edicion. */
interface DraftLine {
  method: PaymentMethod;
  /** Texto crudo de lo que se esta tipeando. Se parsea a centavos al confirmar. */
  amount: string;
}

export function PaymentSheet({
  currency,
  totals,
  onClose,
}: {
  currency: string;
  totals: OrderTotals;
  onClose: () => void;
}): ReactElement {
  const pay = useOrder((state) => state.pay);
  const closeOrder = useOrder((state) => state.closeOrder);

  const [lines, setLines] = useState<DraftLine[]>([
    { method: 'CASH', amount: (totals.totalCents / 100).toFixed(2) },
  ]);
  const [tipCents, setTipCents] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // El total con la propina elegida: el mozo tiene que ver el numero que va a
  // cobrar antes de elegir la propina, o elige a ciegas.
  const withTip = totals.totalCents + tipCents;

  /**
   * Lo que ya cubre lo tipeado.
   *
   * Las lineas arrancan con el importe del total **sin** propina, y la propina se
   * elige despues. Si no se reajustara al elegirla, el mozo veria "Efectivo
   * $102,50" y un total de $117,88, y el boton de cobrar quedaria deshabilitado
   * sin que nada diga por que: el mejor caso para que el mozo renuncie a cobrar.
   *
   * Solo se reajusta mientras no se haya tocado ningun importe a mano. En cuanto el
   * mozo escribe un numero, la pantalla es de el.
   */
  const [tocado, setTocado] = useState(false);

  const linesAjustadas = useMemo(
    () =>
      tocado
        ? lines
        : lines.map((line, index) =>
            // Solo la primera linea absorbe el cambio: las siguientes son para
            // partir la cuenta, no para sumar lo que falta.
            index === 0 && line.method === 'CASH'
              ? { ...line, amount: (withTip / 100).toFixed(2) }
              : line,
          ),
    [lines, tocado, withTip],
  );

  const chargedCents = linesAjustadas.reduce((acc, line) => acc + parseAmount(line.amount), 0);
  const changeCents = chargedCents - withTip;
  const tips = useMemo(() => suggestedTips(totals.totalCents, TIP_BPS), [totals.totalCents]);

  /** Confirma el cobro: una linea de pago por metodo, y cierra la comanda. */
  const settle = (): void => {
    if (chargedCents < withTip) {
      setError('Falta plata por el total de la cuenta.');
      return;
    }

    pay(
      linesAjustadas
        .map((line) => ({
          method: line.method,
          amountCents: parseAmount(line.amount),
          providerRef: null,
        }))
        .filter((line) => line.amountCents > 0),
      tipCents,
    );
    closeOrder();
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Cobrar"
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-wire border border-steel-dark bg-tile shadow-tray">
        <header className="border-b border-steel px-5 py-4">
          <h2 className="font-display text-base font-bold tracking-tight">Cobrar</h2>
        </header>

        {/*
          El total va antes que todo y en el tipo mas grande de la pantalla. Es lo
          unico que el mozo necesita que este bien alineado: si esta centrado o
          con el signo de currency pegado al numero, deja de leerse como columna y
          pasa a leerse como texto suelto.
        */}
        <div className="border-b border-steel bg-tile-warm px-5 py-4">
          <p className="text-xs font-semibold text-ink-soft">Total de la cuenta</p>
          <p className="tabular font-mono text-3xl font-semibold leading-tight">
            {formatMoney(money(withTip, currency))}
          </p>

          <div className="mt-2 space-y-0.5">
            <TicketTotal label="Subtotal" amountCents={totals.subtotalCents} currency={currency} />
            {totals.discountCents > 0 && (
              <TicketTotal
                label="Descuento"
                amountCents={-totals.discountCents}
                currency={currency}
                negative
              />
            )}
            {totals.serviceCents > 0 && (
              <TicketTotal label="Servicio" amountCents={totals.serviceCents} currency={currency} />
            )}
            {tipCents > 0 && (
              <TicketTotal label="Propina" amountCents={tipCents} currency={currency} />
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section aria-label="Lineas de pago">
            <h3 className="mb-2 text-xs font-semibold text-ink-soft">Como paga</h3>
            <div className="space-y-2">
              {linesAjustadas.map((line, index) => (
                <PaymentLineRow
                  key={`${line.method}-${index}`}
                  line={line}
                  currency={currency}
                  onChange={(amount) => {
                    setTocado(true);
                    patchLine(setLines, index, amount);
                  }}
                  onRemove={
                    linesAjustadas.length > 1
                      ? () => {
                          setTocado(true);
                          setLines(linesAjustadas.filter((_, i) => i !== index));
                        }
                      : undefined
                  }
                />
              ))}
            </div>

            {/*
              "Exacto" y "el resto en efectivo" son los dos presets que existen en
              todos los bares de la vida real. Lo demas (tarjeta, QR) se agregan
              tocando el metodo: agregar otra linea nunca es el camino por defecto.
            */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setTocado(true);
                  setLines([{ method: 'CASH', amount: (withTip / 100).toFixed(2) }]);
                }}
              >
                Exacto
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setTocado(true);
                  setLines([
                    { method: 'CASH', amount: (withTip / 100).toFixed(2) },
                    { method: 'CARD', amount: '0.00' },
                  ]);
                }}
              >
                Parte efectivo
              </Button>
            </div>

            <div className="mt-2 flex flex-wrap gap-1">
              {METHODS.map(({ method, label }) => (
                <Button
                  key={method}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTocado(true);
                    setLines([...linesAjustadas, { method, amount: '0.00' }]);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </section>

          <section aria-label="Propina" className="mt-5">
            <h3 className="mb-2 text-xs font-semibold text-ink-soft">Propina</h3>
            <div className="grid grid-cols-3 gap-2">
              {tips.map((tip, index) => (
                <button
                  key={index}
                  type="button"
                  aria-pressed={tipCents === tip.cents}
                  onClick={() => setTipCents(tipCents === tip.cents ? 0 : tip.cents)}
                  className={cn(
                    'flex min-h-touch flex-col items-center justify-center rounded-wire border px-2',
                    'transition-[background-color,border-color,color] duration-80',
                    tipCents === tip.cents
                      ? 'border-azulejo-deep bg-azulejo text-tile'
                      : 'border-steel bg-tile text-ink hover:border-steel-dark hover:bg-tile-warm',
                  )}
                >
                  <span className="text-xs font-semibold">{TIP_BPS[index]! / 100}%</span>
                  <span className="tabular font-mono text-sm">
                    {formatMoney(money(tip.cents, currency))}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {error && (
            <div className="mt-4">
              <FormError>{error}</FormError>
            </div>
          )}
        </div>

        <footer className="space-y-2 border-t border-steel bg-tile-warm px-5 py-3">
          {/*
            El vuelto se anuncia antes de confirmar, no despues. Si hay vuelto, la
            accion principal pasa a ser "Entregar vuelto": el mozo no tiene que
            hacer una resta mental a las once de la noche para saber cuanto dar.
          */}
          {changeCents > 0 && (
            <p className="tabular text-sm text-ink">
              Vuelto{' '}
              <span className="font-mono text-base font-semibold">
                {formatMoney(money(changeCents, currency))}
              </span>
            </p>
          )}

          {/*
              `shrink-0` en el boton de volver y `flex-1` en el de cobrar: sin eso el
              boton largo ("Entregar $ 15.380") parte el texto en dos lineas y la
              accion principal del turno queda mas baja que la secundaria.
            */}
          <div className="flex gap-2">
            <Button className="shrink-0" onClick={onClose}>
              Volver
            </Button>
            <Button
              variant="primary"
              size="lg"
              className="min-w-0 flex-1"
              disabled={chargedCents < withTip}
              onClick={settle}
            >
              {changeCents > 0
                ? `Entregar ${formatMoney(money(changeCents, currency))}`
                : 'Cobro registrado'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Una linea de pago: metodo e importe. */
function PaymentLineRow({
  line,
  currency,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  currency: string;
  onChange: (amount: string) => void;
  onRemove?: () => void;
}): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 font-display text-sm font-semibold text-ink">
        {METHODS.find((m) => m.method === line.method)?.label ?? line.method}
      </span>

      <div className="relative flex-1">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-ink-soft">
          $
        </span>
        <input
          value={line.amount}
          onChange={(event) => onChange(event.target.value.replace(',', '.'))}
          inputMode="decimal"
          aria-label={`Importe en ${line.method}`}
          className={[
            'tabular min-h-touch w-full rounded-wire border border-steel bg-tile pl-7 pr-3',
            'font-mono text-base font-semibold transition-[border-color] duration-80',
          ].join(' ')}
        />
      </div>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Sacar esta linea"
          className="min-h-touch rounded-wire border border-steel px-3 font-display text-sm font-semibold text-ink-soft transition-[background-color,border-color] duration-80 hover:bg-tile-warm hover:text-ink"
        >
          Sacar
        </button>
      )}

      <span className="tabular hidden w-20 text-right font-mono text-2xs text-ink-faint sm:block">
        {formatMoney(money(parseAmount(line.amount), currency))}
      </span>
    </div>
  );
}

/**
 * Reemplaza el importe de una linea.
 *
 * El array se reconstruye entero en vez de mutarse: el estado de React se compara
 * por referencia, y mutar un array en el lugar hace que el componente no se repinte
 * y el importe tipeado no aparezca.
 */
function patchLine(
  setLines: (updater: (current: DraftLine[]) => DraftLine[]) => void,
  index: number,
  amount: string,
): void {
  setLines((current) => current.map((line, i) => (i === index ? { ...line, amount } : line)));
}

/**
 * Texto tipeado a centavos.
 *
 * Se parsea por el mismo camino que `fromMajorUnits` del dominio, no con
 * `parseFloat(amount) * 100`: en punto flotante, 8.115 * 100 puede dar
 * 811.4999999999999 y el redondeo siguiente devuelve 811 en vez de 812. Ese centavo
 * es la diferencia entre el total que se dice y el que se cobra.
 */
function parseAmount(text: string): number {
  const cleaned = text.trim().replace(/[^0-9.,-]/g, '');
  if (cleaned.length === 0) return 0;

  const [units = '0', cents = ''] = cleaned.split('.');
  const padded = cents.padEnd(2, '0').slice(0, 2);
  const sign = units.startsWith('-') ? -1 : 1;
  const value = Math.abs(Number(units) || 0) * 100 + Number(padded || '0');
  return Number.isFinite(value) ? sign * Math.round(value) : 0;
}
