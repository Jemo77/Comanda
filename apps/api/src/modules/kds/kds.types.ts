import { KITCHEN_STATUSES, KitchenStatus, type KitchenTicket, type Station } from '@comanda/domain';
import { z } from 'zod';

/**
 * Contratos de entrada de la cocina.
 *
 * Viven en el modulo y no en `@comanda/domain` por el mismo criterio que
 * `orders.types.ts`: los esquemas de `domain` son el formato de la replica local y de
 * la outbox (los corre el POS antes de subir); estos son peticiones de un endpoint.
 *
 * Lo que si se reusa del dominio es `KitchenStatus`, que es el enum que valida la
 * replica del POS. Un contrato propio con su propia lista de estados es la forma
 * tipica de que "PREPARING" sea valido en un lado y no en el otro.
 */

/** Tope de la respuesta de un listado de tickets. */
export const KDS_PAGE_MAX = 200;

/**
 * Filtro del listado de tickets.
 *
 * `status` acepta **varios** estados y tiene default, y no es un detalle de la API: la
 * pantalla de cocina abre mostrando `NEW` y `PREPARING`, que es exactamente lo que
 * hay que hacer. Con un enum singular habria que hacer dos requests y unir las
 * respuestas en el cliente, que es justo el N+1 que la pantalla no necesita.
 *
 * Cuando no viene `status`, el filtro es "todo lo que no se sirvio". Un ticket
 * `SERVED` en la pantalla de cocina es ruido: ya salio de la cocina, y volver a
 * mostrarlo hace que el turno nuevo tenga que limpiar a mano lo que ve.
 */
export const listTicketsQuerySchema = z.object({
  stationId: z.string().uuid().optional(),
  status: z
    .union([KitchenStatus, z.array(KitchenStatus)])
    .optional()
    .transform((value) => (value === undefined ? undefined : [value].flat())),
  /** Por default, los tickets que siguen sin servirse. */
  includeServed: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(KDS_PAGE_MAX).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

/** Estados por defecto de la pantalla: lo que hay que hacer y lo que se esta haciendo. */
export const DEFAULT_KDS_STATUSES: readonly KitchenStatus[] = ['NEW', 'PREPARING', 'READY'];

/**
 * Cambio de estado de un ticket.
 *
 * El endpoint online no acepta el estado del ciclo completo como un enum libre con
 * cualquier combinacion: acepta los cuatro estados (`KitchenStatus`) y el servicio
 * aplica la regla de que **solo avanza**. Verificarlo aca con un enum libre y
 * rechazarlo en el servicio daria un 422 de validacion para un caso que es un
 * conflicto de negocio (el ticket ya esta LISTO), y el mensaje que necesita ver el
 * que esta en cocina es "ese ticket ya salio", no "el enum no acepta eso".
 */
export const setTicketStatusSchema = z.object({
  status: KitchenStatus,
});
export type SetTicketStatusInput = z.infer<typeof setTicketStatusSchema>;

/** Orden del ciclo de cocina. El indice es el paso. */
export const KITCHEN_CYCLE: readonly KitchenStatus[] = KITCHEN_STATUSES;

/** Respuesta de `GET /kds/tickets`: los tickets y las estaciones del local. */
export interface KdsBoard {
  tickets: KitchenTicket[];
  stations: Station[];
}
