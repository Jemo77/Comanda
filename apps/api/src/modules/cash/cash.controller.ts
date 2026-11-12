import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CashService, type CashActor } from './cash.service';
import {
  cashMovementSchema,
  closeShiftSchema,
  openShiftSchema,
  type CashMovementInput,
  type CloseShiftInput,
  type OpenShiftInput,
} from './cash.types';

/**
 * Caja y turnos.
 *
 * El prefijo es `/shifts` porque lo que se abre y se cierra es el turno; los movimientos de
 * efectivo cuelgan de el porque un movimiento sin turno no existe a efectos del arqueo.
 *
 * Los permisos de este controller son la parte importante:
 *
 *  - `shift.open` / `shift.close` / `cash.movement` los tiene el Cajero (y los de arriba).
 *  - `cash.viewExpected` **no** lo tiene el Cajero: es lo unico que separa su pantalla de la
 *    del Encargado, y por eso esta declarado aca y no escondido en el servicio.
 *
 * Ningun endpoint de este controller devuelve `expected_cash_cents` a un cajero, porque los
 * que los devuelven exigen `cash.viewExpected` y el resto responde con la proyeccion a
 * ciegas de `cash.service.ts`.
 */
@ApiTags('shifts')
@Controller('shifts')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Post()
  @RequirePermissions('shift.open')
  @ApiOperation({
    summary: 'Abrir la caja del local',
    description: 'Solo puede haber un turno abierto por local: si ya hay, responde 409.',
  })
  async open(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(openShiftSchema)) body: OpenShiftInput,
  ) {
    const shift = await this.cash.openShift(session.orgId, session.venueId, body, actor(session));
    return { shift };
  }

  @Get('current')
  @RequirePermissions('shift.open')
  @ApiOperation({ summary: 'Turno abierto del local, o null. Nunca incluye el esperado' })
  async current(@CurrentSession() session: SessionPrincipal) {
    return { shift: await this.cash.currentShift(session.orgId, session.venueId) };
  }

  @Post('movements')
  @RequirePermissions('cash.movement')
  @ApiOperation({
    summary: 'Movimiento de efectivo del turno',
    description: 'El signo lo decide el tipo: IN suma, OUT y RETIRO restan. Exige motivo.',
  })
  async movement(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(cashMovementSchema)) body: CashMovementInput,
  ) {
    return this.cash.cashMovement(session.orgId, session.venueId, body, actor(session));
  }

  @Post(':id/close')
  @RequirePermissions('shift.close')
  @ApiOperation({
    summary: 'Cerrar el turno con arqueo ciego',
    description:
      'El cajero declara lo que tiene. El servidor calcula el esperado y la diferencia y ' +
      'los guarda, pero la respuesta NO los incluye: eso lo ve quien tenga cash.viewExpected.',
  })
  async close(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(closeShiftSchema)) body: CloseShiftInput,
  ) {
    const shift = await this.cash.closeShift(
      session.orgId,
      session.venueId,
      id,
      body,
      actor(session),
    );
    return { shift };
  }

  @Get(':id/expected')
  @RequirePermissions('cash.viewExpected')
  @ApiOperation({
    summary: 'Efectivo esperado, declarado y diferencia del turno',
    description:
      'Requiere cash.viewExpected: el cajero declara a ciegas y ver el esperado convertira ' +
      'el arqueo en un conteo con ayuda.',
  })
  async expected(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.cash.expectedCash(session.orgId, session.venueId, id);
  }

  @Get(':id/report')
  @RequirePermissions('cash.viewExpected')
  @ApiOperation({
    summary: 'Arqueo del turno: ventas por metodo, movimientos y declarado contra esperado',
  })
  async report(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.cash.shiftReport(session.orgId, session.venueId, id);
  }
}

/**
 * Quién operó la caja, para la auditoría.
 *
 * Se arma desde la sesión y nunca desde el body: `audit_log.actor_id` y
 * `shifts.opened_by` tienen que decir quien abrio la caja, no quien lo dice el cliente.
 */
function actor(session: SessionPrincipal): CashActor {
  return { userId: session.userId, name: 'sesion', deviceId: session.deviceId };
}
