import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PromotionsService, type PromotionActor } from './promotions.service';
import { createRuleSchema, updateRuleSchema, type CreateRuleInput, type UpdateRuleInput } from './promotions.types';

/**
 * Promociones y happy hour. Las reglas se evaluan en el cliente (POS) y en el
 * servidor con el mismo paquete (`@comanda/pricing-engine`): este controller
 * es el CRUD de las reglas que los dos ejecutan.
 *
 * Baja logica (active=false): las promos viejas quedan en comandas pasadas
 * (el snapshot en `applied_rules` las explica), asi que nunca se borran fisico.
 */
@ApiTags('promotions')
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @RequirePermissions('promotion.read')
  @ApiOperation({ summary: 'Promos del local (activas y dadas de baja)' })
  async list(
    @CurrentSession() session: SessionPrincipal,
    @Query('active') active?: string,
    @Query('type') type?: string,
  ) {
    return this.promotions.list(session.orgId, session.venueId, {
      active: active === undefined ? undefined : active === 'true',
      type,
    });
  }

  @Post()
  @RequirePermissions('promotion.manage')
  @ApiOperation({ summary: 'Crear una promo (descuento, happy hour, 2x1, precio fijo)' })
  async create(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(createRuleSchema)) body: CreateRuleInput,
  ) {
    return this.promotions.create(session.orgId, session.venueId, body, actor(session));
  }

  @Patch(':id')
  @RequirePermissions('promotion.manage')
  @ApiOperation({ summary: 'Cambiar prioridad, horario, params o estado' })
  async update(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateRuleSchema)) body: UpdateRuleInput,
  ) {
    return this.promotions.update(session.orgId, session.venueId, id, body, actor(session));
  }

  @Delete(':id')
  @RequirePermissions('promotion.manage')
  @ApiOperation({ summary: 'Dar de baja (active = false). No borra la fila.' })
  async remove(@CurrentSession() session: SessionPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.promotions.remove(session.orgId, session.venueId, id, actor(session));
  }
}

function actor(session: SessionPrincipal): PromotionActor {
  return { userId: session.userId, name: 'sesion', deviceId: session.deviceId };
}
