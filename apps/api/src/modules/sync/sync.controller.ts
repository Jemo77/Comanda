import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SyncService, pullSchema, pushSchema } from './sync.service';
import type { PullResult, PushResult, SyncEventInput } from './sync.types';

/**
 * Endpoint de sincronizacion.
 *
 * Es lo unico que el POS necesita para converger. `/push` sube la outbox y `/pull`
 * baja lo que paso mientras estuvo offline, incluido lo que otro dispositivo
 * hizo sobre las mismas mesas.
 */
@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('auth.refresh')
  @ApiOperation({
    summary: 'Sube la outbox del dispositivo (idempotente por eventId)',
  })
  async push(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(pushSchema)) body: { events: SyncEventInput[] },
  ): Promise<PushResult> {
    // El `deviceId` sale de la sesion, nunca del body: si un dispositivo pudiera
    // declarar otro, podría escribir eventos en nombre de otro y romper la
    // resolucion de conflictos de mesas.
    return this.sync.push({
      deviceId: session.deviceId ?? '00000000-0000-0000-0000-000000000000',
      orgId: session.orgId,
      venueId: session.venueId,
      actorId: session.userId,
      events: body.events,
    });
  }

  @Get('pull')
  @RequirePermissions('auth.refresh')
  @ApiOperation({ summary: 'Baja incremental desde un cursor' })
  async pull(
    @CurrentSession() session: SessionPrincipal,
    @Query(new ZodValidationPipe(pullSchema)) query: { since?: bigint; limit?: number },
  ): Promise<PullResult> {
    return this.sync.pull({
      orgId: session.orgId,
      venueId: session.venueId,
      deviceId: session.deviceId ?? '00000000-0000-0000-0000-000000000000',
      since: query.since?.toString(),
      limit: query.limit,
    });
  }
}

export type { Request };
