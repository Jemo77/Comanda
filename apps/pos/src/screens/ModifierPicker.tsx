import { useMemo, useState, type ReactElement } from 'react';
import { Button, FormError, cn } from '@comanda/ui';
import { formatMoney, money } from '@comanda/domain';
import type { ProductWithModifiers } from '@comanda/domain';
import type { SelectedModifier } from '../state/order';

/**
 * Grupo de modificadores con sus modificadores adentro.
 *
 * Es la forma de `productWithModifiersSchema`: el dominio ya la define y el POS la
 * reusa en vez de declarar su propia. Si el dominio agrega un campo al grupo, el
 * selector lo recibe sin cambios en vez de compilar y mentir.
 */
type PickerGroup = ProductWithModifiers['groups'][number];

/**
 * Selector de modificadores.
 *
 * Aparece solo cuando el producto tiene grupos. Es una lamina sobre la pantalla,
 * no una pagina: el mozo entra a tocar una cosa y vuelve a la comanda, asi que
 * el cierre es un toque en cualquier lado del fondo y el boton de abajo dice
 * exactamente lo que va a pasar ("Agregar 2 · $ 8.400").
 *
 * El precio cambia **en vivo**, mientras se elige. Un selector que solo muestra el
 * total al final obliga al mozo a.calculate mentalmente mientras sirve, que es
 * justo lo que no se puede hacer con las manos ocupadas.
 *
 * `minSelect` y `maxSelect` se respetan aca y no solo en el servidor: un grupo
 * obligatorio que se puede dejar vacio produce un item que la cocina no puede hacer,
 * y se descubre cuando el plato vuelve.
 */

export interface ModifierPickerProps {
  product: ProductWithModifiers;
  currency: string;
  onConfirm: (modifiers: SelectedModifier[], note: string | null) => void;
  onCancel: () => void;
}

export function ModifierPicker({
  product,
  currency,
  onConfirm,
  onCancel,
}: ModifierPickerProps): ReactElement {
  // El indice es el id del modificador: seleccionarlo dos veces con dos "Sin hielo"
  // distintos tiene que ser una eleccion, no dos objetos identicos en un Set.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');

  const groups = useMemo(
    () => product.groups.filter((group) => group.modifiers.length > 0),
    [product.groups],
  );

  const chosen = useMemo(
    () => product.groups.flatMap((group) => group.modifiers).filter((m) => selected.has(m.id)),
    [product.groups, selected],
  );

  // Un modificador con delta negativo se descuenta del mismo modo que uno positivo:
  // "menos queso" baja el precio, "sin hielo" no lo cambia.
  const deltaCents = chosen.reduce((acc, modifier) => acc + modifier.priceDeltaCents, 0);
  const unitCents = product.priceCents + deltaCents;
  const totalCents = unitCents * quantity;

  // El primer grupo obligatorio incumplido. `null` cuando la eleccion es valida.
  const missing = groups.find((group) => group.minSelect > 0 && !hasSelections(group, selected));
  const complete = missing === undefined;

  const toggle = (group: PickerGroup, modifierId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(modifierId)) {
        next.delete(modifierId);
        return next;
      }
      // `maxSelect` recorta en lugar de rechazar: en un mostrador, un grupo que
      // ya esta lleno tiene que ignorar el toque extra, no ponerse en rojo y dejar
      // al mozo adivinando cual de los dos elegi mal.
      if (countIn(current, group) >= group.maxSelect) {
        const chosenInGroup = group.modifiers.filter((m) => current.has(m.id));
        const oldest = chosenInGroup[chosenInGroup.length - 1];
        if (oldest) next.delete(oldest.id);
      }
      next.add(modifierId);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Modificadores de ${product.name}`}
      onClick={(event) => {
        // Cerrar tocando el fondo: la lamina tiene que ser reversible con el mismo
        // gesto con la que se abrio.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-wire border border-steel-dark bg-tile shadow-tray">
        <header className="flex items-start justify-between gap-4 border-b border-steel px-4 py-3">
          <div>
            <h2 className="font-display text-lg font-bold tracking-tight">{product.name}</h2>
            <p className="tabular font-mono text-sm text-ink-soft">
              {formatMoney(money(product.priceCents, currency))}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cerrar
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {groups.map((group) => (
            <GroupSection
              key={group.id}
              group={group}
              currency={currency}
              selected={selected}
              onToggle={toggle}
            />
          ))}

          <label className="mt-5 block">
            <span className="text-xs font-semibold text-ink-soft">Nota para cocina</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={300}
              rows={2}
              placeholder="Sin cebolla, bien tostado..."
              className={[
                'mt-1.5 w-full resize-none rounded-wire border border-steel bg-tile px-3 py-2',
                'font-display text-sm placeholder:text-ink-faint',
                'transition-[border-color] duration-80',
              ].join(' ')}
            />
          </label>

          {!complete && missing && (
            <div className="mt-4">
              <FormError>Elegí {missing.name.toLowerCase()}: es obligatorio.</FormError>
            </div>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-steel bg-tile-warm px-4 py-3">
          <QuantityStepper quantity={quantity} onChange={setQuantity} />

          <Button
            variant="primary"
            size="lg"
            className="flex-1"
            disabled={!complete}
            onClick={() =>
              onConfirm(
                chosen.map((modifier) => ({
                  modifierId: modifier.id,
                  name: modifier.name,
                  priceDeltaCents: modifier.priceDeltaCents,
                })),
                note.length > 0 ? note : null,
              )
            }
          >
            <span className="flex w-full items-center justify-between gap-4">
              <span>Agregar {quantity > 1 ? `${quantity} ` : ''}</span>
              <span className="tabular font-mono">{formatMoney(money(totalCents, currency))}</span>
            </span>
          </Button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Un grupo de modificadores.
 *
 * El encabezado dice cuantos hay que elegir y cuantos como maximo, porque el mozo
 * no puede adivinarlo: "Extras" sin tope accepte una pizza con seis cosas.
 */
function GroupSection({
  group,
  currency,
  selected,
  onToggle,
}: {
  group: PickerGroup;
  currency: string;
  selected: ReadonlySet<string>;
  onToggle: (group: PickerGroup, modifierId: string) => void;
}): ReactElement {
  const chosen = countIn(selected, group);

  return (
    <fieldset className="mb-5 last:mb-0">
      <legend className="mb-2 flex w-full items-baseline justify-between gap-3">
        <span className="text-xs font-semibold text-ink">{group.name}</span>
        <span className="text-2xs text-ink-faint">{groupRule(group, chosen)}</span>
      </legend>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {group.modifiers.map((modifier) => {
          const on = selected.has(modifier.id);
          return (
            <button
              key={modifier.id}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(group, modifier.id)}
              className={cn(
                'flex min-h-touch items-center justify-between gap-2 rounded-wire border px-3 py-2',
                'text-left font-display text-sm font-semibold',
                'transition-[background-color,border-color,color] duration-80',
                on
                  ? 'border-azulejo-deep bg-azulejo text-tile'
                  : 'border-steel bg-tile text-ink hover:border-steel-dark hover:bg-tile-warm',
              )}
            >
              <span className="min-w-0 truncate">{modifier.name}</span>
              {modifier.priceDeltaCents !== 0 && (
                <span
                  className={cn(
                    'tabular shrink-0 font-mono text-2xs',
                    on ? 'text-tile/85' : 'text-ink-faint',
                  )}
                >
                  {modifier.priceDeltaCents > 0 ? '+' : '−'}
                  {formatMoney(money(Math.abs(modifier.priceDeltaCents), currency), 'es-AR', {
                    showSymbol: false,
                  })}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Cantidad del item.
 *
 * El POS es de una sola mano: se sube y se baja con dos botones grandes al lado del
 * confirmar, no con un teclado numerico que tapa la comanda.
 */
function QuantityStepper({
  quantity,
  onChange,
}: {
  quantity: number;
  onChange: (quantity: number) => void;
}): ReactElement {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Restar uno"
        disabled={quantity <= 1}
        onClick={() => onChange(quantity - 1)}
        className="h-14 w-14 rounded-wire border border-steel bg-tile font-display text-xl font-semibold text-ink transition-[background-color,border-color] duration-80 hover:bg-tile-warm disabled:pointer-events-none disabled:opacity-40"
      >
        −
      </button>
      <span className="tabular w-10 text-center font-mono text-xl font-semibold">{quantity}</span>
      <button
        type="button"
        aria-label="Sumar uno"
        disabled={quantity >= 99}
        onClick={() => onChange(quantity + 1)}
        className="h-14 w-14 rounded-wire border border-steel bg-tile font-display text-xl font-semibold text-ink transition-[background-color,border-color] duration-80 hover:bg-tile-warm disabled:pointer-events-none disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}

/** "Elegí 1" / "Hasta 3" / "Opcional". El texto del limite, no un numero suelto. */
function groupRule(group: PickerGroup, chosen: number): string {
  if (group.minSelect > 0 && group.maxSelect === 1) return `Elegi 1 · ${chosen}`;
  if (group.minSelect > 0) return `Elegi ${group.minSelect} · ${chosen}`;
  if (group.maxSelect > 1) return `Hasta ${group.maxSelect} · ${chosen}`;
  return 'Opcional';
}

/** Cuantos del grupo hay seleccionados. */
function countIn(selected: ReadonlySet<string>, group: PickerGroup): number {
  let total = 0;
  for (const modifier of group.modifiers) if (selected.has(modifier.id)) total += 1;
  return total;
}

/** El grupo tiene al menos una seleccion. */
function hasSelections(group: PickerGroup, selected: ReadonlySet<string>): boolean {
  return countIn(selected, group) > 0;
}
