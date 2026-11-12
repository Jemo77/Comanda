import { CashMovementType } from '@comanda/domain';
import { z } from 'zod';

/**
 * Contratos de entrada de la caja.
 *
 * Los enums vienen del dominio: son los mismos que el catalogo de eventos del sync y los
 * mismos que la constraint `cash_movements_type_valid`, y un enum reescrito aca seria una
 * tercera lista que diverge de las otras dos.
 */

/**
 * Apertura de caja.
 *
 * El fondo se llama `openingFloatCents` y no `initialCents` porque es una convencion del
 * rubro con un nombre propio: es la plata que el local deja en la gaveta al abrir, y es la
 * base de la que el arqueo calcula el esperado. El nombre importa porque es la primera
 * pregunta que hace cualquiera que lea un arqueo.
 */
export const openShiftSchema = z.object({
  openingFloatCents: z.number().int().min(0).max(100_000_000).default(0),
});
export type OpenShiftInput = z.infer<typeof openShiftSchema>;

/**
 * Movimiento de efectivo.
 *
 * **No acepta el signo.** El importe es siempre positivo y el `type` dice si suma o resta.
 * Aceptar un `amountCents` negativo seria permitir que un retiro quede registrado como
 * ingreso: el arqueo del turno quedaria desfasado para siempre y el error es invisible
 * hasta que se cierra el mes.
 *
 * El motivo es obligatorio (`shift.cash_movement` esta en
 * `AUDIT_ACTIONS_REQUIRING_REASON`): un ingreso u egreso sin explicacion es
 * indistinguible de una diferencia de caja.
 */
export const cashMovementSchema = z.object({
  shiftId: z.string().uuid(),
  type: CashMovementType,
  amountCents: z.number().int().min(1, 'El importe tiene que ser un entero positivo.'),
  reason: z
    .string({ required_error: 'Un movimiento de efectivo necesita un motivo.' })
    .trim()
    .min(1, 'Un movimiento de efectivo necesita un motivo.')
    .max(300),
});
export type CashMovementInput = z.infer<typeof cashMovementSchema>;

/**
 * Cierre de caja (arqueo ciego).
 *
 * El cajero manda **solo lo que declara tener**. No hay ningun campo para "lo que creo que
 * deberia haber": ese numero lo calcula el servidor y no vuelve en la respuesta. Pedirlo o
 * devolverlo seria convertir el arqueo ciego en un arqueo con ayuda, que es justo lo que
 * el cajero puede ajustar para que cuadre.
 */
export const closeShiftSchema = z.object({
  declaredCashCents: z
    .number()
    .int()
    .min(0, 'Lo declarado no puede ser negativo.')
    .max(100_000_000),
});
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;
