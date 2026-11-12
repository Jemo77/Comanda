import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ERROR_CODES,
  problemDetails,
  type Floor,
  type FloorTable,
  type TableStatus,
} from '@comanda/domain';
import type { Database } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import type {
  CreateFloorInput,
  CreateTableInput,
  LayoutChange,
  RenameFloorInput,
  UpdateTableInput,
} from './tables.types';

/**
 * Salon: sectores y mesas.
 *
 * Igual que en `tenancy`, ningun metodo filtra por `org_id`: el
 * `TenantContextInterceptor` ya puso `app.current_org` en la transaccion y la RLS
 * filtra sola. Si un filtro manual se olvidara en una consulta, la base sigue siendo el
 * filtro.
 *
 * Lo que la RLS NO cubre es el **local**: las policies son por organizacion, asi que un
 * Encargado del local A podria leer (y tocar) el salon del local B de la misma
 * organizacion. Por eso toda consulta que tiene el local de la sesion lo trae en el
 * `WHERE` a proposito.
 */

/** Quien hizo el cambio. La atribucion viaja al registro de auditoria. */
export interface TableActor {
  userId: string;
  name: string;
  deviceId?: string | null;
}

/**
 * Actor de `setStatus`.
 *
 * Lleva el tenant adentro porque su firma no lo recibe aparte. Es el unico metodo sin
 * `orgId`/`venueId` explicitos, y sin ellos el registro de auditoria podria terminar
 * atribuyendo el cambio al local equivocado.
 */
export type TableStatusActor = TableActor & { orgId: string; venueId: string };

/** Sector con la cantidad de mesas que tiene, para pintar el listado sin otra consulta. */
export type FloorSummary = Floor & { tableCount: number };

/**
 * Mesa como la ve el mapa: el contrato del dominio mas la etiqueta de la comanda.
 *
 * La etiqueta viene en el mismo SELECT justamente para que pintar el mapa no sea N+1:
 * una fila por mesa, con el numero de comanda ya resuelto.
 */
export type TableView = FloorTable & { orderNumberLabel: string | null };

/** Un sector con todas sus mesas y su geometria: lo que carga el editor drag & drop. */
export type FloorWithTables = FloorSummary & { tables: TableView[] };

/** Minutos a partir de los cuales el mapa avisa que la mesa esta hace rato. */
export const DEFAULT_OCCUPANCY_ALERT_MINUTES = 120;

/**
 * Estado del temporizador de una mesa ocupada.
 *
 * `isOverdue` es lo que el mapa pinta en rojo. No es un campo de la base: depende de
 * una politica del local (un bar de copas no advierte a los 20 minutos lo que un
 * restaurante de familias avisa a la hora y media), asi que se calcula aca.
 */
export interface OccupancyTimer {
  occupiedSince: string;
  minutes: number;
  thresholdMinutes: number;
  isOverdue: boolean;
}

/**
 * Calcula el temporizador de ocupacion.
 *
 * Es una funcion pura y no un SELECT a proposito: el POS la corre sobre su replica
 * local para pintar el temporizador mientras esta offline, y el numero tiene que dar
 * exactamente el mismo antes y despues de sincronizar. Si el calculo viviera en un
 * `SELECT` de Postgres, el mapa offline mostraria otra cosa.
 *
 * Los minutos van **truncados hacia abajo**, no redondeados: el temporizador tiene que
 * decir "hace 119 min" mientras faltan segundos para la hora, porque un redondeo que
 * salta a 120 un minuto antes hace que la alerta vibre.
 *
 * El umbral (120 min por defecto) vive en la app y no en la base por dos razones
 * concretas:
 *
 *  - Es una politica **por local**, no un dato. Meterlo en `tables` o en `venues`
 *    obliga a una migracion cada vez que un cliente quiere 90 minutos en vez de 120, y
 *    esos datos no se consultan: se comparan en memoria al pintar.
 *  - El calculo tiene que ser identico en el servidor y en la replica del POS, y el
 *    POS no tiene (ni puede tener) acceso a una funcion de Postgres.
 *
 * @param options.now Se inyecta para poder testear sin depender del reloj.
 */
export function computeOccupancy(
  occupiedSince: Date | string | null,
  options: { now?: Date; thresholdMinutes?: number } = {},
): OccupancyTimer | null {
  if (occupiedSince === null) return null;

  const since = occupiedSince instanceof Date ? occupiedSince : new Date(occupiedSince);
  const now = options.now ?? new Date();
  const thresholdMinutes = options.thresholdMinutes ?? DEFAULT_OCCUPANCY_ALERT_MINUTES;

  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));

  return {
    occupiedSince: since.toISOString(),
    minutes,
    thresholdMinutes,
    isOverdue: minutes >= thresholdMinutes,
  };
}

/** Fila de `floors` tal como la devuelve Postgres. */
type FloorRow = {
  id: string;
  venue_id: string;
  name: string;
  sort: number;
  table_count: string;
};

/** Fila de `tables` (+ la etiqueta de la comanda) tal como la devuelve Postgres. */
type TableRow = {
  id: string;
  floor_id: string;
  label: string;
  seats: number;
  // `numeric` vuelve como texto en el protocolo de Postgres: sin `Number()` esto es
  // la cadena "120.00" y el editor recibe un string donde espera un numero.
  x: string;
  y: string;
  w: string;
  h: string;
  shape: FloorTable['shape'];
  status: FloorTable['status'];
  occupied_since: Date | string | null;
  order_id: string | null;
  number_label: string | null;
};

/** Estados que derivan de si la mesa tiene comanda abierta. */
const DERIVED_STATUSES: ReadonlySet<string> = new Set(['OCUPADA', 'PIDIO_CUENTA']);

/**
 * Proyeccion comun de mesas.
 *
 * El `LEFT JOIN` a orders es lo que evita el N+1 del mapa: estado, momento de
 * ocupacion y numero de comanda salen en la misma fila.
 */
const TABLE_SELECT = `
  SELECT t.id, t.floor_id, t.label, t.seats, t.x, t.y, t.w, t.h, t.shape,
         t.status, t.occupied_since, t.order_id, o.number_label
    FROM tables t
    LEFT JOIN orders o ON o.id = t.order_id
`;

@Injectable()
export class TablesService {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sectores del local con su conteo de mesas.
   *
   * `orgId` no se usa para filtrar (lo hace la RLS) pero viene en la firma: los metodos
   * que auditan lo necesitan, y mantener una sola forma de llamar evita que el proximo
   * que agregue un `audit.record` termine inventandose el tenant.
   */
  async listFloors(orgId: string, venueId: string): Promise<FloorSummary[]> {
    const result = await this.db.query<FloorRow>(
      `SELECT f.id, f.venue_id, f.name, f.sort,
              (SELECT count(*) FROM tables t WHERE t.floor_id = f.id) AS table_count
         FROM floors f
        WHERE f.venue_id = $1::uuid
        ORDER BY f.sort, f.name`,
      [venueId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      venueId: row.venue_id,
      name: row.name,
      sort: row.sort,
      tableCount: Number(row.table_count),
    }));
  }

  async createFloor(
    orgId: string,
    venueId: string,
    input: CreateFloorInput,
    actor: TableActor,
  ): Promise<Floor> {
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO floors (org_id, venue_id, name, sort)
       VALUES ($1::uuid, $2::uuid, $3, $4) RETURNING id`,
      [orgId, venueId, input.name, input.sort],
    );

    const floor = await this.floorById(venueId, inserted.rows[0]!.id);
    if (!floor) throw new NotFoundException('No se pudo leer el sector recien creado');

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'floor.created',
      entity: 'floor',
      entityId: floor.id,
      after: floor,
    });

    return floor;
  }

  /** Renombra o reordena un sector. */
  async renameFloor(
    orgId: string,
    venueId: string,
    floorId: string,
    input: RenameFloorInput,
    actor: TableActor,
  ): Promise<Floor> {
    const current = await this.floorById(venueId, floorId);
    if (!current) throw this.floorNotFound();

    await this.db.query(
      `UPDATE floors SET name = $3, sort = $4, updated_at = now()
        WHERE id = $1::uuid AND venue_id = $2::uuid`,
      [floorId, venueId, input.name ?? current.name, input.sort ?? current.sort],
    );

    const floor = await this.floorById(venueId, floorId);
    if (!floor) throw this.floorNotFound();

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'floor.updated',
      entity: 'floor',
      entityId: floorId,
      before: { name: current.name, sort: current.sort },
      after: { name: floor.name, sort: floor.sort },
    });

    return floor;
  }

  /**
   * Mesas del local, opcionalmente de un solo sector.
   *
   * Trae `status`, `occupiedSince` y la etiqueta de la comanda en la misma fila: el mapa
   * pinta el temporizador de cada mesa ocupada y, con el numero de comanda en otra
   * consulta, un salon con veinte mesas serian veinte requests extra por refresco.
   */
  async listTables(orgId: string, venueId: string, floorId?: string): Promise<TableView[]> {
    const result = floorId
      ? await this.db.query<TableRow>(
          `${TABLE_SELECT} WHERE t.venue_id = $1::uuid AND t.floor_id = $2::uuid
            ORDER BY t.floor_id, t.label`,
          [venueId, floorId],
        )
      : await this.db.query<TableRow>(
          `${TABLE_SELECT} WHERE t.venue_id = $1::uuid ORDER BY t.floor_id, t.label`,
          [venueId],
        );

    return result.rows.map((row) => this.toTableView(row));
  }

  /**
   * Alta de mesa.
   *
   * El sector se valida contra el local antes de insertar: la clave foranea solo
   * garantiza que el sector exista en *alguna* parte, y sin este chequeo se podria
   * colgar una mesa del salon del local A en el plano del local B (misma
   * organizacion), que es un plano que despues nadie puede corregir.
   */
  async createTable(
    orgId: string,
    venueId: string,
    input: CreateTableInput,
    actor: TableActor,
  ): Promise<TableView> {
    const floor = await this.floorById(venueId, input.floorId);
    if (!floor) {
      throw new NotFoundException(
        problemDetails({
          status: 404,
          code: ERROR_CODES.NOT_FOUND,
          detail: 'Ese sector no existe en este local.',
        }),
      );
    }

    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO tables (org_id, venue_id, floor_id, label, seats, x, y, w, h, shape)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        orgId,
        venueId,
        input.floorId,
        input.label,
        input.seats,
        input.x,
        input.y,
        input.w,
        input.h,
        input.shape,
      ],
    );

    const created = await this.tableById(orgId, venueId, inserted.rows[0]!.id);
    if (!created) throw new NotFoundException('No se pudo leer la mesa recien creada');

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'table.created',
      entity: 'table',
      entityId: created.id,
      after: { floorId: input.floorId, label: created.label, seats: created.seats },
    });

    return created;
  }

  /**
   * Edita nombre, lugares y geometria de una mesa.
   *
   * El estado **no** es un campo editable: se deriva de la comanda abierta. Por eso el
   * `SET` se arma con lo que vino y no con la fila completa: escribir el estado leido
   * seria una ocasion para pisar `OCUPADA` con el `LIBRE` que el POS tiene cacheado.
   */
  async updateTable(
    orgId: string,
    venueId: string,
    tableId: string,
    input: UpdateTableInput,
    actor: TableActor,
  ): Promise<TableView> {
    const current = await this.tableById(orgId, venueId, tableId);
    if (!current) throw this.tableNotFound();

    const columns: ReadonlyArray<[keyof UpdateTableInput, string]> = [
      ['label', 'label'],
      ['seats', 'seats'],
      ['x', 'x'],
      ['y', 'y'],
      ['w', 'w'],
      ['h', 'h'],
      ['shape', 'shape'],
    ];

    const sets: string[] = [];
    const params: unknown[] = [tableId, venueId];

    for (const [key, column] of columns) {
      const value = input[key];
      if (value === undefined) continue;
      params.push(value);
      // Los nombres de columna salen de la lista de arriba, nunca de la entrada: el
      // `SET` de un UPDATE no se puede parametrizar.
      sets.push(`${column} = $${params.length}`);
    }

    params.push(new Date());
    sets.push(`updated_at = $${params.length}`);

    await this.db.query(
      `UPDATE tables SET ${sets.join(', ')}
        WHERE id = $1::uuid AND venue_id = $2::uuid`,
      params,
    );

    const updated = await this.tableById(orgId, venueId, tableId);
    if (!updated) throw this.tableNotFound();

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'table.updated',
      entity: 'table',
      entityId: tableId,
      before: {
        label: current.label,
        seats: current.seats,
        x: current.x,
        y: current.y,
        w: current.w,
        h: current.h,
        shape: current.shape,
      },
      after: {
        label: updated.label,
        seats: updated.seats,
        x: updated.x,
        y: updated.y,
        w: updated.w,
        h: updated.h,
        shape: updated.shape,
      },
    });

    return updated;
  }

  /**
   * Cambia el estado a mano: LIBRE, RESERVADA o BLOQUEADA.
   *
   * `OCUPADA` y `PIDIO_CUENTA` se rechazan **siempre**, aunque la mesa este libre. La
   * ocupacion la deriva el sync al abrir una comanda, y ponerla a mano rompe dos
   * garantias de la base de una:
   *
   *  - `orders_one_open_per_table`: la mesa quedaria ocupada por una comanda que el
   *    servidor nunca vio abrir, y la comanda real que se abra despues se iria sin
   *    mesa.
   *  - `tables_occupied_consistent`: habria que inventar un `order_id` y un
   *    `occupied_since` que no corresponden a nada, o reventar la constraint.
   *
   * En los dos casos el resultado es un salon con una mesa "ocupada" sin nadie a quien
   * cobrarle, que es el peor estado posible para un local.
   *
   * El camino inverso tambien se cierra: si la mesa esta ocupada o pidio cuenta, hay
   * que cerrar la comanda primero. Bloquear una mesa con comanda abierta dejaria esa
   * comanda sin poder cobrar.
   *
   * Al aceptar el cambio se limpian `order_id` y `occupied_since`. La constraint solo
   * cubre una direccion (ocupada implica comanda); la inversa -- una mesa libre con una
   * comanda colgando -- la cubre esta app, y por eso el UPDATE escribe los tres campos
   * juntos y nunca uno solo.
   */
  async setStatus(
    tableId: string,
    status: TableStatus,
    actor: TableStatusActor,
  ): Promise<TableView> {
    if (DERIVED_STATUSES.has(status)) {
      throw new ConflictException(
        problemDetails({
          status: 409,
          code: ERROR_CODES.CONFLICT,
          detail:
            'Una mesa no se ocupa a mano: OCUPADA y PIDIO_CUENTA los deriva el sincronizador ' +
            'al abrir o cerrar una comanda. Abrí la comanda desde el mapa.',
        }),
      );
    }

    const current = await this.tableById(actor.orgId, actor.venueId, tableId);
    if (!current) throw this.tableNotFound();

    if (DERIVED_STATUSES.has(current.status)) {
      throw new ConflictException(
        problemDetails({
          status: 409,
          code: ERROR_CODES.CONFLICT,
          detail:
            `La mesa esta ${current.status === 'OCUPADA' ? 'ocupada' : 'pidiendo la cuenta'}. ` +
            'Cerrá la comanda antes de cambiar su estado.',
        }),
      );
    }

    if (current.status === status) {
      // No es un cambio: no se escribe ni se audita. Un registro por "pulse el mismo
      // boton" no dice nada y esconde los cambios de verdad.
      return current;
    }

    await this.db.query(
      `UPDATE tables
          SET status = $3, order_id = NULL, occupied_since = NULL, updated_at = now()
        WHERE id = $1::uuid AND venue_id = $2::uuid`,
      [tableId, actor.venueId, status],
    );

    const updated = await this.tableById(actor.orgId, actor.venueId, tableId);
    if (!updated) throw this.tableNotFound();

    // Todo cambio de estado queda auditado, y los que importan son los de BLOQUEADA y
    // RESERVADA: "el cliente dice que la mesa estaba rota" y "el cliente dice que la
    // mesa era suya" son las dos afirmaciones que despues nadie recuerda haber
    // escuchado.
    await this.audit.record({
      orgId: actor.orgId,
      venueId: actor.venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'table.status_changed',
      entity: 'table',
      entityId: tableId,
      before: { status: current.status },
      after: { status: updated.status },
    });

    return updated;
  }

  async tableById(orgId: string, venueId: string, tableId: string): Promise<TableView | null> {
    const result = await this.db.query<TableRow>(
      `${TABLE_SELECT} WHERE t.id = $1::uuid AND t.venue_id = $2::uuid`,
      [tableId, venueId],
    );

    const row = result.rows[0];
    return row ? this.toTableView(row) : null;
  }

  /**
   * Cuando se ocupa la mesa, con su temporizador.
   *
   * Es el metodo que consulta el mapa mientras esta abierto. Solo se limita por
   * organizacion (RLS) y no por local: el id viene de un listado que ya vino acotado al
   * local de la sesion, y para una lectura de una fila el filtro extra seria una
   * segunda condicion que solo se equivoca.
   */
  async occupiedSince(
    tableId: string,
    options: { now?: Date; thresholdMinutes?: number } = {},
  ): Promise<OccupancyTimer | null> {
    const result = await this.db.query<{
      status: TableStatus;
      occupied_since: Date | string | null;
    }>(`SELECT status, occupied_since FROM tables WHERE id = $1::uuid`, [tableId]);

    const row = result.rows[0];
    if (!row) return null;

    // Una mesa que no esta ocupada no tiene temporizador, aunque le quede un
    // `occupied_since` viejo: pintar "hace 3h" sobre una mesa libre es peor que no
    // pintar nada.
    if (!DERIVED_STATUSES.has(row.status)) return null;

    return computeOccupancy(row.occupied_since, options);
  }

  /**
   * El plano completo: sectores con sus mesas y su geometria.
   *
   * Dos consultas y un agrupado en memoria, no un `json_agg`: el POS ya sabe
   * reconstruir el plano a partir de las dos listas que consume para pintar, y un
   * `jsonb` por fila habria que re-parsear en cada cliente. El agrupado usa un `Map`
   * para que no sea cuadrático con muchas mesas.
   */
  async floorPlan(orgId: string, venueId: string): Promise<{ floors: FloorWithTables[] }> {
    const [floors, tables] = await Promise.all([
      this.listFloors(orgId, venueId),
      this.listTables(orgId, venueId),
    ]);

    const byFloor = new Map<string, TableView[]>();
    for (const table of tables) {
      const bucket = byFloor.get(table.floorId);
      if (bucket) bucket.push(table);
      else byFloor.set(table.floorId, [table]);
    }

    return {
      floors: floors.map((floor) => ({ ...floor, tables: byFloor.get(floor.id) ?? [] })),
    };
  }

  /**
   * Guarda varias posiciones del plano de una vez.
   *
   * Un solo `UPDATE ... FROM (VALUES ...)`: es atomico (o se mueven todas las mesas o
   * ninguna) y es un viaje de red en vez de uno por mesa. Un plano se guarda entero, asi
   * que un estado intermedio con la mitad movida no le sirve de nada a nadie.
   *
   * Falla si las filas afectadas no son las pedidas: si el editor tiene en pantalla una
   * mesa que en realidad es de otro local, un "0 filas" silencioso lo dejaria creyendo
   * que guardo.
   *
   * No se audita: arrastrar una mesa veinte pixeles no es un hecho de negocio, y auditar
   * cada gesto del editor llena el registro de cosas que nadie va a revisar.
   */
  async bulkSaveLayout(
    orgId: string,
    venueId: string,
    changes: LayoutChange[],
  ): Promise<{ updated: number }> {
    const seen = new Set<string>();
    for (const change of changes) {
      if (seen.has(change.tableId)) {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'La misma mesa aparece dos veces en el lote.',
          }),
        );
      }
      seen.add(change.tableId);
    }

    const rows: string[] = [];
    const params: unknown[] = [venueId];

    for (const change of changes) {
      params.push(change.tableId, change.x, change.y, change.w ?? null, change.h ?? null);
      rows.push(
        `($${params.length - 4}::uuid, $${params.length - 3}::numeric, ` +
          `$${params.length - 2}::numeric, $${params.length - 1}::numeric, ` +
          `$${params.length}::numeric)`,
      );
    }

    const result = await this.db.query(
      `UPDATE tables t
          SET x = v.x,
              y = v.y,
              -- Solo se pisa el tamano si vino en el gesto: arrastrar no cambia el
              -- ancho de la mesa.
              w = COALESCE(v.w, t.w),
              h = COALESCE(v.h, t.h),
              updated_at = now()
         FROM (VALUES ${rows.join(', ')}) AS v(id, x, y, w, h)
        WHERE t.id = v.id AND t.venue_id = $1::uuid`,
      params,
    );

    if (result.rowCount !== changes.length) {
      throw new NotFoundException(
        problemDetails({
          status: 404,
          code: ERROR_CODES.NOT_FOUND,
          detail: 'Algunas mesas del plano ya no existen en este local.',
        }),
      );
    }

    return { updated: result.rowCount };
  }

  /** Sector por id. `null` si no existe **o** si es de otro local. */
  private async floorById(venueId: string, floorId: string): Promise<Floor | null> {
    const result = await this.db.query<{
      id: string;
      venue_id: string;
      name: string;
      sort: number;
    }>(`SELECT id, venue_id, name, sort FROM floors WHERE id = $1::uuid AND venue_id = $2::uuid`, [
      floorId,
      venueId,
    ]);

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      venueId: row.venue_id,
      name: row.name,
      sort: row.sort,
    };
  }

  private toTableView(row: TableRow): TableView {
    return {
      id: row.id,
      floorId: row.floor_id,
      label: row.label,
      seats: Number(row.seats),
      x: Number(row.x),
      y: Number(row.y),
      w: Number(row.w),
      h: Number(row.h),
      shape: row.shape,
      status: row.status,
      occupiedSince: row.occupied_since ? new Date(row.occupied_since).toISOString() : null,
      orderId: row.order_id,
      orderNumberLabel: row.number_label,
    };
  }

  private floorNotFound(): NotFoundException {
    return new NotFoundException(
      problemDetails({
        status: 404,
        code: ERROR_CODES.NOT_FOUND,
        detail: 'Ese sector no existe en este local.',
      }),
    );
  }

  private tableNotFound(): NotFoundException {
    return new NotFoundException(
      problemDetails({
        status: 404,
        code: ERROR_CODES.NOT_FOUND,
        detail: 'Esa mesa no existe en este local.',
      }),
    );
  }
}
