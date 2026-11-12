import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { TablesService, type TableActor } from './tables.service';
import {
  bulkLayoutSchema,
  createFloorSchema,
  createTableSchema,
  listTablesQuerySchema,
  renameFloorSchema,
  setTableStatusSchema,
  updateTableSchema,
  type BulkLayoutInput,
  type CreateFloorInput,
  type CreateTableInput,
  type ListTablesQuery,
  type RenameFloorInput,
  type SetTableStatusInput,
  type UpdateTableInput,
} from './tables.types';

/**
 * Salon: sectores y mesas.
 *
 * Todos los endpoints declaran permisos explicitamente: un endpoint sin
 * `@RequirePermissions` hace fallar el guard en vez de quedar abierto. Ninguno toma
 * `orgId`, `venueId` ni `actorId` del body: salen de la sesion, que es lo unico que la
 * RLS y la auditoria pueden dar por cierto.
 *
 * El orden de declaracion pone `/plan` y `/layout` antes que `/:id`: hoy no chocan
 * porque no hay un `GET /tables/:id`, pero si se agrega, tener el literal declarado
 * primero evita depender de ese detalle de Nest.
 */
@ApiTags('tables')
@Controller('tables')
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  @Get('floors')
  @RequirePermissions('floor.read')
  @ApiOperation({ summary: 'Sectores del local con su conteo de mesas' })
  async floors(@CurrentSession() session: SessionPrincipal) {
    return { floors: await this.tables.listFloors(session.orgId, session.venueId) };
  }

  @Post('floors')
  @RequirePermissions('floor.manage')
  @ApiOperation({ summary: 'Crear un sector' })
  async createFloor(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(createFloorSchema)) body: CreateFloorInput,
  ) {
    return {
      floor: await this.tables.createFloor(session.orgId, session.venueId, body, actor(session)),
    };
  }

  @Patch('floors/:id')
  @RequirePermissions('floor.manage')
  @ApiOperation({ summary: 'Renombrar o reordenar un sector' })
  async renameFloor(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(renameFloorSchema)) body: RenameFloorInput,
  ) {
    return {
      floor: await this.tables.renameFloor(
        session.orgId,
        session.venueId,
        id,
        body,
        actor(session),
      ),
    };
  }

  @Get('plan')
  // El plano son sectores Y mesas: con un solo permiso, el que tiene `table.read` sin
  // `floor.read` no podria cargar el editor, ni el que tiene `floor.read` sin
  // `table.read` veria los nombres.
  @RequirePermissions('floor.read', 'table.read')
  @ApiOperation({ summary: 'Plano completo: sectores con sus mesas y su geometria' })
  async plan(@CurrentSession() session: SessionPrincipal) {
    return this.tables.floorPlan(session.orgId, session.venueId);
  }

  @Put('layout')
  @RequirePermissions('table.manage')
  @ApiOperation({ summary: 'Guardar varias posiciones del plano en una sola llamada' })
  async layout(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(bulkLayoutSchema)) body: BulkLayoutInput,
  ) {
    return this.tables.bulkSaveLayout(session.orgId, session.venueId, body.changes);
  }

  @Get()
  @RequirePermissions('table.read')
  @ApiOperation({ summary: 'Mesas del local (opcionalmente de un sector)' })
  async list(
    @CurrentSession() session: SessionPrincipal,
    @Query(new ZodValidationPipe(listTablesQuerySchema)) query: ListTablesQuery,
  ) {
    return {
      tables: await this.tables.listTables(session.orgId, session.venueId, query.floorId),
    };
  }

  @Post()
  @RequirePermissions('table.manage')
  @ApiOperation({ summary: 'Crear una mesa' })
  async create(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(createTableSchema)) body: CreateTableInput,
  ) {
    return {
      table: await this.tables.createTable(session.orgId, session.venueId, body, actor(session)),
    };
  }

  @Patch(':id')
  @RequirePermissions('table.manage')
  @ApiOperation({ summary: 'Editar nombre, lugares o geometria de una mesa' })
  async update(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateTableSchema)) body: UpdateTableInput,
  ) {
    return {
      table: await this.tables.updateTable(
        session.orgId,
        session.venueId,
        id,
        body,
        actor(session),
      ),
    };
  }

  @Post(':id/status')
  @RequirePermissions('table.manage')
  @ApiOperation({
    summary: 'Cambiar el estado a LIBRE, RESERVADA o BLOQUEADA',
    description:
      'OCUPADA y PIDIO_CUENTA no se aceptan: los deriva el sincronizador al abrir o ' +
      'cerrar una comanda.',
  })
  async status(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setTableStatusSchema)) body: SetTableStatusInput,
  ) {
    const table = await this.tables.setStatus(id, body.status, {
      ...actor(session),
      orgId: session.orgId,
      venueId: session.venueId,
    });
    return { table };
  }
}

/**
 * Quién hizo el cambio, para la auditoría.
 *
 * Se arma desde la sesión y no desde el body: un endpoint que aceptara el actor
 * escribiría en `audit_log` el nombre de quien el cliente diga, que es exactamente el
 * dato que el registro tiene que garantizar.
 */
function actor(session: SessionPrincipal): TableActor {
  return { userId: session.userId, name: 'sesion', deviceId: session.deviceId };
}
