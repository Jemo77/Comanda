import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEYS, PERMISSION_KEY_SET } from '@comanda/domain';
import { PERMISSIONS_KEY, PermissionsGuard } from '../../src/common/authz/permissions.guard';
import { CatalogController } from '../../src/modules/catalog/catalog.controller';
import { CatalogService } from '../../src/modules/catalog/catalog.service';
import { CatalogModule } from '../../src/modules/catalog/catalog.module';
import { AuditService } from '../../src/modules/audit/audit.service';

/**
 * Autorizacion del catalogo.
 *
 * `RequirePermissions` acepta `string`, no `PermissionKey`: un typo como
 * `catalogue.manage` compila, el guard lo resuelve contra el catalogo y la ruta queda
 * cerrada para todos (o abierta, segun quien tenga el permiso inventado). Estos tests
 * existen porque el typecheck no puede ver eso.
 *
 * El segundo grupo cubre lo que un typecheck tampoco puede: que ningun handler quede
 * sin permiso y que el modulo declare bien sus providers.
 */
describe('catalog: autorizacion de los endpoints', () => {
  const reflector = new Reflector();
  const prototype = CatalogController.prototype;

  /** Rutas (handler + permisos declarados) del controlador. */
  const rutas = Reflect.ownKeys(prototype)
    .filter((key) => typeof key === 'string' && key !== 'constructor')
    .flatMap((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, descriptor.value as object) as
        string[] | undefined;
      return permissions === undefined ? [] : [{ handler: key, permissions }];
    });

  it('declara permisos en todas las rutas', () => {
    expect(rutas.length).toBeGreaterThan(0);
    const sinPermisos = rutas.filter((r) => r.permissions.length === 0).map((r) => r.handler);
    // Una ruta sin `@RequirePermissions` no queda abierta: el guard la rechaza. Pero es
    // un error de desarrollo que tiene que verse aca y no en el primer request.
    expect(sinPermisos).toEqual([]);
  });

  it('usa solo claves que existen en el catalogo de permisos', () => {
    const inexistentes = rutas
      .flatMap((r) => r.permissions)
      .filter((p) => !PERMISSION_KEY_SET.has(p));
    expect(inexistentes).toEqual([]);
  });

  it('exige el permiso mas restrictivo en las escrituras sensibles', () => {
    const permisoDe = (handler: string) => rutas.find((r) => r.handler === handler)?.permissions;

    // La disponibilidad es accion de operacion diaria (se agoto, paso el turno), no una
    // baja de catalogo: va con `manage`, no con `priceChange`.
    expect(permisoDe('setAvailability')).toEqual(['product.manage']);

    // Editar el producto pide `manage`; el precio tiene su propia clave, mas fina, que
    // el controlador verifica aparte porque depende de si el body trae `priceCents`.
    expect(permisoDe('updateProduct')).toEqual(['product.manage']);

    // Las lecturas las puede hacer cualquiera que atienda mesas: si exigieran `manage`,
    // el mozo no podria ni pintar la carta.
    expect(permisoDe('listProducts')).toEqual(['product.read']);
    expect(permisoDe('listCategories')).toEqual(['category.read']);
    expect(permisoDe('productFull')).toEqual(['product.read']);
    expect(permisoDe('listModifierGroups')).toEqual(['modifier.read']);
  });

  it('el guard deja pasar las rutas del catalogo a un Dueño', () => {
    // El Dueño tiene TODAS las claves (`PERMISSION_KEYS`). Si el catalogo de permisos
    // y el modulo se desincronizan, el fallo es "403 para todos" en produccion, y este
    // test es el que lo dice primero.
    const guard = new PermissionsGuard(reflector);
    const contexto = {
      switchToHttp: () => ({
        getRequest: () => ({
          principal: {
            userId: 'u',
            orgId: 'o',
            venueId: 'v',
            roleIds: [],
            roleKeys: ['dueno'],
            permissions: [...PERMISSION_KEYS],
            constraints: {},
            deviceId: null,
            sessionId: 's',
            authMethod: 'password' as const,
          },
        }),
      }),
      getHandler: () => prototype.listProducts,
      getClass: () => CatalogController,
    } as never;

    expect(guard.canActivate(contexto)).toBe(true);
  });
});

describe('catalog: el modulo declara sus providers', () => {
  it('expone el controlador, declara el servicio y lo exporta', () => {
    const controllers = Reflect.getMetadata('controllers', CatalogModule) as unknown[];
    const providers = Reflect.getMetadata('providers', CatalogModule) as unknown[];
    const exports = Reflect.getMetadata('exports', CatalogModule) as unknown[];

    expect(controllers).toContain(CatalogController);
    expect(providers).toContain(CatalogService);
    // Exportado para que el futuro modulo de ordenes lea productos para snapshots sin
    // reimportar el modulo entero.
    expect(exports).toContain(CatalogService);
  });

  it('el servicio solo depende de la base y la auditoria', async () => {
    // Los tokens `DATABASE` y `APP_ENV` los provee `DatabaseModule`, que es
    // `@Global()`. Si aparece una tercera dependencia, alguien la agrego sin pillar el
    // modulo que la provee y el fallo sale en el arranque de produccion, no en un test.
    const mod = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [
        CatalogService,
        { provide: 'DATABASE', useValue: { query: async () => ({ rows: [], rowCount: 0 }) } },
        { provide: AuditService, useValue: { record: async () => undefined } },
      ],
    }).compile();

    expect(mod.get(CatalogController)).toBeInstanceOf(CatalogController);
    expect(CatalogService.length).toBe(2);
    await mod.close();
  });
});
