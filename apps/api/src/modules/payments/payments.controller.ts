import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ERROR_CODES, problemDetails } from '@comanda/domain';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PaymentsService, type PaymentActor } from './payments.service';
import {
  addTipSchema,
  paySchema,
  splitBillSchema,
  type AddTipInput,
  type PayInput,
  type SplitBillInput,
} from './payments.types';

/**
 * Cobro.
 *
 * El prefijo es `/orders` y no `/payments` porque la unidad de negocio es la comanda: un
 * pago no se consulta por id (no hay pantalla de "el pago 812"), se consulta como parte de
 * una cuenta. Es tambien la ruta que fija el plan (§7).
 *
 * `CARD`, `QR` y `TRANSFER` son pagos **externos**: el POS habla con la terminal o con la
 * pasarela y despues manda el comprobante. La API nunca ve el numero de tarjeta y ningun
 * campo de estos endpoints puede contenerlo (PLAN §6, PCI).
 */
@ApiTags('payments')
@Controller('orders')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get(':id/remaining')
  @RequirePermissions('bill.read')
  @ApiOperation({ summary: 'Cuánto falta cobrar: total menos pagado, en enteros' })
  async remaining(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.payments.remainingToPay(session.orgId, session.venueId, id);
  }

  @Post(':id/pay')
  @RequirePermissions('bill.pay')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'UUID del cobro. Repetir el request con la misma clave devuelve el cobro registrado ' +
      'sin cobrar de nuevo.',
  })
  @ApiOperation({
    summary: 'Cobrar la comanda, en efectivo, tarjeta, QR, transferencia o mezclado',
    description:
      'Las líneas son pagos externos por separado: la API solo recibe el comprobante del ' +
      'proveedor, nunca el dato de la tarjeta.',
  })
  async pay(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(paySchema)) body: PayInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);

    const result = await this.payments.pay(
      session.orgId,
      session.venueId,
      id,
      body,
      actor(session),
      key,
    );

    // `chargedIds` no se devuelve: es interno del servicio (sirve para auditar solo las
    // lineas de este request) y no le sirve de nada al POS.
    return {
      orderId: id,
      payments: result.payments,
      totals: result.totals,
      closed: result.closed,
      replay: result.replay,
    };
  }

  @Post(':id/split')
  @RequirePermissions('bill.split')
  @ApiOperation({
    summary: 'Calcular y guardar el reparto de la cuenta',
    description:
      'Se persiste tal como se muestra en pantalla: si el reparto ya se calculó en el ' +
      'cliente, se manda en `allocations` y se valida que sume el total.',
  })
  async split(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(splitBillSchema)) body: SplitBillInput,
  ) {
    const split = await this.payments.splitBill(
      session.orgId,
      session.venueId,
      id,
      body,
      actor(session),
    );
    return { split };
  }

  @Post(':id/tip')
  @RequirePermissions('bill.pay')
  @ApiOperation({ summary: 'Sumar propina a la comanda, por importe o por porcentaje' })
  async tip(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addTipSchema)) body: AddTipInput,
  ) {
    return this.payments.addTip(session.orgId, session.venueId, id, body);
  }
}

/**
 * Quien cobro, para la auditoría y para el pago mismo.
 *
 * Se arma desde la sesión y no desde el body: un endpoint que aceptara el actor escribiría
 * en `audit_log` y en `payments.received_by` el nombre de quien el cliente diga, que es
 * exactamente el dato que el registro tiene que garantizar.
 */
function actor(session: SessionPrincipal): PaymentActor {
  return { userId: session.userId, name: 'sesion', deviceId: session.deviceId };
}

/**
 * La clave de idempotencia es obligatoria y tiene que ser un UUID.
 *
 * Va al `payments.source_event_id`, que es `uuid` y unico: aceptarla sin validar daria dos
 * caminos, uno que cobra y otro que falla con un error de Postgres en el mostrador. Un 400
 * aqui dice "mandá la clave" en vez de "duplicate key value violates unique constraint".
 */
function requireIdempotencyKey(header: string | undefined): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!header) {
    throw new BadRequestException(
      problemDetails({
        status: 400,
        code: ERROR_CODES.VALIDATION_FAILED,
        detail: 'Falta el header Idempotency-Key: sin él, un reintento puede cobrar dos veces.',
      }),
    );
  }

  if (!uuid.test(header)) {
    throw new BadRequestException(
      problemDetails({
        status: 400,
        code: ERROR_CODES.VALIDATION_FAILED,
        detail: 'El Idempotency-Key tiene que ser un UUID.',
        errors: [{ path: 'Idempotency-Key', message: 'Formato inválido.' }],
      }),
    );
  }

  return header;
}
