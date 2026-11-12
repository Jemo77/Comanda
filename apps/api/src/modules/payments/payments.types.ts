import { PaymentMethod, SplitMode } from '@comanda/domain';
import { z } from 'zod';

/**
 * Contratos de entrada del cobro.
 *
 * El enum de metodo y el de modo de division vienen del dominio y no se reescriben: el POS
 * valida la outbox con esos mismos objetos, y un enum duplicado es un enum que un dia
 * diverge del que valida el cliente.
 */

/**
 * Metodos de pago **externos**.
 *
 * `CARD`, `QR` y `TRANSFER` son pagos que el cliente paga fuera de esta API: el POS habla
 * con la terminal o con la pasarela y despues manda el comprobante. La API nunca ve el
 * numero de tarjeta en ningun camino (PLAN §6, PCI), asi que el unico dato que viaja es
 * `providerRef`.
 *
 * La lista esta aca y no dentro del esquema de la linea para que la condicion "esto es un
 * pago externo" sea un `includes` y no una comparacion repetida en tres lugares.
 */
export const EXTERNAL_PAYMENT_METHODS = ['CARD', 'QR', 'TRANSFER'] as const;

/** Cuantos metodos de pago se aceptan en una sola operacion. */
export const PAYMENT_LINES_MAX = 4;

/**
 * Una linea del pago mixto.
 *
 * `providerRef` es el **comprobante del terminal** (el id de la operacion del proveedor),
 * nunca el PAN. No hay ningun campo en este esquema, ni en el de la comanda, que pueda
 * contener datos de tarjeta: esa es la garantia de que la API no puede storarlos aunque
 * alguien lo intente. Si alguna vez hiciera falta un dato mas del proveedor, se agrega
 * aca con un nombre que no admita un numero de tarjeta.
 */
export const paymentLineSchema = z.object({
  method: PaymentMethod,
  amountCents: z.number().int().min(1, 'El importe tiene que ser un entero positivo.'),
  provider: z.string().trim().min(1).max(24).optional(),
  providerRef: z.string().trim().min(1).max(120).optional(),
});
export type PaymentLineInput = z.infer<typeof paymentLineSchema>;

/**
 * Cobro de una comanda.
 *
 * `lines` es una lista y no un unico `method`/`amountCents` porque el pago mixto es el caso
 * normal, no la excepcion: "le da 5000 en efectivo y el resto con la tarjeta" es una sola
 * operacion de caja, y modelarla como dos cobros separados obliga al POS a hacer dos requests
 * que pueden quedar a medias (una registrada y la otra no).
 *
 * `tipCents` es la propina que el cliente dejo **sobre la cuenta**: se suma al total de la
 * comanda antes de validar, asi que las lineas tienen que cubrir el total con propina
 * incluida. No hay que sumar la propina aparte en cada linea.
 *
 * `overpayReason` es obligatorio cuando las lineas dan mas que el total. Cobrar de mas sin
 * motivo es indistinguible de un error de caja, y el arqueo del turno muestra la diferencia
 * sin poder explicarla.
 */
export const paySchema = z
  .object({
    lines: z
      .array(paymentLineSchema)
      .min(1, 'Mandá al menos una forma de pago.')
      .max(PAYMENT_LINES_MAX, `Máximo ${PAYMENT_LINES_MAX} formas de pago por operación.`),
    tipCents: z.number().int().min(0).max(1_000_000).default(0),
    overpayReason: z.string().trim().min(1).max(300).optional(),
  })
  .refine(
    (value) => value.lines.every((line) => line.method === 'CASH' || line.provider !== undefined),
    {
      message: 'Un pago con tarjeta, QR o transferencia necesita el nombre del proveedor.',
    },
  );
export type PayInput = z.infer<typeof paySchema>;

/**
 * Division de la cuenta.
 *
 * Acepta las dos formas de usarla y no elige por el cliente:
 *
 *  - con `parts` (EQUAL) o `amounts` (AMOUNT), el servidor calcula el reparto con el motor
 *    del dominio, que reparte el resto en aritmetica entera y por eso siempre suma el
 *    total exacto;
 *  - con `allocations`, se guarda tal cual lo calculo el cliente.
 *
 * Lo segundo es lo que hace el sync con `SPLIT_SAVED`, y por el mismo motivo: el reparto ya
 * se mostro en pantalla y el cliente ya lo acepto. Recalcularlo acá podria dar un centavo
 * distinto al que se leyo cobrar, que es la peor forma de descuadrar una mesa. Lo que si se
 * valida, siempre, es que las partes sumen el total.
 */
export const splitBillSchema = z.object({
  mode: SplitMode,
  /** Partes ya calculadas por el cliente. Gana sobre `parts`/`amounts`. */
  allocations: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        amountCents: z.number().int().min(0),
        itemIds: z.array(z.string().uuid()).max(100).default([]),
      }),
    )
    .max(50)
    .optional(),
  /** EQUAL: cuantas partes. */
  parts: z.number().int().min(1).max(50).optional(),
  /** AMOUNT: un importe por item, en el mismo orden que los items de la comanda. */
  amounts: z.array(z.number().int().min(0)).max(100).optional(),
});
export type SplitBillInput = z.infer<typeof splitBillSchema>;

/**
 * Propina de la comanda.
 *
 * Exactamente uno de los dos: el importe o el porcentaje. Aceptar ambos seria ambiguo
 * ("cobra $1000 y de paso un 10%"), y la respuesta al cliente tiene que ser un numero.
 */
export const addTipSchema = z
  .object({
    tipCents: z.number().int().min(0).max(1_000_000).optional(),
    basisPoints: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((value) => (value.tipCents === undefined) !== (value.basisPoints === undefined), {
    message: 'Mandá el importe de la propina o el porcentaje, no los dos.',
  });
export type AddTipInput = z.infer<typeof addTipSchema>;
