import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { KdsService, type KdsActor } from './kds.service';
import {
  listTicketsQuerySchema,
  setTicketStatusSchema,
  type ListTicketsQuery,
  type SetTicketStatusInput,
} from './kds.types';

/**
 * Cocina, por HTTP.
 *
 * El gateway del KDS cubre la latencia (un ticket nuevo aparece sin que el POS haga un
 * pull). Lo que esta es lo que el KDS necesita **al abrir** y para el camino online:
 * un mostrador con red tiene que poder pintar la pantalla y hacer avanzar un ticket sin
 * depender del socket, y un mostrador sin red no tiene socket.
 *
 * Ningun endpoint toma `orgId`, `venueId` ni `actorId` del body: salen de la sesion, que
 * es lo unico que la RLS y la auditoria pueden dar por cierto. Un `venueId` en el body
 * permitiria que un Encargado del local A moviera tickets del local B.
 *
 * Los permisos son `kitchen.*` y no `order.*`: ver la cocina y hacer avanzar un ticket
 * no es lo mismo que tomar un pedido. Con `order.read` el KDS quedaria abierto para
 * cualquiera que pueda abrir una comanda, y con `order.item.void` para arreglar un error
 * de cocina habria que ser Encargado.
 */
@ApiTags('kds')
@Controller('kds')
export class KdsController {
  constructor(private readonly kds: KdsService) {}

  @Get('tickets')
  @RequirePermissions('kitchen.read')
  @ApiOperation({
    summary: 'Tickets de cocina del local, con sus lineas y las estaciones',
    description:
      'Sin `status` devuelve NEW, PREPARING y READY: lo que hay que hacer y lo que se ' +
      'esta haciendo. Los servidos quedan afuera salvo que se pidan explicitamente.',
  })
  async list(
    @CurrentSession() session: SessionPrincipal,
    @Query(new ZodValidationPipe(listTicketsQuerySchema)) query: ListTicketsQuery,
  ) {
    return this.kds.board(session.orgId, session.venueId, query);
  }

  @Get('stations')
  @RequirePermissions('kitchen.read')
  @ApiOperation({ summary: 'Estaciones activas del local, en el orden de la pantalla' })
  async stations(@CurrentSession() session: SessionPrincipal) {
    return { stations: await this.kds.stations(session.orgId, session.venueId) };
  }

  @Post('tickets/:id/status')
  @RequirePermissions('kitchen.advance')
  @ApiOperation({
    summary: 'Avanza un ticket de cocina (NEW -> PREPARING -> READY -> SERVED)',
    description:
      'Solo avanza: volver atras se rechaza con 409 y no con 422, porque es una regla ' +
      'del turno y no un dato invalido. Poner el mismo estado dos veces no es un error.',
  })
  async setStatus(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setTicketStatusSchema)) body: SetTicketStatusInput,
  ) {
    return this.kds.setStatus(session.orgId, session.venueId, id, body.status, actor(session));
  }
}

/**
 * Quien hizo el cambio.
 *
 * Se arma desde la sesion y no desde el body: un endpoint que aceptara el actor
 * escribiria en el registro el nombre de quien el cliente diga, que es exactamente el
 * dato que el registro tiene que garantizar.
 */
function actor(session: SessionPrincipal): KdsActor {
  return { userId: session.userId, name: 'sesion', deviceId: session.deviceId };
}
