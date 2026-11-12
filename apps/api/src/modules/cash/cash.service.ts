import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, problemDetails, type CashMovement, type Shift } from '@comanda/domain';
import type { PoolClient } from 'pg';
import type { Database } from '../../database/database.service';
// Import de VALOR a proposito: `emitDecoratorMetadata` escribe la clase real del
// segundo argumento del constructor en `design:paramtypes`, y con `import type` la clase se
// borra en tiempo de compilacion y Nest recibe `Function`. Ver el mismo comentario en
// `sync.service.ts`.
import { AuditService } from '../audit/audit.service';
import type { CashMovementInput, CloseShiftInput, OpenShiftInput } from './cash.types';

/**
 * Caja: turnos, movimientos de efectivo y arqueo ciego.
 *
 * Este modulo tiene una regla que no aparece en ninguna constraint y por eso es la mas
 * importante del archivo: **el cajero no ve el esperado**. Declara lo que tiene sin ver que
 * deberia tener; el servidor calcula `expected_cash_cents` y guarda `diff_cents`, y esos dos
 * numeros solo se devuelven a quien tiene `cash.viewExpected` (Encargado y Dueno).
 *
 * No es una pantalla que se decide no mostrar: es una garantia estructural. Por eso los
 * endpoints del cajero usan `toBlindShift()`, que construye el objeto **sin las claves**
 * del esperado y de la diferencia, ni en `null`. Si volvieran en `null`, un cliente que
 * solo mira `!== undefined` los encontraria, y bastaria un refactor para que empezaran a
 * viajar. Un arqueo que se puede ver, se ajusta; uno que no, se cuenta.
 */

/** Quien opero la caja. La atribucion viaja al registro de auditoria. */
export interface CashActor {
  userId: string;
  name: string;
  deviceId?: string | null;
}

/**
 * Turno sin esperado ni diferencia.
 *
 * `Omit` y no dos `null`: la diferencia entre "no existe el campo" y "existe y vale null"
 * es la diferencia entre una garantia y una convencia.
 */
export type BlindShift = Omit<Shift, 'expectedCashCents' | 'diffCents'>;

/** Fila de `shifts` tal como la devuelve Postgres. */
interface ShiftRow {
  id: string;
  venue_id: string;
  opened_by: string;
  opened_at: Date | string;
  opening_float_cents: number;
  closed_at: Date | string | null;
  declared_cash_cents: number | null;
  expected_cash_cents: number | null;
  diff_cents: number | null;
  status: 'OPEN' | 'CLOSED';
}

/** Fila de `cash_movements`. */
interface MovementRow {
  id: string;
  shift_id: string;
  type: CashMovement['type'];
  amount_cents: number;
  reason: string | null;
  created_by: string;
  created_at: Date | string;
}

/** El arqueo completo, para quien puede ver el esperado. */
export interface ShiftReport {
  shift: Shift;
  sales: Array<{ method: string; amountCents: number; count: number }>;
  movements: Array<{
    id: string;
    type: CashMovement['type'];
    amountCents: number;
    signedCents: number;
    reason: string | null;
    createdAt: string;
  }>;
  totals: {
    openingFloatCents: number;
    cashSalesCents: number;
    cardSalesCents: number;
    qrSalesCents: number;
    transferSalesCents: number;
    cashInCents: number;
    cashOutCents: number;
    expectedCashCents: number;
    declaredCashCents: number | null;
    diffCents: number | null;
  };
}

@Injectable()
export class CashService {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Turnos
  // ---------------------------------------------------------------------------

  /**
   * Abre la caja.
   *
   * UN turno abierto por local, y no es una convencion: hay un indice unico parcial
   * (`shifts_one_open_per_venue`) sobre `status = 'OPEN'`. Dos cajas abiertas a la vez
   * duplicarian el conteo y el arqueo daria dos diferencias que no se pueden explicar.
   *
   * Se consulta antes de insertar en vez de confiar en el `ON CONFLICT` porque el indice es
   * **parcial** y Postgres no lo usa para inferir un `ON CONFLICT` sin la misma clausula
   * `WHERE`. Y el 409 con un mensaje que dice "la caja ya esta abierta" es la respuesta que
   * le sirve al operador: dos tablets abriendo caja a la vez es un hecho normal, no una base
   * que se rompio.
   */
  async openShift(
    orgId: string,
    venueId: string,
    input: OpenShiftInput,
    actor: CashActor,
  ): Promise<BlindShift> {
    const shift = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM shifts WHERE venue_id = $1::uuid AND status = 'OPEN' LIMIT 1`,
        [venueId],
      );

      if (existing.rows.length > 0) {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'La caja ya está abierta en este local.',
          }),
        );
      }

      const inserted = await tx.query<ShiftRow>(
        `INSERT INTO shifts (org_id, venue_id, opened_by, opening_float_cents)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
         RETURNING id, venue_id, opened_by, opened_at, opening_float_cents, closed_at,
                   declared_cash_cents, expected_cash_cents, diff_cents, status`,
        [orgId, venueId, actor.userId, input.openingFloatCents],
      );

      return inserted.rows[0]!;
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'shift.opened',
      entity: 'shift',
      entityId: shift.id,
      after: { openingFloatCents: shift.opening_float_cents },
    });

    return toBlindShift(shift);
  }

  /**
   * El turno abierto del local, o `null`.
   *
   * Proyectado a ciegas aunque este abierto (donde el esperado es `NULL` de todos modos):
   * una funcion que hoy devuelve `null` y manana devuelve numeros segun un permiso es
   * exactamente como un arqueo ciego se vuelve un arqueo con ayuda sin que nadie lo decida.
   */
  async currentShift(orgId: string, venueId: string): Promise<BlindShift | null> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const row = await openShiftRow(tx, venueId);
      return row ? toBlindShift(row) : null;
    });
  }

  /**
   * Cierra el turno con arqueo ciego.
   *
   * El cajero manda `declaredCashCents` y nada mas. El servidor calcula:
   *
   *   esperado = fondo de apertura + ventas en efectivo del turno + movimientos con signo
   *   diferencia = declarado - esperado
   *
   * y guarda los tres (la constraint `shifts_closed_consistent` exige declarado **y**
   * esperado cuando el turno no esta abierto). **La respuesta no lleva el esperado ni la
   * diferencia**: los lleva `GET /shifts/:id/expected` y `GET /shifts/:id/report`, que exigen
   * `cash.viewExpected`.
   *
   * El conteo se hace con una sola consulta y no con la suma en memoria de los pagos: el
   * arqueo se corre con la caja cerrada y otras tablets cobrando, y una lectura parcial
   * daria una diferencia que no existe. El `FOR UPDATE` del turno, ademas, serializa dos
   * arqueos simultaneos del mismo turno en vez de dejarlos competir por la misma fila.
   */
  async closeShift(
    orgId: string,
    venueId: string,
    shiftId: string,
    input: CloseShiftInput,
    actor: CashActor,
  ): Promise<BlindShift> {
    const closed = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const shift = await shiftRow(tx, venueId, shiftId);
      if (!shift) throw notFound('Ese turno no existe en este local.');
      if (shift.status === 'CLOSED') {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'La caja de este turno ya está cerrada.',
          }),
        );
      }

      const cash = await cashOfShift(tx, shiftId, { lock: true });

      const result = await tx.query<ShiftRow>(
        `UPDATE shifts
            SET status = 'CLOSED', closed_at = now(),
                declared_cash_cents = $2, expected_cash_cents = $3, diff_cents = $4,
                updated_at = now()
          WHERE id = $1::uuid AND status = 'OPEN'
        RETURNING id, venue_id, opened_by, opened_at, opening_float_cents, closed_at,
                  declared_cash_cents, expected_cash_cents, diff_cents, status`,
        [shiftId, input.declaredCashCents, cash.expectedCents, cash.diff(input.declaredCashCents)],
      );

      if (result.rows.length === 0) {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'La caja de este turno ya está cerrada.',
          }),
        );
      }

      return result.rows[0]!;
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'shift.closed',
      entity: 'shift',
      entityId: closed.id,
      // El esperado y la diferencia SI van al registro: lo lee el encargado con
      // `audit.read`, que es justamente para quien existe el arqueo. Lo que no puede ver
      // el cajero es su propia pantalla.
      after: {
        declaredCashCents: closed.declared_cash_cents,
        expectedCashCents: closed.expected_cash_cents,
        diffCents: closed.diff_cents,
      },
    });

    return toBlindShift(closed);
  }

  // ---------------------------------------------------------------------------
  // Efectivo
  // ---------------------------------------------------------------------------

  /**
   * Movimiento de efectivo del turno.
   *
   * **El signo lo decide el tipo, nunca quien escribe.** `IN` suma; `OUT` y `RETIRO` restan.
   * El importe se guarda siempre positivo (es lo que exige
   * `cash_movements_sign`) y el signo se aplica al sumar, que es donde se usa. Aceptar un
   * importe negativo permitiria que un retiro quedara registrado como ingreso y el arqueo del
   * turno quedaria desfasado para siempre, sin ningun rastro de que paso.
   *
   * El motivo es obligatorio y va al registro de auditoria con el importe con signo, que es
   * la pregunta que el encargado hace: "salieron $3000, por que".
   */
  async cashMovement(
    orgId: string,
    venueId: string,
    input: CashMovementInput,
    actor: CashActor,
  ): Promise<{ movement: CashMovement; signedCents: number }> {
    const movement = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const shift = await shiftRow(tx, venueId, input.shiftId);
      if (!shift) throw notFound('Ese turno no existe en este local.');
      if (shift.status === 'CLOSED') {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'La caja de este turno está cerrada: no admite movimientos.',
          }),
        );
      }

      const inserted = await tx.query<MovementRow>(
        `INSERT INTO cash_movements (org_id, shift_id, type, amount_cents, reason, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)
         RETURNING id, shift_id, type, amount_cents, reason, created_by, created_at`,
        [orgId, input.shiftId, input.type, input.amountCents, input.reason, actor.userId],
      );

      return toMovement(inserted.rows[0]!);
    });

    const signedCents = signedAmount(movement.type, movement.amountCents);

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'shift.cash_movement',
      entity: 'cash_movement',
      entityId: movement.id,
      after: {
        shiftId: movement.shiftId,
        type: movement.type,
        amountCents: movement.amountCents,
        signedCents,
      },
      reason: movement.reason,
    });

    return { movement, signedCents };
  }

  // ---------------------------------------------------------------------------
  // Lectura del arqueo (con el esperado)
  // ---------------------------------------------------------------------------

  /**
   * El efectivo que **deberia** haber en la gaveta y la diferencia.
   *
   * Requiere `cash.viewExpected` en el guard del controller: este es el unico lugar del
   * camino del cajero que puede romperse, asi que la proteccion esta en la declaracion del
   * endpoint y no en una condicion dentro del servicio (los permisos son del guard en todo
   * el proyecto, y una condicion en el metodo es la que alguien se olvida de mover cuando
   * copia el patron).
   */
  async expectedCash(
    orgId: string,
    venueId: string,
    shiftId: string,
  ): Promise<{
    shiftId: string;
    expectedCashCents: number;
    declaredCashCents: number | null;
    diffCents: number | null;
    closedAt: string | null;
  }> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const shift = await shiftRow(tx, venueId, shiftId);
      if (!shift) throw notFound('Ese turno no existe en este local.');

      // Con el turno abierto el esperado es un numero provisional: el conteo de ahora se
      // calcula igual, y quien lo mira tiene que saber que todavia no cerro.
      const cash = await cashOfShift(tx, shiftId);
      const declared = shift.declared_cash_cents;

      return {
        shiftId: shift.id,
        expectedCashCents: cash.expectedCents,
        declaredCashCents: declared,
        diffCents: shift.diff_cents,
        closedAt: shift.closed_at ? new Date(shift.closed_at).toISOString() : null,
      };
    });
  }

  /**
   * Arqueo del turno: ventas por metodo, movimientos y declarado contra esperado.
   *
   * Es el informe que necesita el encargado cuando cierra el dia: cuanto se facturo por
   * cada metodo, que entro y salio de la gaveta, y si el efectivo declarado cerraba con lo
   * que el sistema esperaba. Requiere `cash.viewExpected` **y no** `finance.read`, porque el
   * Encargado tiene que poder verlo en el dia y el permiso de finanzas es del Dueno.
   */
  async shiftReport(orgId: string, venueId: string, shiftId: string): Promise<ShiftReport> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const shift = await shiftRow(tx, venueId, shiftId);
      if (!shift) throw notFound('Ese turno no existe en este local.');

      const sales = await tx.query<{ method: string; amount_cents: string; count: string }>(
        `SELECT method, SUM(amount_cents)::text AS amount_cents, count(*)::text AS count
           FROM payments
          WHERE shift_id = $1::uuid AND status = 'APPROVED'
          GROUP BY method
          ORDER BY method`,
        [shiftId],
      );

      const movementRows = await tx.query<MovementRow>(
        `SELECT id, shift_id, type, amount_cents, reason, created_by, created_at
           FROM cash_movements
          WHERE shift_id = $1::uuid
          ORDER BY created_at, id`,
        [shiftId],
      );

      const cash = await cashOfShift(tx, shiftId);

      return {
        shift: toShift(shift),
        sales: sales.rows.map((row) => ({
          method: row.method,
          amountCents: Number(row.amount_cents),
          count: Number(row.count),
        })),
        movements: movementRows.rows.map((row) => {
          const movement = toMovement(row);
          return {
            id: movement.id,
            type: movement.type,
            amountCents: movement.amountCents,
            signedCents: signedAmount(movement.type, movement.amountCents),
            reason: movement.reason,
            createdAt: movement.createdAt,
          };
        }),
        totals: {
          openingFloatCents: shift.opening_float_cents,
          cashSalesCents: cash.cashSalesCents,
          cardSalesCents: sumMethod(sales.rows, 'CARD'),
          qrSalesCents: sumMethod(sales.rows, 'QR'),
          transferSalesCents: sumMethod(sales.rows, 'TRANSFER'),
          cashInCents: cash.cashInCents,
          cashOutCents: cash.cashOutCents,
          expectedCashCents: cash.expectedCents,
          declaredCashCents: shift.declared_cash_cents,
          diffCents: shift.diff_cents,
        },
      };
    });
  }
}

// -----------------------------------------------------------------------------
// Consultas y calculos
// -----------------------------------------------------------------------------

/**
 * El efectivo del turno: lo que deberia haber en la gaveta.
 *
 * Tres numeros y ni uno mas:
 *
 *  - **fondo**: con lo que arranco la caja. Es plata del local, no una venta.
 *  - **ventas en efectivo** del turno: solo `CASH` y solo `APPROVED`. Un pago por QR que
 *    entro a una billetera virtual no esta en la gaveta, y un pago revertido tampoco.
 *  - **movimientos con signo**: entra lo que se cargo a la caja, sale lo que se withdrew.
 *
 * Las ventas en efectivo se leen por `payments.shift_id` y no por fecha: un pago hecho
 * durante el turno pero asignado a otro es un error de otro, y mezclar los dos criterios
 * produce dos arqueos que no cuadran ninguno.
 */
async function cashOfShift(
  tx: PoolClient,
  shiftId: string,
  options: { lock?: boolean } = {},
): Promise<{
  cashSalesCents: number;
  cashInCents: number;
  cashOutCents: number;
  expectedCents: number;
  diff(declaredCents: number): number;
}> {
  const result = await tx.query<{
    opening_float_cents: number;
    cash_sales: string;
    cash_in: string;
    cash_out: string;
  }>(
    `SELECT s.opening_float_cents,
            COALESCE((SELECT SUM(p.amount_cents)
                        FROM payments p
                       WHERE p.shift_id = s.id AND p.method = 'CASH'
                         AND p.status = 'APPROVED'), 0)::text AS cash_sales,
            COALESCE((SELECT SUM(m.amount_cents)
                        FROM cash_movements m
                       WHERE m.shift_id = s.id AND m.type = 'IN'), 0)::text AS cash_in,
            COALESCE((SELECT SUM(m.amount_cents)
                        FROM cash_movements m
                       WHERE m.shift_id = s.id AND m.type IN ('OUT','RETIRO')), 0)::text AS cash_out
       FROM shifts s
      WHERE s.id = $1::uuid${options.lock ? ' FOR UPDATE' : ''}`,
    [shiftId],
  );

  const row = result.rows[0];
  const opening = row?.opening_float_cents ?? 0;
  const cashSales = Number(row?.cash_sales ?? 0);
  const cashIn = Number(row?.cash_in ?? 0);
  const cashOut = Number(row?.cash_out ?? 0);

  return {
    cashSalesCents: cashSales,
    cashInCents: cashIn,
    cashOutCents: cashOut,
    expectedCents: opening + cashSales + cashIn - cashOut,
    diff: (declaredCents: number) => declaredCents - (opening + cashSales + cashIn - cashOut),
  };
}

async function shiftRow(
  tx: PoolClient,
  venueId: string,
  shiftId: string,
): Promise<ShiftRow | null> {
  const result = await tx.query<ShiftRow>(
    `SELECT id, venue_id, opened_by, opened_at, opening_float_cents, closed_at,
            declared_cash_cents, expected_cash_cents, diff_cents, status
       FROM shifts
      WHERE id = $1::uuid AND venue_id = $2::uuid`,
    [shiftId, venueId],
  );
  return result.rows[0] ?? null;
}

async function openShiftRow(tx: PoolClient, venueId: string): Promise<ShiftRow | null> {
  const result = await tx.query<ShiftRow>(
    `SELECT id, venue_id, opened_by, opened_at, opening_float_cents, closed_at,
            declared_cash_cents, expected_cash_cents, diff_cents, status
       FROM shifts
      WHERE venue_id = $1::uuid AND status = 'OPEN'
      LIMIT 1`,
    [venueId],
  );
  return result.rows[0] ?? null;
}

// -----------------------------------------------------------------------------
// Mapeo
// -----------------------------------------------------------------------------

/**
 * Proyeccion **a ciegas**.
 *
 * Las dos claves no se escriben, ni en `null`. Volverian en la respuesta de `closeShift` si
 * se hiciera `{ ...toShift(row), expectedCashCents: undefined }`: es una linea de codigo y
 * el cajero ve el esperado.
 */
function toBlindShift(row: ShiftRow): BlindShift {
  return {
    id: row.id,
    venueId: row.venue_id,
    openedBy: row.opened_by,
    openedAt: new Date(row.opened_at).toISOString(),
    openingFloatCents: row.opening_float_cents,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    declaredCashCents: row.declared_cash_cents,
    status: row.status,
  };
}

/** Proyeccion completa. Solo para quien tiene `cash.viewExpected`. */
function toShift(row: ShiftRow): Shift {
  return {
    ...toBlindShift(row),
    expectedCashCents: row.expected_cash_cents,
    diffCents: row.diff_cents,
  };
}

function toMovement(row: MovementRow): CashMovement {
  return {
    id: row.id,
    shiftId: row.shift_id,
    type: row.type,
    amountCents: row.amount_cents,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * El signo, derivado del tipo.
 *
 * Vive en una sola funcion porque es la regla que mas caro sale si se duplica: un `RETIRO`
 * guardado con signo positivo deja el arqueo descuadrado **para siempre** y no hay ningun
 * error en ninguna parte, solo un numero que no cierra.
 */
function signedAmount(type: CashMovement['type'], amountCents: number): number {
  return type === 'IN' ? amountCents : -amountCents;
}

function sumMethod(
  rows: ReadonlyArray<{ method: string; amount_cents: string }>,
  method: string,
): number {
  const row = rows.find((candidate) => candidate.method === method);
  return row ? Number(row.amount_cents) : 0;
}

function notFound(detail: string): NotFoundException {
  return new NotFoundException(
    problemDetails({ status: 404, code: ERROR_CODES.NOT_FOUND, detail }),
  );
}
