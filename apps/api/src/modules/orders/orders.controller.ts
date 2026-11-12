import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { OrdersService, type OrderActor } from './orders.service';
import {
  addItemSchema,
  listOrdersQuerySchema,
  mergeOrdersSchema,
  openOrderSchema,
  orderNoteSchema,
  setCourseSchema,
  setSeatSchema,
  tipSuggestionsQuerySchema,
  transferOrderSchema,
  voidItemSchema,
  type AddItemInput,
  type ListOrdersQuery,
  type MergeOrdersInput,
  type OpenOrderInput,
  type OrderNoteInput,
  type SetCourseInput,
  type SetSeatInput,
  type TipSuggestionsQuery,
  type TransferOrderInput,
  type VoidItemInput,
} from './orders.types';

/**
 * Comandas.
 *
 * Todos los endpoints declaran permisos explicitamente: uno sin `@RequirePermissions`
 * hace fallar el guard en vez de quedar abierto. Ninguno toma `orgId`, `venueId` ni
 * `actorId` del body: salen de la sesion, que es lo unico que la RLS y la auditoria pueden
 * dar por cierto.
 *
 * El cobro y la division viven en `PaymentsController`, que cuelga del mismo prefijo
 * `/orders`: la unidad de negocio es la comanda, no el pago. Un pago solo no existe en el
 * dominio, y `/payments/:id` seria una pantalla que no usa nadie.
 */
@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions('order.read')
  @ApiOperation({
    summary: 'Comandas del local, con items, modificadores y pagos ya agregados',
  })
  async list(
    @CurrentSession() session: SessionPrincipal,
    @Query(new ZodValidationPipe(listOrdersQuerySchema)) query: ListOrdersQuery,
  ) {
    return { orders: await this.orders.listOrders(session.orgId, session.venueId, query) };
  }

  @Post()
  @RequirePermissions('order.open')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Clave del cliente para reintentar sin abrir dos comandas. Si no viene, la comanda se ' +
      'identifica por el UUID que devuelve la respuesta.',
  })
  @ApiOperation({ summary: 'Abrir una comanda online (QR, takeaway o mostrador con red)' })
  async open(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(openOrderSchema)) body: OpenOrderInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.orders.openOrder(
      session.orgId,
      session.venueId,
      body,
      actor(session),
      idempotencyKey,
    );
    return result;
  }

  @Get('current-shift')
  @RequirePermissions('order.read')
  @ApiOperation({ summary: 'Turno abierto del local, o null' })
  async currentShift(@CurrentSession() session: SessionPrincipal) {
    return { shift: await this.orders.currentShift(session.orgId, session.venueId) };
  }

  @Get(':id')
  @RequirePermissions('order.read')
  @ApiOperation({ summary: 'Una comanda con items, cuenta, reparto y turno' })
  async detail(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.orders.orderDetail(session.orgId, session.venueId, id);
  }

  @Post(':id/items')
  @RequirePermissions('order.item.add')
  @ApiOperation({
    summary: 'Agregar un producto con modificadores',
    description:
      'El precio lo calcula el servidor a partir del catalogo: el cuerpo no acepta importes ' +
      'ni deltas de modificador.',
  })
  async addItem(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addItemSchema)) body: AddItemInput,
  ) {
    return this.orders.addItem(session.orgId, session.venueId, id, body, actor(session));
  }

  @Post('items/:itemId/void')
  @RequirePermissions('order.item.void')
  @ApiOperation({ summary: 'Anular un item. Exige motivo' })
  async voidItem(
    @CurrentSession() session: SessionPrincipal,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body(new ZodValidationPipe(voidItemSchema)) body: VoidItemInput,
  ) {
    return this.orders.voidItem(session.orgId, session.venueId, itemId, body, actor(session));
  }

  @Post(':id/note')
  @RequirePermissions('order.item.add')
  @ApiOperation({ summary: 'Dejar o borrar la nota de la comanda' })
  async note(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(orderNoteSchema)) body: OrderNoteInput,
  ) {
    return this.orders.addNote(
      session.orgId,
      session.venueId,
      id,
      body.note ?? null,
      actor(session),
    );
  }

  @Post(':id/course')
  @RequirePermissions('order.item.add')
  @ApiOperation({ summary: 'Asignar items a un curso' })
  async course(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setCourseSchema)) body: SetCourseInput,
  ) {
    return this.orders.setCourse(session.orgId, session.venueId, id, body, actor(session));
  }

  @Post(':id/seat')
  @RequirePermissions('order.item.add')
  @ApiOperation({ summary: 'Asignar items a un comensal (asiento)' })
  async seat(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setSeatSchema)) body: SetSeatInput,
  ) {
    return this.orders.setSeat(session.orgId, session.venueId, id, body, actor(session));
  }

  @Post(':id/close')
  @RequirePermissions('order.close')
  @ApiOperation({
    summary: 'Cerrar la comanda y liberar la mesa',
    description: 'El turno se resuelve en el servidor: sin caja abierta no se puede cerrar.',
  })
  async close(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.orders.closeOrder(session.orgId, session.venueId, id, actor(session));
  }

  @Post(':id/transfer')
  @RequirePermissions('order.transfer')
  @ApiOperation({ summary: 'Mover la comanda a otra mesa del mismo local' })
  async transfer(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(transferOrderSchema)) body: TransferOrderInput,
  ) {
    return this.orders.transferOrder(session.orgId, session.venueId, id, body, actor(session));
  }

  @Post(':id/merge')
  @RequirePermissions('order.merge')
  @ApiOperation({
    summary: 'Unir esta comanda con otra',
    description: 'Sobrevive la comanda destino: es la que tiene la mesa.',
  })
  async merge(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(mergeOrdersSchema)) body: MergeOrdersInput,
  ) {
    return this.orders.mergeOrders(
      session.orgId,
      session.venueId,
      id,
      body.intoOrderId,
      actor(session),
    );
  }

  @Get(':id/tip-suggestions')
  @RequirePermissions('bill.read')
  @ApiOperation({
    summary: 'Propinas sugeridas para la cuenta, en basis points del total',
  })
  async tipSuggestions(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(tipSuggestionsQuerySchema)) query: TipSuggestionsQuery,
  ) {
    return this.orders.tipSuggestions(session.orgId, session.venueId, id, query);
  }
}

/**
 * Quién hizo el cambio, para la auditoría.
 *
 * Se arma desde la sesión y no desde el body: un endpoint que aceptara el actor
 * escribiría en `audit_log` el nombre de quien el cliente diga, que es exactamente el dato
 * que el registro tiene que garantizar.
 */
function actor(session: SessionPrincipal): OrderActor {
  return { userId: session.userId, name: 'sesion', deviceId: session.deviceId };
}
