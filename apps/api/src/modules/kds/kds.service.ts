import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ERROR_CODES,
  KitchenStatus,
  problemDetails,
  uuidv7,
  type KitchenTicket,
  type Station,
} from '@comanda/domain';
import type { Database } from '../../database/database.service';
import type { PoolClient } from 'pg';
// Import de VALOR, no `import type`: `emitDecoratorMetadata` escribe el tipo real del
// segundo argumento del constructor y Nest lo necesita para resolverlo. El mismo
// criterio que en `sync.service.ts` y `orders.service.ts`.
import { AuditService } from '../audit/audit.service';
import { KdsEventBus } from './kds-event-bus';
import {
  DEFAULT_KDS_STATUSES,
  KITCHEN_CYCLE,
  type KdsBoard,
  type ListTicketsQuery,
} from './kds.types';

/**
 * Cocina: los tickets que hay que hacer y por quien.
 *
 * Igual que en `orders` y `tables`, ningun SELECT filtra por `org_id`: lo hace la RLS.
 * Lo que la RLS **no** cubre es el local (las policies son por organizacion), asi que
 * toda consulta que tiene el local de la sesion lo trae en el `WHERE` a proposito. Un
 * KDS abierto que ve los tickets de la sucursal de al lado no es un bug de permisos:
 * es una fila que el filtro de local dejo pasar.
 *
 * El ciclo `NEW -> PREPARING -> READY -> SERVED` **solo avanza**, y la regla vive
 * aca y no en la base porque es una politica del turno, no una integridad: un ticket
 * que vuelve a NEW pasa dos veces por la pantalla de la cocina y el que lo esta
 * haciendo cree que es otro. Un plato doble sale una vez de mas.
 */

/** Fila de `kitchen_tickets` con lo que la pantalla necesita de la comanda. */
interface TicketRow {
  id: string;
  station_id: string;
  order_id: string;
  status: KitchenStatus;
  priority: number;
  created_at: Date | string;
  number_label: string;
  table_label: string | null;
  station_name: string;
}

/** Fila de `stations`. */
interface StationRow {
  id: string;
  venue_id: string;
  name: string;
  kind: Station['kind'];
  printer_target: string | null;
  sort: number;
  active: boolean;
}

/**
 * Proyeccion de un ticket.
 *
 * El `LEFT JOIN` a `tables` trae la etiqueta de la mesa en la misma fila: la
 * pantalla de cocina muestra "Mesa 4 - A-104" y con la mesa en otra consulta un local
 * con veinte mesas seriam veinte viajes extra por refresco.
 */
const TICKET_SELECT = `
  SELECT kt.id, kt.station_id, kt.order_id, kt.status, kt.priority, kt.created_at,
         o.number_label, t.label AS table_label, s.name AS station_name
    FROM kitchen_tickets kt
    JOIN orders o ON o.id = kt.order_id
    LEFT JOIN tables t ON t.id = o.table_id
    LEFT JOIN stations s ON s.id = kt.station_id
`;

/**
 * Un item de la comanda, con sus modificadores.
 *
 * Es lo que se proyecta como linea del ticket. La linea **no** esta guardada en
 * `kitchen_tickets`: se arma leyendo `order_items`. Es lo que hace que un item
 * anulado desaparezca del ticket de cocina sin que nadie tenga que avisar, y lo que
 * hace que el ticket de la cocina y el de la comanda no puedan discrepar.
 */
interface TicketLineRow {
  item_id: string;
  order_id: string;
  /**
   * Estacion a la que va el item, ya resuelta (producto o por defecto).
   *
   * `string | null` y no `string`: el `COALESCE` del SQL devuelve NULL cuando el local
   * no tiene ninguna estacion activa, y el filtro de `linesFor` lo descarta en vez de
   * inventar una fila con `null` en la clave.
   */
  station_id: string | null;
  name_snapshot: string;
  quantity: number;
  note: string | null;
  course: number;
  modifier_name: string | null;
}

/** Quien hizo el cambio. La atribucion viaja al registro de auditoria. */
export interface KdsActor {
  userId: string | null;
  name: string;
  deviceId?: string | null;
}

@Injectable()
export class KdsService {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly bus: KdsEventBus,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lectura
  // ---------------------------------------------------------------------------

  /**
   * Los tickets de cocina del local, con sus lineas.
   *
   * Tres consultas y un agrupado en memoria, no un `json_agg` por ticket: el POS ya
   * sabe reconstruir la pantalla con las dos listas, y un `jsonb` por fila habria que
   * re-parsear en cada cliente. El agrupado usa `Map` para que no sea cuadrático con
   * muchos tickets.
   *
   * El orden es `priority DESC, created_at ASC`: lo urgente primero, y dentro de lo
   * urgente **lo que entro primero sale primero**. Un ticket nuevo abajo no puede tapar
   * el que ya estaba esperando hace veinte minutos.
   */
  async tickets(orgId: string, venueId: string, query: ListTicketsQuery): Promise<KitchenTicket[]> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const conditions = ['kt.venue_id = $1::uuid'];
      const params: unknown[] = [venueId];

      if (query.stationId !== undefined) {
        params.push(query.stationId);
        conditions.push(`kt.station_id = $${params.length}::uuid`);
      }

      // El `status` pedido manda. Sin filtro, la pantalla muestra lo que hay que hacer y lo
      // que se esta haciendo: `SERVED` queda afuera porque un ticket servido es ruido en
      // la cocina, y verlo de nuevo hace que el turno nuevo tenga que limpiar a mano.
      // `includeServed` es para una pantalla de historico, y trae los cuatro.
      const statuses =
        query.status ?? (query.includeServed ? [...KITCHEN_CYCLE] : [...DEFAULT_KDS_STATUSES]);

      params.push(statuses);
      conditions.push(`kt.status = ANY($${params.length}::varchar[])`);

      params.push(query.limit, query.offset);

      const rows = await tx.query<TicketRow>(
        `${TICKET_SELECT}
          WHERE ${conditions.join(' AND ')}
          ORDER BY kt.priority DESC, kt.created_at ASC, kt.id ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      if (rows.rows.length === 0) return [];

      const lines = await this.linesOf(
        tx,
        venueId,
        rows.rows.map((row) => row.order_id),
      );
      return rows.rows.map((row) => toTicket(row, linesFor(lines, row)));
    });
  }

  /** Un ticket por id, con sus lineas. `null` si no existe en este local. */
  async ticket(orgId: string, venueId: string, ticketId: string): Promise<KitchenTicket | null> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const rows = await tx.query<TicketRow>(
        `${TICKET_SELECT} WHERE kt.id = $1::uuid AND kt.venue_id = $2::uuid`,
        [ticketId, venueId],
      );
      const row = rows.rows[0];
      if (!row) return null;

      const lines = await this.linesOf(tx, venueId, [row.order_id]);
      return toTicket(row, linesFor(lines, row));
    });
  }

  /**
   * Lo que la pantalla necesita al abrir: tickets y estaciones.
   *
   * Van en la misma respuesta y no en dos endpoints porque se piden **juntos** y en el
   * mismo instante: la columna de la barra y la columna de la cocina se pintan a la
   * vez. Con dos requests, el que llegara segundo veria una pantalla a medio montar.
   */
  async board(orgId: string, venueId: string, query: ListTicketsQuery): Promise<KdsBoard> {
    const [tickets, stations] = await Promise.all([
      this.tickets(orgId, venueId, query),
      this.stations(orgId, venueId),
    ]);
    return { tickets, stations };
  }

  /** Estaciones del local, en el orden en que las muestra la pantalla. */
  async stations(orgId: string, venueId: string): Promise<Station[]> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const rows = await tx.query<StationRow>(
        `SELECT id, venue_id, name, kind, printer_target, sort, active
           FROM stations
          WHERE venue_id = $1::uuid AND active
          ORDER BY sort, name`,
        [venueId],
      );
      return rows.rows.map((row) => ({
        id: row.id,
        venueId: row.venue_id,
        name: row.name,
        kind: row.kind,
        printerTarget: row.printer_target,
        sort: row.sort,
        active: row.active,
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // Escritura
  // ---------------------------------------------------------------------------

  /**
   * Avanza un ticket de cocina. Es el camino **online**: escribe en la base y emite.
   *
   * Volver atras se rechaza con un 409 que lo dice en criollo ("ese ticket ya esta
   * listo"), y no con un 422 de validacion. El que esta frente a la pantalla ya hizo
   * el gesto y lo que necesita es saber que no lo va a poder deshacer, no que el
   * servidor no acepto un valor del enum.
   *
   * Poner el mismo estado dos veces **no** es un error: devuelve el ticket tal cual y
   * no escribe nada. Dos KDS pueden tocar "Listo" al mismo tiempo, y rechazar eso
   * dejaria un error en pantalla por algo que ya esta bien.
   */
  async setStatus(
    orgId: string,
    venueId: string,
    ticketId: string,
    status: KitchenStatus,
    actor: KdsActor,
  ): Promise<KitchenTicket> {
    const applied = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const rows = await tx.query<TicketRow>(
        `${TICKET_SELECT} WHERE kt.id = $1::uuid AND kt.venue_id = $2::uuid`,
        [ticketId, venueId],
      );
      const current = rows.rows[0];
      if (!current) throw this.ticketNotFound();

      // Dos KDS pueden tocar "Listo" al mismo tiempo, y eso no es un error: ya esta
      // listo. No se escribe ni se audita, y se devuelve el ticket tal cual.
      if (current.status === status) {
        return { before: current.status, after: current, changed: false };
      }

      const from = KITCHEN_CYCLE.indexOf(current.status);
      const to = KITCHEN_CYCLE.indexOf(status);
      if (to <= from) throw this.cannotGoBack(current.status, status);

      // El estado viejo en el `WHERE` hace de Compare-And-Swap: si otra pantalla
      // escribio entre la lectura y esta, el UPDATE no afecta filas y se relee. Es el
      // mismo arbitraje por "quien llego primero" que usa el sync.
      const changed = await tx.query(
        `UPDATE kitchen_tickets
            SET status = $3::varchar, updated_at = now()
          WHERE id = $1::uuid AND venue_id = $2::uuid AND status = $4::varchar`,
        [ticketId, venueId, status, current.status],
      );

      const after = await tx.query<TicketRow>(
        `${TICKET_SELECT} WHERE kt.id = $1::uuid AND kt.venue_id = $2::uuid`,
        [ticketId, venueId],
      );

      return {
        before: current.status,
        after: after.rows[0]!,
        changed: (changed.rowCount ?? 0) > 0,
      };
    });

    const ticket =
      (await this.ticket(orgId, venueId, applied.after.id)) ?? toTicket(applied.after, []);

    // El avance de un ticket se audita: "el ticket A-104 quedo listo" es una afirmacion
    // que el que esta en cocina hace y despues nadie recuerda. Con actor y dispositivo,
    // para poder responder "quien lo marco servido y cuando" cuando el cliente reclama
    // que nunca le llevaron el plato.
    //
    // Solo si el cambio se escribio de verdad: si gano otra pantalla, lo que se audita
    // es "reviso el estado" y no un avance, y un registro por cada consulta al KDS
    // llena la auditoria de cosas que nadie va a revisar.
    if (applied.changed) {
      await this.audit.record({
        orgId,
        venueId,
        actorId: actor.userId,
        actorName: actor.name,
        deviceId: actor.deviceId ?? null,
        action: 'kitchen.ticket_status_changed',
        entity: 'kitchen_ticket',
        entityId: ticket.id,
        before: { status: applied.before },
        after: { status: ticket.status },
      });
    }

    // El evento se emite **despues** del commit. Emitir antes publicaria un estado que
    // todavia no esta en la base, y el que se suscriba leeria lo viejo: la fuente de
    // verdad es la DB, y la DB todavia no lo tenia.
    this.bus.publish({ kind: 'ticket-status', orgId, venueId, ticketId: ticket.id });

    return ticket;
  }

  /**
   * Crea los tickets de cocina que faltan para una comanda.
   *
   * **Un ticket por estacion, no uno por item.** Los items de la misma estacion se
   * agrupan en un solo papel, que es como funciona una cocina real: la barra no tiene
   * cinco papeles para cinco vasos de vino, tiene uno. Ademas el ticket lleva el
   * `station_id` en la clave de la fila, asi que un item sin estacion no tendria
   * donde ir.
   *
   * El `station_id` sale de `products.station_id`: el ruteo a cocina vive en el
   * catalogo y no en el POS, para que agregar un producto no toque la app.
   *
   * **Es idempotente.** Un ticket por `(order_id, station_id)` con un indice unico: el
   * sync reenvia la outbox entera cuando se cae la red, y sin esto cada reenvio
   * imprimiria de nuevo el mismo papel en la barra.
   */
  async ensureTicketsForOrder(
    orgId: string,
    venueId: string,
    orderId: string,
  ): Promise<KitchenTicket[]> {
    const created = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const order = await tx.query<{ id: string }>(
        `SELECT id FROM orders WHERE id = $1::uuid AND venue_id = $2::uuid`,
        [orderId, venueId],
      );
      if (order.rows.length === 0) return [];

      // Un item sin estacion va a la estacion por defecto del local. Sin esto, un
      // producto sin rutear desaparece de la cocina: el mozo lo ve en la comanda y
      // el cocinero nunca lo ve. La por defecto es la de menor `sort`, que es la
      // primera que se creo y casi siempre es la cocina.
      const fallback = await tx.query<{ id: string }>(
        `SELECT id FROM stations WHERE venue_id = $1::uuid AND active
          ORDER BY sort, name LIMIT 1`,
        [venueId],
      );
      if (fallback.rows.length === 0) {
        // Local sin ninguna estación activa: no hay a donde mandar el ticket. No es un
        // error — un local que todavia no configuro su carta no tiene cocina — y
        // tirar aca abortaria la confirmacion del item, que si se guardo.
        return [];
      }
      const defaultStationId = fallback.rows[0]!.id;

      const items = await tx.query<{
        item_id: string;
        station_id: string | null;
        quantity: number;
        course: number;
      }>(
        `SELECT oi.id AS item_id,
                p.station_id,
                oi.quantity,
                oi.course
           FROM order_items oi
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = $1::uuid AND oi.status = 'ACTIVE'`,
        [orderId],
      );
      if (items.rows.length === 0) return [];

      // Agrupado en memoria con `Map`: son decenas de filas por comanda, no miles, y
      // el `INSERT ... SELECT DISTINCT` con `COALESCE` es mas dificil de leer que el
      // bucle que hace exactamente lo mismo.
      const byStation = new Map<string, number>();
      for (const item of items.rows) {
        const stationId = item.station_id ?? defaultStationId;
        byStation.set(stationId, (byStation.get(stationId) ?? 0) + 1);
      }

      const insertedIds: string[] = [];
      for (const [stationId] of byStation) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO kitchen_tickets (id, org_id, venue_id, station_id, order_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)
           ON CONFLICT (order_id, station_id) DO NOTHING
           RETURNING id`,
          [uuidv7(), orgId, venueId, stationId, orderId],
        );
        const row = inserted.rows[0];
        if (row) insertedIds.push(row.id);
      }

      return insertedIds;
    });

    for (const ticketId of created) {
      this.bus.publish({ kind: 'ticket-created', orgId, venueId, ticketId });
    }

    // Un solo evento de "cambieron los items" en vez de uno por ticket: las lineas se
    // derivan de `order_items`, asi que el gateway relee el tablero entero y no hace
    // falta que sepa **cual** de los tickets quedo con una linea menos.
    if (created.length > 0) this.notifyOrderItems(orgId, venueId, orderId);

    const tickets = await Promise.all(
      created.map((ticketId) => this.ticket(orgId, venueId, ticketId)),
    );
    return tickets.filter((ticket): ticket is KitchenTicket => ticket !== null);
  }

  /**
   * Avisa que los items de una comanda cambiaron.
   *
   * Es publico y no privado porque lo llama tambien el sync cuando **anula** un item:
   * un item anulado sale del papel de cocina sin que nadie lo avise, y sin este aviso
   * el ticket sigue mostrando algo que ya no existe.
   *
   * Se expone para el sync en vez de que el sync publique en el bus directamente: asi
   * el unico que conoce el bus es este modulo, y cambiarlo (a Redis, cuando escale)
   * no toca el sincronizador.
   */
  notifyOrderItems(orgId: string, venueId: string, orderId: string): void {
    this.bus.publish({ kind: 'order-items', orgId, venueId, orderId });
  }

  /**
   * Avisa que un ticket cambio de estado.
   *
   * Mismo criterio que `notifyOrderItems`: el sync dice **que** cambio, este modulo
   * decide como se avisa.
   */
  notifyTicketChanged(orgId: string, venueId: string, ticketId: string): void {
    this.bus.publish({ kind: 'ticket-status', orgId, venueId, ticketId });
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /**
   * Las lineas de las comandas pedidas, agrupadas por **estacion**.
   *
   * La clave es `orderId:stationId` y no solo `orderId`: una comanda con un plato de
   * cocina y un vino de barra genera **dos** tickets, y el de cocina tiene que mostrar
   * el plato y no el vino. Agrupar solo por comanda haria que los dos tickets tuvieran
   * las mismas lineas, y el ticket de la barra con una milanesa que nadie pidio.
   *
   * La estacion se resuelve en el SQL con `COALESCE(p.station_id, porDefecto)`, que es
   * la **misma** regla que usa `ensureTicketsForOrder` para crearlos. Si las dos
   * consultas usaran reglas distintas, un producto sin rutear apareceria en un ticket
   * y no en el otro, y el KDS no tendria ni idea de por que.
   *
   * Los items `VOIDED` no entran: un item anulado sale del papel de cocina sin que
   * nadie avise.
   */
  private async linesOf(
    tx: PoolClient,
    venueId: string,
    orderIds: readonly string[],
  ): Promise<Map<string, KitchenTicket['lines']>> {
    if (orderIds.length === 0) return new Map();

    const rows = await tx.query<TicketLineRow>(
      `SELECT oi.id AS item_id,
              oi.order_id,
              COALESCE(p.station_id, (
                SELECT s.id FROM stations s
                 WHERE s.venue_id = $2::uuid AND s.active
                 ORDER BY s.sort, s.name LIMIT 1
              )) AS station_id,
              oi.name_snapshot,
              oi.quantity,
              oi.note,
              oi.course,
              m.name_snapshot AS modifier_name
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN order_item_modifiers m ON m.order_item_id = oi.id
        WHERE oi.order_id = ANY($1::uuid[]) AND oi.status = 'ACTIVE'
        ORDER BY oi.course, oi.id, m.sort`,
      [orderIds as unknown[], venueId],
    );

    // Clave compuesta `orderId:stationId`. El separador es `:` porque un UUID no lo
    // tiene, asi que no hay forma de que dos partes se confundan.
    const byStation = new Map<string, Map<string, KitchenTicket['lines'][number]>>();
    for (const row of rows.rows) {
      if (row.station_id === null) continue;
      const key = `${row.order_id}:${row.station_id}`;
      const lines = byStation.get(key) ?? new Map();
      const existing = lines.get(row.item_id);
      if (existing) {
        // El `LEFT JOIN` con modificadores repite el item una vez por modificador.
        // Se acumulan en la misma linea en vez de duplicarla: "capuchino doble" es un
        // producto con dos atributos, no dos productos.
        if (row.modifier_name !== null) existing.modifiers.push(row.modifier_name);
      } else {
        lines.set(row.item_id, {
          itemId: row.item_id,
          name: row.name_snapshot,
          quantity: row.quantity,
          note: row.note,
          modifiers: row.modifier_name === null ? [] : [row.modifier_name],
          course: row.course,
        });
      }
      byStation.set(key, lines);
    }

    return new Map([...byStation].map(([key, lines]) => [key, [...lines.values()]]));
  }

  private ticketNotFound(): NotFoundException {
    return new NotFoundException(
      problemDetails({
        status: 404,
        code: ERROR_CODES.NOT_FOUND,
        detail: 'Ese ticket no existe en este local.',
      }),
    );
  }

  private cannotGoBack(current: KitchenStatus, requested: KitchenStatus): ConflictException {
    return new ConflictException(
      problemDetails({
        status: 409,
        code: ERROR_CODES.CONFLICT,
        detail:
          `Ese ticket ya esta en ${current === 'READY' ? 'LISTO' : current} y no vuelve a ` +
          `${requested === 'NEW' ? 'NUEVO' : requested}. El ciclo de cocina solo avanza: ` +
          'ponerlo para atras lo pasaria dos veces por la pantalla y el plato saldria de mas.',
      }),
    );
  }
}

/**
 * Las lineas de un ticket concreto.
 *
 * Sale del mapa agrupado por `orderId:stationId` (ver `linesOf`). Una comanda genera
 * un ticket por estacion, asi que las lineas de la cocina y las de la barra no pueden
 * ser las mismas: el ticket de la barra con una milanesa es un plato que el bartender
 * busca veinte minutos.
 */
function linesFor(
  lines: ReadonlyMap<string, KitchenTicket['lines']>,
  row: Pick<TicketRow, 'order_id' | 'station_id'>,
): KitchenTicket['lines'] {
  return lines.get(`${row.order_id}:${row.station_id}`) ?? [];
}

/** Proyecta la fila + las lineas al contrato de `domain`. */
function toTicket(row: TicketRow, lines: KitchenTicket['lines']): KitchenTicket {
  return {
    id: row.id,
    stationId: row.station_id,
    orderId: row.order_id,
    orderNumberLabel: row.number_label,
    tableLabel: row.table_label,
    status: row.status,
    priority: row.priority,
    createdAt: new Date(row.created_at).toISOString(),
    lines,
  };
}
