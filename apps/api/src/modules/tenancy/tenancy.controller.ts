import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  deviceRegistrationSchema,
  venueInputSchema,
  type DeviceRegistration,
  type VenueInput,
} from '@comanda/domain';
import { ERROR_CODES, problemDetails } from '@comanda/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { TenancyService } from './tenancy.service';
import { CurrentSession, Public, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RateLimitGuard } from '../../common/rate-limit/rate-limit.guard';

/** Motivo obligatorio para revocar un dispositivo. */
const revokeDeviceSchema = z.object({
  reason: z.string().min(3, 'Conta por que lo estas revocando.').max(300),
});
type RevokeDeviceInput = z.infer<typeof revokeDeviceSchema>;

/** La huella del aparato. Minimo 8 caracteres: no tiene que ser un UUID. */
const resolveDeviceSchema = z.object({
  fingerprint: z.string().min(8).max(128),
});

/**
 * Lo que devuelve `resolveDevice`.
 *
 * Un tipo propio y no `Device` a proposito: `Device` incluye datos internos que no
 * tienen por que viajar a un endpoint sin sesion. Que la respuesta pase por un tipo
 * mas angosto significa que un campo nuevo no se filtra por olvidarse de sacarlo.
 */
export const resolvedDeviceSchema = z.object({
  device: z.object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.string(),
    status: z.string(),
  }),
  venue: z.object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.string(),
  }),
  org: z.object({
    id: z.string().uuid(),
    name: z.string(),
    currency: z.string(),
    timezone: z.string(),
  }),
});
export type ResolvedDevice = z.infer<typeof resolvedDeviceSchema>;

/**
 * Tenancy: organizacion, locales y dispositivos.
 *
 * Todos los endpoints declaran permisos explicitamente. Un endpoint sin
 * `@RequirePermissions` hace fallar el guard en vez de quedar abierto (ver
 * `PermissionsGuard`), asi que olvidar un permiso es un error visible.
 */
@ApiTags('tenancy')
@Controller()
export class TenancyController {
  constructor(private readonly tenancy: TenancyService) {}

  @Get('organization')
  @RequirePermissions('org.read')
  @ApiOperation({ summary: 'Organización de la sesión actual' })
  async organization(@CurrentSession() session: SessionPrincipal) {
    const org = await this.tenancy.getOrganization(session.orgId);
    return { organization: org };
  }

  @Get('venues')
  @RequirePermissions('venue.read')
  @ApiOperation({ summary: 'Locales de la organización' })
  async venues(@CurrentSession() session: SessionPrincipal) {
    return { venues: await this.tenancy.listVenues(session.orgId) };
  }

  @Post('venues')
  @RequirePermissions('venue.update')
  @ApiOperation({ summary: 'Crear un local' })
  async createVenue(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(venueInputSchema)) body: VenueInput,
  ) {
    const venue = await this.tenancy.createVenue(session.orgId, body, {
      userId: session.userId,
      name: 'sesion',
    });
    return { venue };
  }

  @Get('devices')
  @RequirePermissions('device.read')
  @ApiOperation({ summary: 'Dispositivos del local' })
  async devices(@CurrentSession() session: SessionPrincipal, @Req() req: Request) {
    const venueId = typeof req.query.venueId === 'string' ? req.query.venueId : undefined;
    return { devices: await this.tenancy.listDevices(session.orgId, venueId) };
  }

  /**
   * Resuelve un dispositivo por su huella, sin sesion.
   *
   * Es lo que permite que un POS recien instalado sepa si esta autorizado **antes**
   * de tener credenciales. Sin este endpoint el POS no tiene forma de enterarse de
   * cual es su propio dispositivo: `GET /devices` exige sesion, la lista local
   * queda siempre vacia y la pantalla de PIN no tiene nada que mostrar. Un POS que
   * no puede entrar no es un POS.
   *
   * Publico no significa abierto: devuelve solo datos de rotulo (los nombres) y
   * nada que sirva para autenticarse. Quien tiene la huella tiene el aparato en la
   * mano, y la huella es un UUID que se genera una vez y queda en el dispositivo.
   *
   * El `RateLimitGuard` va explicito porque `PUBLIC_ROUTES` de `app.module.ts`
   * excluye este camino del middleware de auth, y sin rate limit cualquiera podria
   * enumerar huellas probando UUIDs.
   */
  @Post('devices/resolve')
  @Public()
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resuelve un dispositivo por huella, para que el POS sepa si está autorizado',
  })
  async resolveDevice(
    @Body(new ZodValidationPipe(resolveDeviceSchema)) body: { fingerprint: string },
  ): Promise<ResolvedDevice> {
    const resolved = await this.tenancy.resolveDeviceForPos(body.fingerprint);

    if (!resolved) {
      throw new NotFoundException(
        problemDetails({
          status: 404,
          code: ERROR_CODES.NOT_FOUND,
          detail:
            'Este aparato no está registrado en ningún local. Pedí que lo aprueben antes de entrar.',
        }),
      );
    }

    return resolved;
  }

  @Post('devices')
  @RequirePermissions('device.register')
  @ApiOperation({
    summary: 'Registrar un dispositivo (queda pendiente de aprobación)',
  })
  async registerDevice(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(deviceRegistrationSchema)) body: DeviceRegistration,
  ) {
    const device = await this.tenancy.registerDevice(session.orgId, body, {
      userId: session.userId,
      name: 'sesion',
    });
    return { device };
  }

  @Patch('devices/:id/approve')
  @RequirePermissions('device.register')
  @ApiOperation({ summary: 'Aprobar un dispositivo para que pueda usarse con PIN' })
  async approveDevice(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const device = await this.tenancy.approveDevice(session.orgId, id, {
      userId: session.userId,
      name: 'sesion',
    });
    return { device };
  }

  @Patch('devices/:id/revoke')
  @RequirePermissions('device.revoke')
  @ApiOperation({ summary: 'Revocar un dispositivo (exige motivo)' })
  async revokeDevice(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(revokeDeviceSchema)) body: RevokeDeviceInput,
  ) {
    const device = await this.tenancy.revokeDevice(session.orgId, id, body.reason, {
      userId: session.userId,
      name: 'sesion',
    });
    return { device };
  }
}
