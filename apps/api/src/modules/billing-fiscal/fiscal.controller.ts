import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { FiscalService, type FiscalActor } from './fiscal.service';
import {
  issueInvoiceSchema,
  listInvoicesSchema,
  settingsSchema,
  type IssueInvoiceInput,
  type ListInvoicesInput,
  type SettingsInput,
} from './fiscal.types';

/**
 * Facturacion electronica: configuracion del local, emision por comanda y cola
 * de comprobantes con su estado (PENDING/EMITIDA/RECHAZADA/ERROR).
 *
 * Los permisos separan lo que ve el cajero (emitir) de lo que decide la dueña
 * (cambiar el proveedor o el ambiente). La UI de estados tiene que filtrar por
 * `invoice.read`; esta capa lo exige siempre.
 */
@ApiTags('fiscal')
@Controller('fiscal')
export class FiscalController {
  constructor(private readonly fiscal: FiscalService) {}

  @Get('settings')
  @RequirePermissions('fiscal.manage')
  @ApiOperation({ summary: 'Configuracion fiscal del local (proveedor, ambiente, CAEA)' })
  async getSettings(@CurrentSession() session: SessionPrincipal) {
    return this.fiscal.getSettings(session.orgId, session.venueId);
  }

  @Put('settings')
  @RequirePermissions('fiscal.manage')
  @ApiOperation({ summary: 'Crear o actualizar la configuracion fiscal' })
  async putSettings(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(settingsSchema)) body: SettingsInput,
  ) {
    return this.fiscal.putSettings(session.orgId, session.venueId, body, actor(session));
  }

  @Post('invoices/orders/:orderId')
  @RequirePermissions('invoice.issue')
  @ApiOperation({ summary: 'Emitir el comprobante de una comanda cerrada' })
  async issue(
    @CurrentSession() session: SessionPrincipal,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body(new ZodValidationPipe(issueInvoiceSchema)) body: IssueInvoiceInput,
  ) {
    return this.fiscal.issueInvoice(session.orgId, session.venueId, orderId, body, actor(session));
  }

  @Get('invoices')
  @RequirePermissions('invoice.read')
  @ApiOperation({ summary: 'Cola y libro de comprobantes del local' })
  async list(
    @CurrentSession() session: SessionPrincipal,
    @Query(new ZodValidationPipe(listInvoicesSchema)) query: ListInvoicesInput,
  ) {
    return this.fiscal.listInvoices(session.orgId, session.venueId, query);
  }

  @Get('invoices/:id')
  @RequirePermissions('invoice.read')
  @ApiOperation({ summary: 'Detalle de un comprobante' })
  async get(@CurrentSession() session: SessionPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.fiscal.getInvoice(session.orgId, session.venueId, id);
  }

  @Post('invoices/:id/retry')
  @RequirePermissions('invoice.issue')
  @ApiOperation({ summary: 'Reintentar un comprobante con error o rechazo' })
  async retry(@CurrentSession() session: SessionPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.fiscal.retry(session.orgId, session.venueId, id, actor(session));
  }
}

function actor(session: SessionPrincipal): FiscalActor {
  return { userId: session.userId, name: 'sesion', deviceId: session.deviceId };
}
