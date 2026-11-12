import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ERROR_CODES,
  type Category,
  type Modifier,
  type ModifierGroup,
  type Product,
  type ProductWithModifiers,
  type Station,
} from '@comanda/domain';
import { CatalogService } from './catalog.service';
import {
  createCategorySchema,
  createModifierGroupSchema,
  createModifierSchema,
  createProductSchema,
  createStationSchema,
  productFilterSchema,
  setAvailabilitySchema,
  updateCategorySchema,
  updateModifierGroupSchema,
  updateModifierSchema,
  updateProductSchema,
  updateStationSchema,
  type CreateCategoryInput,
  type CreateModifierGroupInput,
  type CreateModifierInput,
  type CreateProductInput,
  type CreateStationInput,
  type ProductFilter,
  type SetAvailabilityInput,
  type UpdateCategoryInput,
  type UpdateModifierGroupInput,
  type UpdateModifierInput,
  type UpdateProductInput,
  type UpdateStationInput,
} from './catalog.types';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

/**
 * Catalogo: estaciones, categorias, productos y modificadores.
 *
 * Todos los endpoints declaran permisos explicitamente. Un endpoint sin
 * `@RequirePermissions` hace fallar el guard en vez de quedar abierto (ver
 * `PermissionsGuard`), asi que olvidar uno es un error visible y no una puerta
 * abierta.
 *
 * `orgId`, `venueId`, `actorId` y `deviceId` salen **siempre** de la sesion. Nunca
 * del body ni de un header: un `venueId` que acepta el cliente permitiria que un
 * Encargado escribiera en el catalogo de otro local de la misma organizacion, y un
 * `orgId` en el body seria una fuga entre tenants esperando que alguien lo pruebe.
 *
 * Nota sobre las claves de permiso: el catalogo tiene `category.*`, `product.*` y
 * `modifier.*`, pero no tiene `station.*` ni `product.availabilityChanged`. Las
 * estaciones se gobiernan con `product.*` (existen para rutear productos hacia
 * impresoras: es parte del mismo problema) y la disponibilidad se exige con
 * `product.manage`, que es lo mas restrictivo que existe hoy. Si manana se separan
 * esas dos claves, cambiar el decorador es una linea por endpoint.
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ---------------------------------------------------------------------------
  // Estaciones
  // ---------------------------------------------------------------------------

  @Get('stations')
  @RequirePermissions('product.read')
  @ApiOperation({ summary: 'Estaciones de trabajo del local (barra, cocina, cafe)' })
  async listStations(
    @CurrentSession() session: SessionPrincipal,
  ): Promise<{ stations: Station[] }> {
    return { stations: await this.catalog.listStations(session.orgId, session.venueId) };
  }

  @Post('stations')
  @RequirePermissions('product.manage')
  @ApiOperation({ summary: 'Crear una estacion de trabajo' })
  async createStation(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(createStationSchema)) body: CreateStationInput,
  ): Promise<{ station: Station }> {
    const station = await this.catalog.createStation(session.orgId, session.venueId, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { station };
  }

  @Patch('stations/:id')
  @RequirePermissions('product.manage')
  @ApiOperation({ summary: 'Editar una estacion de trabajo' })
  async updateStation(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateStationSchema)) body: UpdateStationInput,
  ): Promise<{ station: Station }> {
    const station = await this.catalog.updateStation(session.orgId, session.venueId, id, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { station };
  }

  // ---------------------------------------------------------------------------
  // Categorias
  // ---------------------------------------------------------------------------

  @Get('categories')
  @RequirePermissions('category.read')
  @ApiOperation({ summary: 'Categorias del local y las compartidas por la organizacion' })
  async listCategories(
    @CurrentSession() session: SessionPrincipal,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<{ categories: Category[] }> {
    const categories = await this.catalog.listCategories(session.orgId, session.venueId, {
      // Solo la pantalla de administracion necesita ver lo archivado; la carta del
      // POS no, y no tiene por que pedirlo.
      includeArchived: includeArchived === 'true',
    });
    return { categories };
  }

  @Post('categories')
  @RequirePermissions('category.manage')
  @ApiOperation({ summary: 'Crear una categoria' })
  async createCategory(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput,
  ): Promise<{ category: Category }> {
    const category = await this.catalog.createCategory(session.orgId, session.venueId, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { category };
  }

  @Patch('categories/:id')
  @RequirePermissions('category.manage')
  @ApiOperation({ summary: 'Editar o reactivar una categoria' })
  async updateCategory(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
  ): Promise<{ category: Category }> {
    const category = await this.catalog.updateCategory(session.orgId, id, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { category };
  }

  // ---------------------------------------------------------------------------
  // Productos
  // ---------------------------------------------------------------------------

  @Get('products')
  @RequirePermissions('product.read')
  @ApiOperation({
    summary: 'Productos del local (por defecto, solo los disponibles)',
  })
  async listProducts(
    @CurrentSession() session: SessionPrincipal,
    @Query(new ZodValidationPipe(productFilterSchema)) query: ProductFilter,
  ): Promise<{ products: Product[] }> {
    return { products: await this.catalog.listProducts(session.orgId, session.venueId, query) };
  }

  @Post('products')
  @RequirePermissions('product.manage')
  @ApiOperation({ summary: 'Crear un producto' })
  async createProduct(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ): Promise<{ product: Product }> {
    const product = await this.catalog.createProduct(session.orgId, session.venueId, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { product };
  }

  @Patch('products/:id')
  @RequirePermissions('product.manage')
  @ApiOperation({
    summary: 'Editar un producto (cambiar el precio exige motivo y queda auditado)',
  })
  async updateProduct(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ): Promise<{ product: Product }> {
    // El permiso de cambiar precios es mas fino que `product.manage`: el Cajero lo
    // tiene y el Mozo no. Se verifica aca, y no con el decorador, porque depende de
    // si el body trae `priceCents`: declararlo en el decorador le negaria al Cajero
    // hasta cambiar el nombre de un producto.
    if (body.priceCents !== undefined && !session.permissions.includes('product.priceChange')) {
      // `missing` no viene de `problemDetails`: el guard lo arma a mano en el
      // `response` crudo de Nest justamente porque el POS necesita la lista de
      // permisos que le faltan para explicar el boton deshabilitado sin inventar el
      // motivo. Se replica esa forma para que el cliente tenga un solo formato.
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        detail: 'Tu rol puede editar el producto, pero no cambiar precios.',
        missing: ['product.priceChange'],
      });
    }

    const product = await this.catalog.updateProduct(session.orgId, session.venueId, id, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { product };
  }

  @Post('products/:id/availability')
  @RequirePermissions('product.manage')
  @ApiOperation({ summary: 'Activar o desactivar un producto (queda auditado)' })
  async setAvailability(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setAvailabilitySchema)) body: SetAvailabilityInput,
  ): Promise<{ product: Product }> {
    const product = await this.catalog.setAvailability(session.orgId, session.venueId, id, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { product };
  }

  @Get('products/:id/full')
  @RequirePermissions('product.read')
  @ApiOperation({
    summary: 'Producto con sus grupos y modificadores anidados (una sola consulta)',
  })
  async productFull(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ product: ProductWithModifiers }> {
    const product = await this.catalog.productWithModifiers(session.orgId, session.venueId, id);
    return { product };
  }

  // ---------------------------------------------------------------------------
  // Modificadores
  // ---------------------------------------------------------------------------

  @Get('modifier-groups')
  @RequirePermissions('modifier.read')
  @ApiOperation({ summary: 'Grupos de modificadores de la organizacion' })
  async listModifierGroups(
    @CurrentSession() session: SessionPrincipal,
  ): Promise<{ groups: ModifierGroup[] }> {
    return { groups: await this.catalog.listModifierGroups(session.orgId) };
  }

  @Post('modifier-groups')
  @RequirePermissions('modifier.manage')
  @ApiOperation({ summary: 'Crear un grupo de modificadores' })
  async createModifierGroup(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(createModifierGroupSchema)) body: CreateModifierGroupInput,
  ): Promise<{ group: ModifierGroup }> {
    const group = await this.catalog.createModifierGroup(session.orgId, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { group };
  }

  @Patch('modifier-groups/:id')
  @RequirePermissions('modifier.manage')
  @ApiOperation({ summary: 'Editar un grupo de modificadores' })
  async updateModifierGroup(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateModifierGroupSchema)) body: UpdateModifierGroupInput,
  ): Promise<{ group: ModifierGroup }> {
    const group = await this.catalog.updateModifierGroup(session.orgId, id, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { group };
  }

  @Get('modifier-groups/:id/modifiers')
  @RequirePermissions('modifier.read')
  @ApiOperation({ summary: 'Modificadores de un grupo' })
  async listModifiers(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ modifiers: Modifier[] }> {
    return { modifiers: await this.catalog.listModifiers(session.orgId, id) };
  }

  @Post('modifiers')
  @RequirePermissions('modifier.manage')
  @ApiOperation({ summary: 'Crear un modificador' })
  async createModifier(
    @CurrentSession() session: SessionPrincipal,
    @Body(new ZodValidationPipe(createModifierSchema)) body: CreateModifierInput,
  ): Promise<{ modifier: Modifier }> {
    const modifier = await this.catalog.createModifier(session.orgId, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { modifier };
  }

  @Patch('modifiers/:id')
  @RequirePermissions('modifier.manage')
  @ApiOperation({ summary: 'Editar un modificador' })
  async updateModifier(
    @CurrentSession() session: SessionPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateModifierSchema)) body: UpdateModifierInput,
  ): Promise<{ modifier: Modifier }> {
    const modifier = await this.catalog.updateModifier(session.orgId, id, body, {
      userId: session.userId,
      deviceId: session.deviceId,
    });
    return { modifier };
  }
}
