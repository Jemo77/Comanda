import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Button, StatusPill, cn } from '@comanda/ui';
import { db, type LocalKitchenTicket } from '../data/db';
import { enqueueEvent } from '../data/sync';
import { connectRealtime, realtimeStatus } from '../state/realtime';
import { useSession } from '../state/session';

/**
 * Pantalla de cocina (KDS).
 *
 * Se lee a dos metros, de pie, con extractor encima y ruido de la barra. De ahi
 * salen tres reglas que no se negocian:
 *
 *  1. **Letra grande y poco texto.** El cocinero no lee, reconoce. Un ticket con
 *     el nombre del producto en 18px y la nota de "sin sal" en 30px invertidos.
 *  2. **Botones enormes.** El avance de estado es el gesto mas repetido del turno.
 *  3. **Orden por hora.** Lo que entro primero sale primero: un ticket nuevo abajo
 *     no tapa el que ya estaba esperando.
 *
 * El ciclo es NEW -> PREPARANDO -> LISTO -> SERVED y **solo avanza**. Un ticket que
 * vuelve a NEW pasa dos veces por la pantalla de cocina, y el que lo esta haciendo
 * cree que es otro: un plato doble sale una vez de mas.
 */

/** Siguiente estado del ciclo. El ultimo estado no tiene siguiente. */
const NEXT_STATUS: Record<LocalKitchenTicket['status'], LocalKitchenTicket['status'] | null> = {
  NEW: 'PREPARING',
  PREPARING: 'READY',
  READY: 'SERVED',
  SERVED: null,
};

/** Como se llama la accion de cada estado. Verbo en primera persona del local. */
const ACTION_LABEL: Record<LocalKitchenTicket['status'], string> = {
  NEW: 'Empezar',
  PREPARING: 'Terminar',
  READY: 'Servir',
  SERVED: 'Servido',
};

/** Minutos despues de los cuales un ticket sin empezar se pinta de advertencia. */
const LATE_MINUTES = 20;

export function Kitchen(): ReactElement {
  const [tickets, setTickets] = useState<LocalKitchenTicket[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [enVivo, setEnVivo] = useState<boolean>(() => realtimeStatus() === 'conectado');
  const user = useSession((state) => state.user);

  // Los tickets salen de la replica local. El KDS tiene que ver un ticket sin
  // internet: si el socket o la red se caen, el ticket igual esta en IndexedDB
  // porque el POS lo escribio al agregar el item.
  useEffect(() => {
    let alive = true;

    const reload = async (): Promise<void> => {
      const loaded = await db.kitchenTickets.orderBy('createdAt').toArray();
      if (alive) setTickets(loaded);
    };

    void reload();
    // Se relee cada 5 segundos. El ciclo de sincronizacion del POS corre cada 20, asi
    // que un ticket que llego de otra tablet podria tardar medio minuto en aparecer;
    // este intervalo es la red de seguridad cuando no hay socket.
    const interval = window.setInterval(() => void reload(), 5_000);

    // Y el socket, que lamayoria de las veces es el que avisa primero. El socket **no**
    // trae el ticket: dispara el mismo `reload` de arriba. La replica local sigue
    // siendo la fuente de verdad, y este es el unico efecto que el socket puede tener
    // (ver `state/realtime.ts`).
    const realtime = connectRealtime({
      venueId: user?.venueId ?? null,
      handlers: {
        onKdsEvent: () => void reload(),
        // El estado de la conexion se guarda en estado local para que el pill del
        // encabezado se repinte. `realtimeStatus()` solo, sin esto, no cambia nunca:
        // se lee en el render y no hay nada que dispare otro render.
        onStatus: (status) => setEnVivo(status === 'conectado'),
      },
    });

    return () => {
      alive = false;
      window.clearInterval(interval);
      realtime?.close();
    };
  }, [user?.venueId]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, []);

  const byStation = useMemo(() => {
    const groups = new Map<string, LocalKitchenTicket[]>();
    for (const ticket of tickets) {
      const bucket = groups.get(ticket.stationId);
      if (bucket) bucket.push(ticket);
      else groups.set(ticket.stationId, [ticket]);
    }
    return [...groups.entries()].map(([stationId, list]) => ({
      stationId,
      name: list[0]?.stationName ?? 'Estacion',
      tickets: list,
    }));
  }, [tickets]);

  const advance = (ticket: LocalKitchenTicket): void => {
    const next = NEXT_STATUS[ticket.status];
    if (!next) return;

    // Escritura optimista igual que en la comanda: la cocina ve el cambio ya, sin
    // esperar al ciclo de sincronizacion.
    void db.kitchenTickets.update(ticket.id, { status: next });
    setTickets((current) =>
      current.map((candidate) =>
        candidate.id === ticket.id ? { ...candidate, status: next } : candidate,
      ),
    );

    void enqueueEvent('KDS_STATUS_SET', {
      ticketId: ticket.id,
      stationId: ticket.stationId,
      status: next,
    });

    // El ticket servido sale de la pantalla: no hay que limpiarlo a mano y el que
    // esta lavando no ve un papel viejo que ignorar.
    if (next === 'SERVED') {
      void db.kitchenTickets.delete(ticket.id);
      setTickets((current) => current.filter((candidate) => candidate.id !== ticket.id));
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Cocina">
      <header className="flex shrink-0 items-end justify-between gap-4 border-b border-steel bg-tile px-4 py-3">
        <div>
          <h1 className="font-display text-lg font-bold tracking-tight">Cocina</h1>
          <p className="text-xs text-ink-soft">
            {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'} pendientes
          </p>
        </div>

        {/*
          El estado del tiempo real se muestra aunque no haya socket: el que esta en
          cocina tiene que saber si lo que ve esta al dia o es de hace medio minuto.
          Decir "sincroniza cada 5 s" es honesto; no mostrar nada deja pensar que la
          pantalla esta al dia.
        */}
        <StatusPill tone={enVivo ? 'open' : 'muted'}>
          {enVivo ? 'En vivo' : 'Sincroniza cada 5 s'}
        </StatusPill>
      </header>

      {byStation.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-ink-faint">No hay nada para hacer.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto p-3">
          <div className="flex h-full gap-3" style={{ minWidth: `${byStation.length * 22}rem` }}>
            {byStation.map((station) => (
              <StationColumn
                key={station.stationId}
                name={station.name}
                tickets={station.tickets}
                now={now}
                onAdvance={advance}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** Una columna por estacion: barra, cocina, cafe. */
function StationColumn({
  name,
  tickets,
  now,
  onAdvance,
}: {
  name: string;
  tickets: readonly LocalKitchenTicket[];
  now: number;
  onAdvance: (ticket: LocalKitchenTicket) => void;
}): ReactElement {
  return (
    <div className="flex w-80 shrink-0 flex-col">
      <h2 className="mb-2 font-display text-xs font-semibold text-ink-soft">{name}</h2>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {tickets.map((ticket) => (
          <KitchenTicketCard
            key={ticket.id}
            ticket={ticket}
            now={now}
            onAdvance={() => onAdvance(ticket)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Ticket de cocina.
 *
 * Es papel de comanda, no una tarjeta de app: sin radio, con filete de acero y el
 * contenido en la tipografia del ticket. El unico elemento de color es el borde de
 * estado, que es el estado y nada mas.
 */
function KitchenTicketCard({
  ticket,
  now,
  onAdvance,
}: {
  ticket: LocalKitchenTicket;
  now: number;
  onAdvance: () => void;
}): ReactElement {
  const minutes = Math.max(0, Math.floor((now - Date.parse(ticket.createdAt)) / 60_000));
  const late = ticket.status === 'NEW' && minutes >= LATE_MINUTES;

  return (
    <article
      className={cn(
        'flex flex-col border-l-4 bg-tile',
        'border-t border-r border-b border-steel',
        ticket.status === 'READY' && 'border-l-abierto',
        ticket.status === 'PREPARING' && 'border-l-azulejo',
        ticket.status === 'NEW' && 'border-l-ink',
        late && 'border-l-caution',
      )}
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-dashed border-steel px-3 py-2">
        <span className="font-display text-xl font-bold leading-none">
          {ticket.tableLabel ?? ticket.orderNumberLabel}
        </span>
        <span
          className={cn(
            'tabular font-mono text-sm leading-none',
            late ? 'font-semibold text-coca' : 'text-ink-soft',
          )}
        >
          {minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}` : `${minutes} min`}
        </span>
      </header>

      <ul className="flex-1 px-3 py-2">
        {ticket.lines.map((line) => (
          <li key={line.itemId} className="border-b border-steel py-1.5 last:border-b-0">
            <p className="font-display text-lg font-bold leading-tight">
              <span className="tabular mr-1 font-mono">{line.quantity}x</span>
              {line.name}
            </p>
            {line.modifiers.length > 0 && (
              <p className="font-display text-base font-semibold leading-tight text-ink-soft">
                {line.modifiers.join(' · ')}
              </p>
            )}
            {line.note && (
              // La nota del mozo es lo mas importante del ticket despues del
              // producto: va en el tamano del nombre y en tinta fuerte, porque es
              // la linea que evita que el plato vuelva.
              <p className="mt-0.5 font-display text-base font-semibold leading-tight text-coca">
                {line.note}
              </p>
            )}
          </li>
        ))}
      </ul>

      <footer className="border-t border-steel px-2 py-2">
        {ticket.status === 'SERVED' ? (
          <p className="px-2 py-2 text-center font-display text-sm font-semibold text-ink-faint">
            Servido
          </p>
        ) : (
          <Button
            block
            size="lg"
            variant={ticket.status === 'READY' ? 'primary' : 'secondary'}
            onClick={onAdvance}
          >
            {ACTION_LABEL[ticket.status]}
          </Button>
        )}
      </footer>
    </article>
  );
}
