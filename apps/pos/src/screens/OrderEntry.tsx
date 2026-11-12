import { useMemo, useState, type ReactElement } from 'react';
import { Button, StatusPill, TicketLine, TicketRule, TicketTotal, cn } from '@comanda/ui';
import { formatMoney, money, type ProductWithModifiers } from '@comanda/domain';
import { db, type LocalCategory } from '../data/db';
import { EmptyState, useLiveTable } from '../data/useLiveTable';
import { itemTotalCents, useOrder, useTotals } from '../state/order';
import { ModifierPicker } from './ModifierPicker';
import { PaymentSheet } from './PaymentSheet';
import { VoidSheet } from './VoidSheet';

/**
 * Pantalla de comanda: la carta al lado y el rollo de papel termico.
 *
 * Dos superficies que no se mezclan. La **carta** es donde se elige (botones
 * grandes, nombres y precios que se comparan de un vistazo) y el **rollo** es donde
 * se lee lo que ya se pidio, con la guia de puntos que codifica la columna de
 * precios. Meter el rollo en el medio de la carta haria que el mozo no supiera
 * donde esta lo que ya agrego, y esa es la unica pregunta que esta pantalla
 * responde.
 */
export function OrderEntry({ currency }: { currency: string }): ReactElement {
  const order = useOrder((state) => state.order);
  const addItem = useOrder((state) => state.addItem);
  const voidItem = useOrder((state) => state.voidItem);
  const requestBill = useOrder((state) => state.requestBill);
  const totals = useTotals();

  // La carta se lee viva: se hidrata despues del login, y con una lectura de
  // montaje la grilla quedaria vacia aunque la carta este.
  const categories = useLiveTable<LocalCategory>(() => db.categories.orderBy('sort').toArray(), []);
  const products = useLiveTable<ProductWithModifiers>(() => db.products.toArray(), []);

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [pending, setPending] = useState<ProductWithModifiers | null>(null);
  const [voiding, setVoiding] = useState<{ id: string; label: string } | null>(null);
  const [paying, setPaying] = useState(false);

  const visible = useMemo(
    () =>
      products.filter(
        (product) => product.categoryId === (activeCategoryId ?? categories[0]?.id ?? null),
      ),
    [products, activeCategoryId, categories],
  );

  if (!order) {
    return (
      <section className="flex min-h-0 flex-1 flex-col">
        <EmptyState pill="Sin mesa abierta">
          Elegi una mesa del salon para empezar a tomar el pedido.
        </EmptyState>
      </section>
    );
  }

  /**
   * Agregar un producto.
   *
   * Si tiene grupos de modificadores abre el selector; si no, entra directo. El caso
   * sin modificadores es el mayoritario (una pizza, una lata) y pedirle al mozo que
   * confirme un selector vacio para un agua mineral es una friccion en cada venta.
   */
  const add = (product: ProductWithModifiers): void => {
    if (product.groups.length > 0) {
      setPending(product);
      return;
    }
    addItem(
      {
        id: product.id,
        categoryId: product.categoryId,
        name: product.name,
        priceCents: product.priceCents,
        stationId: product.stationId,
      },
      [],
      null,
      1,
    );
  };

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <ProductGrid
          categories={categories}
          products={visible}
          activeCategoryId={activeCategoryId ?? categories[0]?.id ?? null}
          currency={currency}
          hasCatalog={products.length > 0}
          onCategory={setActiveCategoryId}
          onPick={add}
        />

        <TicketRoll
          currency={currency}
          tableLabel={order.tableLabel}
          guests={order.guests}
          askedForBill={order.status === 'PEDIDO_CUENTA'}
          onVoid={(item) => setVoiding({ id: item.id, label: item.name })}
          onAskBill={requestBill}
          onPay={() => setPaying(true)}
        />
      </div>

      {pending && (
        <ModifierPicker
          product={pending}
          currency={currency}
          onCancel={() => setPending(null)}
          onConfirm={(modifiers, note) => {
            addItem(
              {
                id: pending.id,
                categoryId: pending.categoryId,
                name: pending.name,
                priceCents: pending.priceCents,
                stationId: pending.stationId,
              },
              modifiers,
              note,
              1,
            );
            setPending(null);
          }}
        />
      )}

      {voiding && (
        <VoidSheet
          label={voiding.label}
          onCancel={() => setVoiding(null)}
          onConfirm={(reason) => {
            voidItem(voiding.id, reason);
            setVoiding(null);
          }}
        />
      )}

      {paying && (
        <PaymentSheet currency={currency} totals={totals} onClose={() => setPaying(false)} />
      )}
    </>
  );
}

/**
 * Carta: la grilla de productos de la categoria activa.
 *
 * Tres columnas en desktop y dos en tablet. Menos de dos en una tablet de 8" obliga
 * a scrollear cada dos toques, y el mozo esta parado: el scroll le cuesta tiempo en
 * cada producto.
 */
function ProductGrid({
  categories,
  products,
  activeCategoryId,
  currency,
  hasCatalog,
  onCategory,
  onPick,
}: {
  categories: readonly LocalCategory[];
  products: readonly ProductWithModifiers[];
  activeCategoryId: string | null;
  currency: string;
  hasCatalog: boolean;
  onCategory: (categoryId: string) => void;
  onPick: (product: ProductWithModifiers) => void;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/*
        Las categorias van arriba de la carta y no en el spine, porque el spine ya
        lo ocupa la navegacion del turno (mesas, comanda, cocina). Repetir el mismo
        nombre en dos lugares hace que el mozo dude de cual de los dos cambia.
      */}
      <nav
        aria-label="Categorias"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-steel bg-tile px-3 py-2"
      >
        {categories.map((category) => (
          <button
            key={category.id}
            type="button"
            onClick={() => onCategory(category.id)}
            aria-current={category.id === activeCategoryId ? 'page' : undefined}
            className={cn(
              'min-h-touch shrink-0 rounded-wire border px-3 font-display text-xs font-semibold',
              'transition-[background-color,border-color,color] duration-80',
              category.id === activeCategoryId
                ? 'border-ink bg-ink text-tile'
                : 'border-steel bg-tile text-ink-soft hover:border-steel-dark hover:text-ink',
            )}
          >
            {category.name}
          </button>
        ))}
      </nav>

      <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-3 lg:grid-cols-3">
        {products.map((product) => (
          <ProductButton
            key={product.id}
            product={product}
            currency={currency}
            onPick={() => onPick(product)}
          />
        ))}

        {products.length === 0 && hasCatalog && (
          <p className="col-span-full py-12 text-center text-sm text-ink-faint">
            Esta categoria todavia no tiene productos cargados.
          </p>
        )}

        {/*
          Sin carta no se dice "no hay productos", que el mozo lee como "se
          agotaron": se dice que la carta no esta cargada, que es un problema del
          local y no del turno. Un mostrador vendiendo sobre una carta vacia es un
          local cerrado.
        */}
        {!hasCatalog && (
          <div className="col-span-full flex justify-center py-12">
            <EmptyState pill="Carta sin cargar">
              Este local todavia no tiene la carta en el POS. Con conexion se carga sola; sin ella,
              pedile al encargado que la cargue.
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Boton de producto.
 *
 * El precio va abajo, en mono y a la derecha: es la columna que el mozo compara
 * entre dos productos antes de decidir, y para que sea una columna tiene que estar
 * siempre en el mismo lugar.
 *
 * Un producto con modificadores lleva una marca: sin ella, el mozo lo agrega sin
 * elegir la leche y la cocina lo devuelve.
 */
function ProductButton({
  product,
  currency,
  onPick,
}: {
  product: ProductWithModifiers;
  currency: string;
  onPick: () => void;
}): ReactElement {
  const hasModifiers = product.groups.length > 0;

  return (
    <button
      type="button"
      disabled={!product.available}
      onClick={onPick}
      className={cn(
        'flex min-h-touch flex-col justify-between gap-2 rounded-wire border p-3 text-left',
        'transition-[background-color,border-color] duration-80',
        product.available
          ? 'border-steel bg-tile hover:border-steel-dark hover:bg-tile-warm'
          : 'border-steel bg-enamel-deep opacity-50',
      )}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="font-display text-sm font-semibold leading-snug">{product.name}</span>
        {hasModifiers && (
          <span
            aria-hidden
            title="Tiene modificadores"
            className="mt-0.5 h-2 w-2 shrink-0 rounded-full border border-azulejo bg-azulejo"
          />
        )}
      </span>
      <span className="tabular font-mono text-sm text-ink-soft">
        {formatMoney(money(product.priceCents, currency))}
      </span>
    </button>
  );
}

/**
 * El rollo de comanda.
 *
 * Papel termico: sin radio, con lineas de tinta y la guia de puntos de
 * `TicketLine`. La lista se lee de arriba hacia abajo como un comprobante impreso, y
 * por eso lo mas reciente queda al final y no arriba.
 */
function TicketRoll({
  currency,
  tableLabel,
  guests,
  askedForBill,
  onVoid,
  onAskBill,
  onPay,
}: {
  currency: string;
  tableLabel: string | null;
  guests: number;
  askedForBill: boolean;
  onVoid: (item: { id: string; name: string }) => void;
  onAskBill: () => void;
  onPay: () => void;
}): ReactElement {
  const items = useOrder((state) => state.items);
  const setCourse = useOrder((state) => state.setCourse);
  const setSeat = useOrder((state) => state.setSeat);
  const totals = useTotals();
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const active = items.filter((item) => item.status === 'ACTIVE');

  return (
    <div className="flex w-[22rem] shrink-0 flex-col border-l border-steel bg-tile">
      <header className="flex items-center justify-between gap-2 border-b border-steel px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-base font-bold tracking-tight">
            {tableLabel ? `Mesa ${tableLabel}` : 'Comanda'}
          </h2>
          <p className="text-2xs text-ink-soft">{guests} comensales</p>
        </div>
        {askedForBill && <StatusPill tone="pending">Pidio cuenta</StatusPill>}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {items.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-faint">Todavia no pediste nada.</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="relative">
              <TicketLine
                quantity={item.quantity}
                totalCents={itemTotalCents(item)}
                currency={currency}
                voided={item.status === 'VOIDED'}
                note={item.note ?? undefined}
                badge={
                  // El menu de la linea vive a la izquierda del nombre: tocar la linea
                  // es lo que el mozo quiere hacer, y el menu aparece ahi sin tapar
                  // el texto que esta leyendo.
                  <button
                    type="button"
                    aria-expanded={menuFor === item.id}
                    aria-label={`Acciones de ${item.name}`}
                    disabled={item.status === 'VOIDED'}
                    onClick={() => setMenuFor((current) => (current === item.id ? null : item.id))}
                    className={cn(
                      'mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-wire',
                      'border transition-[background-color,border-color] duration-80',
                      'disabled:pointer-events-none disabled:opacity-30',
                      menuFor === item.id
                        ? 'border-ink bg-ink text-tile'
                        : 'border-steel-dark bg-transparent text-ink-soft hover:bg-tile-warm hover:text-ink',
                    )}
                  >
                    <span aria-hidden className="text-xs leading-none">
                      ⋮
                    </span>
                  </button>
                }
              >
                <span className="block">{item.name}</span>
                {item.modifiers.length > 0 && (
                  <span className="block text-2xs leading-snug text-ink-soft">
                    {item.modifiers.map((modifier) => modifier.name).join(' · ')}
                  </span>
                )}
                {item.status === 'VOIDED' && item.voidReason && (
                  <span className="block text-2xs leading-snug text-coca">
                    Anulado · {item.voidReason}
                  </span>
                )}
              </TicketLine>

              {menuFor === item.id && (
                <LineActions
                  course={item.course}
                  seat={item.seat}
                  onClose={() => setMenuFor(null)}
                  onCourse={() => {
                    // Un item alterna entre curso 1 y 2. Es el unico gesto posible con
                    // una sola mano mientras se sirve: "esto va con lo otro".
                    setCourse(item.course === 1 ? 2 : 1);
                    setMenuFor(null);
                  }}
                  onSeat={() => {
                    // Sin numero de comensal visible en esta version, la unica
                    // asignacion que se puede deshacer con un toque es "sin
                    // asignar": la deja lista para dividir la cuenta por item.
                    setSeat(null);
                    setMenuFor(null);
                  }}
                  onVoid={() => {
                    onVoid({ id: item.id, name: item.name });
                    setMenuFor(null);
                  }}
                />
              )}
            </div>
          ))
        )}

        <TicketRule />

        <div className="space-y-1">
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
          <TicketTotal label="Total" amountCents={totals.totalCents} currency={currency} emphasis />
        </div>
      </div>

      {/*
        Las acciones de la comanda van abajo del rollo y no arriba: arriba esta lo que
        el mozo quiere leer, abajo lo que quiere hacer con lo que leyo.
      */}
      <footer className="space-y-2 border-t border-steel bg-tile-warm px-3 py-3">
        {!askedForBill && active.length > 0 && (
          <Button block onClick={onAskBill}>
            Pidio la cuenta
          </Button>
        )}

        <Button variant="primary" size="lg" block onClick={onPay} disabled={active.length === 0}>
          Cobrar
        </Button>
      </footer>
    </div>
  );
}

/**
 * Acciones de una linea del ticket.
 *
 * **"Anular" es el unico boton destructivo del menu y va solo, en rojo coca.** Al
 * lado de "Cambiar curso" y "Sin asignar", que son reversibles, un boton rojo se
 * lee como parte del grupo y el mozo lo toca sin querer. Solo en `coca` dice lo que
 * es; solo con la cinta de caution avisa que no se puede deshacer.
 */
function LineActions({
  course,
  seat,
  onClose,
  onCourse,
  onSeat,
  onVoid,
}: {
  course: number;
  seat: number | null;
  onClose: () => void;
  onCourse: () => void;
  onSeat: () => void;
  onVoid: () => void;
}): ReactElement {
  return (
    <div className="z-10 mb-1 flex flex-col gap-1 rounded-wire border border-steel-dark bg-tile p-1 shadow-lift">
      <button
        type="button"
        onClick={onCourse}
        className="min-h-touch rounded-wire px-3 text-left font-display text-xs font-semibold text-ink transition-colors duration-80 hover:bg-tile-warm"
      >
        {course === 1 ? 'Pasar al segundo servicio' : 'Volver al primer servicio'}
      </button>
      <button
        type="button"
        onClick={onSeat}
        disabled={seat === null}
        className="min-h-touch rounded-wire px-3 text-left font-display text-xs font-semibold text-ink transition-colors duration-80 hover:bg-tile-warm disabled:opacity-40"
      >
        Sacar de cualquier asignacion de asiento
      </button>

      <button
        type="button"
        onClick={onVoid}
        className="min-h-touch rounded-wire border border-coca/50 bg-coca-soft px-3 text-left font-display text-xs font-semibold text-coca transition-colors duration-80 hover:bg-coca hover:text-tile"
      >
        Anular este item
      </button>

      <button
        type="button"
        onClick={onClose}
        className="min-h-touch rounded-wire px-3 text-left font-display text-xs text-ink-faint transition-colors duration-80 hover:bg-tile-warm"
      >
        Cerrar
      </button>
    </div>
  );
}
