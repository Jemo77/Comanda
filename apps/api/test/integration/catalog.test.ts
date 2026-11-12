import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { uuidv7 } from '@comanda/domain';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CatalogService, type CatalogActor } from '../../src/modules/catalog/catalog.service';
import {
  createCategorySchema,
  createModifierGroupSchema,
  createModifierSchema,
  createProductSchema,
  createStationSchema,
  setAvailabilitySchema,
  updateModifierGroupSchema,
  updateModifierSchema,
  updateProductSchema,
} from '../../src/modules/catalog/catalog.types';
import { loadEnv } from '../../src/config/env';
import { DatabaseService } from '../../src/database/database.service';
import { createTestDatabase, truncateAuditLog, truncateOrg } from '../support/db';
import { assignRole, seedDefaultRoles, seedDevice, seedUser } from '../support/fixtures';
import type { TestDatabase } from '../support/env';

/**
 * Catalogo contra PostgreSQL real.
 *
 * Lo que se prueba aca no es el mapeo de filas (eso lo delata el typecheck) sino las
 * tres reglas de las que depende el cobro:
 *
 *  1. **El aislamiento.** Un producto de la organizacion A no se ve desde la B. Es la
 *     misma property que corre en `rls-isolation.test.ts` para `venues`, repetida aca
 *     porque el catalogo es la tabla que mas filas tiene y la que mas se toca.
 *  2. **El snapshot.** Cambiar el precio de un producto NO puede cambiar lo que debe
 *     una comanda abierta. Si alguna vez alguien "optimiza" esto, este test falla
 *     antes que un local.
 *  3. **El dinero entero.** Un `priceCents` negativo o con decimales tiene que rebotar
 *     en el esquema: la constraint de la base solo mira el signo, no el tipo, asi que
 *     un float pasaria y el arqueo descuadreria un viernes.
 *
 * Las entradas pasan por los esquemas de `catalog.types` con `.parse()`, igual que el
 * `ZodValidationPipe` del controller. Saltarse el esquema probaria una forma del
 * servicio que en produccion no existe: los defaults (`sort: 0`, `taxRate: 0`) se
 * aplican en el pipe, no en el servicio.
 */

/**
 * Lee el `detail` de un problem+json.
 *
 * `HttpException.message` es siempre "Not Found Exception" cuando el payload es un
 * objeto: el texto que ve la persona esta en `getResponse().detail`. Un test que
 * mira `.message` no comprobaria nada.
 */
function detailOf(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null && 'detail' in response) {
      return String((response as { detail: string }).detail);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** Ejecuta y devuelve el `detail` del problem+json, o falla si no hubo error. */
async function detailOfRejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return detailOf(error);
  }
  throw new Error('Se esperaba un error y la operacion termino bien.');
}
describe('catalog: estaciones, categorias, productos y modificadores', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let catalog: CatalogService;

  const luna = { orgId: '', venueId: '' };
  const orion = { orgId: '', venueId: '' };
  const device = { id: '' };
  const owner = { id: '' };
  const lunaActor: CatalogActor = { userId: '', deviceId: '' };

  /** Categoria de la Luna reutilizable: many tests solo necesitan "una categoria". */
  let baseCategoryId = '';

  const nuevaCategoria = (name: string, org = luna, venueId = luna.venueId) =>
    catalog.createCategory(org.orgId, venueId, createCategorySchema.parse({ name }), {
      userId: org === luna ? owner.id : uuidv7(),
    });

  const nuevoProducto = (input: Record<string, unknown>, org = luna, venueId = luna.venueId) =>
    catalog.createProduct(org.orgId, venueId, createProductSchema.parse(input), {
      userId: org === luna ? owner.id : uuidv7(),
    });

  /** Categoria y producto de la Luna con el precio dado. */
  const seedProduct = (params: { name: string; priceCents: number; available?: boolean }) =>
    nuevoProducto({
      categoryId: baseCategoryId,
      name: params.name,
      priceCents: params.priceCents,
      available: params.available ?? true,
    });

  beforeAll(async () => {
    harness = await createTestDatabase();
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: harness.url,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-access-secret-que-no-se-usa-fuera-de-los-tests-01',
      PIN_PEPPER: 'test-pin-pepper-de-16-chars-o-mas',
    });
    db = new DatabaseService(env);
    catalog = new CatalogService(db, new AuditService(db, env));

    const lunaOrg = await harness.createOrg('Catalog Cafe Luna');
    luna.orgId = lunaOrg.orgId;
    luna.venueId = lunaOrg.venueId;

    const orionOrg = await harness.createOrg('Catalog Bar Orion');
    orion.orgId = orionOrg.orgId;
    orion.venueId = orionOrg.venueId;

    const roles = await seedDefaultRoles(harness, luna.orgId);
    owner.id = await seedUser(harness, {
      orgId: luna.orgId,
      name: 'Dueña',
      email: 'duena@catalog.test',
      pin: { plain: '1234', hasher: { hashPin: async (v: string) => `stub:${v}` } as never },
    });
    await assignRole(harness, {
      orgId: luna.orgId,
      userId: owner.id,
      roleId: roles.get('dueno')!,
      venueId: luna.venueId,
    });

    device.id = await seedDevice(harness, {
      orgId: luna.orgId,
      venueId: luna.venueId,
      name: 'Tablet Catalogo',
      fingerprint: 'catalog-fingerprint',
      status: 'active',
    });

    lunaActor.userId = owner.id;
    lunaActor.deviceId = device.id;
    baseCategoryId = (await nuevaCategoria('Comidas')).id;
  }, 60_000);

  afterAll(async () => {
    await db.onModuleDestroy();
    for (const org of [luna.orgId, orion.orgId]) {
      await truncateAuditLog(harness, org);
      await truncateOrg(harness, org);
    }
    await harness.close();
  });

  describe('categorias y productos', () => {
    it('crea una categoria y un producto, y los lista', async () => {
      const category = await nuevaCategoria('Empanadas');
      expect(category.name).toBe('Empanadas');

      const product = await nuevoProducto({
        categoryId: category.id,
        name: 'Empanada de carne',
        priceCents: 1500,
        taxRate: 0.21,
        allergens: ['gluten'],
        tags: ['favorito'],
      });

      // El precio entra y sale como entero. `Number.isInteger` no es paranoia: si el
      // servicio lo guardara como float, 1500 volveria 1500 y el bug aparecia con
      // 0.1 * 15, tres meses despues, en el arqueo.
      expect(product.priceCents).toBe(1500);
      expect(Number.isInteger(product.priceCents)).toBe(true);
      // `numeric` vuelve como texto de Postgres: sin el `Number` la tasa seria el
      // string "0.2100" y toda comparacion de impuesto daria falso.
      expect(product.taxRate).toBe(0.21);
      expect(product.allergens).toEqual(['gluten']);

      const categories = await catalog.listCategories(luna.orgId, luna.venueId);
      expect(categories.map((c) => c.name)).toContain('Empanadas');

      const products = await catalog.listProducts(luna.orgId, luna.venueId);
      expect(products.map((p) => p.name)).toContain('Empanada de carne');
    });

    it('filtra por nombre y por categoria', async () => {
      const category = await nuevaCategoria('Bebidas');
      await nuevoProducto({ categoryId: category.id, name: 'Cafe con leche', priceCents: 900 });

      const found = await catalog.listProducts(luna.orgId, luna.venueId, { search: 'leche' });
      expect(found.map((p) => p.name)).toContain('Cafe con leche');

      const byCategory = await catalog.listProducts(luna.orgId, luna.venueId, {
        categoryId: category.id,
      });
      expect(byCategory.map((p) => p.name)).toEqual(['Cafe con leche']);
    });

    it('archiva la categoria en vez de borrarla', async () => {
      const category = await nuevaCategoria('Temporales');

      const archived = await catalog.archiveCategory(luna.orgId, category.id, lunaActor);
      expect(archived.active).toBe(false);

      // Sale del listado por defecto...
      const visible = await catalog.listCategories(luna.orgId, luna.venueId);
      expect(visible.map((c) => c.id)).not.toContain(category.id);

      // ...pero la fila sigue existiendo: las comandas del año pasado apuntan a ella,
      // y un borrado fisico ademas rebotaria en el `ON DELETE RESTRICT` de `products`.
      const conArchivadas = await catalog.listCategories(luna.orgId, luna.venueId, {
        includeArchived: true,
      });
      expect(conArchivadas.map((c) => c.id)).toContain(category.id);
    });
  });

  describe('aislamiento entre organizaciones', () => {
    it('un producto de la Luna no se ve desde Orion, ni por listado ni por id', async () => {
      const categoriaOrion = await nuevaCategoria('Combinados', orion, orion.venueId);
      const productoOrion = await nuevoProducto(
        {
          categoryId: categoriaOrion.id,
          name: 'Milanesa con papas',
          priceCents: 6000,
        },
        orion,
        orion.venueId,
      );

      const desdeLuna = await catalog.listProducts(luna.orgId, luna.venueId, {
        search: 'Milanesa',
      });
      expect(desdeLuna).toHaveLength(0);

      // Pedirlo por id tampoco lo devuelve: no es que el listado lo esconda, es que
      // la fila no existe para esa organizacion.
      await expect(
        detailOfRejection(() =>
          catalog.productWithModifiers(luna.orgId, luna.venueId, productoOrion.id),
        ),
      ).resolves.toMatch(/no existe/i);

      const desdeOrion = await catalog.listProducts(orion.orgId, orion.venueId, {
        search: 'Milanesa',
      });
      expect(desdeOrion.map((p) => p.id)).toEqual([productoOrion.id]);
    });

    it('no puede leer el producto de otra organizacion ni con SQL directo', async () => {
      const deLuna = await seedProduct({ name: 'Flan mixto', priceCents: 2200 });

      // Con el contexto de Orion, la fila de Luna es invisible: la policy `USING`
      // filtra en lugar de lanzar error. Exactamente el comportamiento que se quiere.
      const rows = await harness.asOrg(orion.orgId, (q) =>
        q(`SELECT id FROM products WHERE id = $1::uuid`, [deLuna.id]),
      );
      expect(rows.rows).toHaveLength(0);
    });

    it('no puede escribir en el catalogo de otra organizacion', async () => {
      const deLuna = await seedProduct({ name: 'Ñoqui del dia', priceCents: 3200 });

      // El ataque clasico: con el contexto de Orion, meter una fila que dice ser de
      // Luna. La policy de `WITH CHECK` lo rechaza antes de que exista el producto.
      await expect(
        harness.asOrg(orion.orgId, (q) =>
          q(
            `INSERT INTO products (org_id, category_id, name, price_cents)
             VALUES ($1::uuid, $2::uuid, 'Infiltrado', 100)`,
            [luna.orgId, deLuna.categoryId],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('validacion de entrada', () => {
    it('rechaza un precio negativo', async () => {
      // La validacion vive en el esquema, no en la constraint: el mensaje que ve el
      // que carga el producto tiene que decir cual fue el campo.
      const parsed = createProductSchema.safeParse({
        categoryId: baseCategoryId,
        name: 'Flan',
        priceCents: -100,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map((i) => i.path.join('.'))).toContain('priceCents');
      }
    });

    it('rechaza un precio con decimales', async () => {
      // La constraint `price_cents >= 0` no lo atrapa: el problema no es el signo, es el
      // tipo. Un float pasa el `>= 0` y se acumula en el arqueo.
      const result = createProductSchema.safeParse({
        categoryId: baseCategoryId,
        name: 'Producto con float',
        priceCents: 1500.5,
      });
      expect(result.success).toBe(false);
    });

    it('rechaza una tasa de impuesto fuera de 0..1', async () => {
      const result = createProductSchema.safeParse({
        categoryId: baseCategoryId,
        name: 'Producto raro',
        priceCents: 100,
        taxRate: 1.5,
      });
      expect(result.success).toBe(false);
    });

    it('rechaza un nombre mas largo que la columna', async () => {
      const result = createProductSchema.safeParse({
        categoryId: baseCategoryId,
        name: 'x'.repeat(121),
        priceCents: 100,
      });
      expect(result.success).toBe(false);
    });

    it('un maxSelect menor que el minSelect se rechaza en la edicion', async () => {
      // El esquema de edicion lo cruza contra si mismo y devuelve un mensaje que
      // nombra el campo. Sin eso, el rechazo llega de la constraint de Postgres: un
      // 500 con `modifier_groups_max_select_check` es la diferencia entre un formulario
      // que se explica y un ticket que nadie responde.
      const invertido = updateModifierGroupSchema.safeParse({ minSelect: 2, maxSelect: 1 });
      expect(invertido.success).toBe(false);
      if (!invertido.success) {
        expect(invertido.error.issues[0]!.path.join('.')).toBe('maxSelect');
      }

      // Y si el schema se saltea (un cliente viejo, un import directo), la base sigue
      // atrapando: el `max_select >= min_select` es una constraint, no una cortesia.
      await expect(
        catalog.createModifierGroup(
          luna.orgId,
          { name: 'Extras invertidos', minSelect: 2, maxSelect: 1, sort: 0 },
          lunaActor,
        ),
      ).rejects.toThrow();
    });
  });

  describe('modificadores', () => {
    it('productWithModifiers devuelve los grupos anidados', async () => {
      const category = await nuevaCategoria('Cafes');

      const leche = await catalog.createModifierGroup(
        luna.orgId,
        createModifierGroupSchema.parse({ name: 'Leche', minSelect: 1, maxSelect: 1, sort: 0 }),
        lunaActor,
      );
      const puntos = await catalog.createModifierGroup(
        luna.orgId,
        createModifierGroupSchema.parse({
          name: 'Punto de coccion',
          minSelect: 0,
          maxSelect: 1,
          sort: 1,
        }),
        lunaActor,
      );

      const descafeinado = await catalog.createModifier(
        luna.orgId,
        createModifierSchema.parse({ groupId: leche.id, name: 'Descafeinado', sort: 0 }),
        lunaActor,
      );
      await catalog.createModifier(
        luna.orgId,
        createModifierSchema.parse({ groupId: leche.id, name: 'Deslacte', sort: 1 }),
        lunaActor,
      );
      // Delta negativo: "menos queso" descuenta y "sin hielo" vale 0. El signo tiene
      // que hacer round-trip sin perderse.
      const menosQueso = await catalog.createModifier(
        luna.orgId,
        createModifierSchema.parse({
          groupId: puntos.id,
          name: 'Menos queso',
          priceDeltaCents: -300,
          recipeOverride: { quesoGr: 50 },
          sort: 0,
        }),
        lunaActor,
      );

      const product = await nuevoProducto({
        categoryId: category.id,
        name: 'Cafe cortado',
        priceCents: 1100,
        tracksStock: false,
        modifierGroupIds: [leche.id, puntos.id],
      });

      const full = await catalog.productWithModifiers(luna.orgId, luna.venueId, product.id);

      expect(full.id).toBe(product.id);
      // Un solo grupo por cada consulta: el POS la usa para pintar la ficha completa.
      expect(full.groups.map((g) => g.name)).toEqual(['Leche', 'Punto de coccion']);

      const lecheGroup = full.groups[0]!;
      expect(lecheGroup.minSelect).toBe(1);
      expect(lecheGroup.maxSelect).toBe(1);
      expect(lecheGroup.modifiers.map((m) => m.name)).toEqual(['Descafeinado', 'Deslacte']);
      expect(lecheGroup.modifiers.map((m) => m.id)).toContain(descafeinado.id);

      const puntosGroup = full.groups[1]!;
      expect(puntosGroup.modifiers[0]!.priceDeltaCents).toBe(-300);
      expect(puntosGroup.modifiers[0]!.id).toBe(menosQueso.id);
      expect(puntosGroup.modifiers[0]!.recipeOverride).toEqual({ quesoGr: 50 });
    });

    it('un producto sin grupos devuelve la lista vacia, no un error', async () => {
      const product = await seedProduct({ name: 'Agua', priceCents: 500 });
      const full = await catalog.productWithModifiers(luna.orgId, luna.venueId, product.id);
      expect(full.groups).toEqual([]);
    });

    it('saca de la carta los modificadores dados de baja', async () => {
      const group = await catalog.createModifierGroup(
        luna.orgId,
        createModifierGroupSchema.parse({ name: 'Extras', minSelect: 0, maxSelect: 3, sort: 5 }),
        lunaActor,
      );
      const activo = await catalog.createModifier(
        luna.orgId,
        createModifierSchema.parse({
          groupId: group.id,
          name: 'Extra queso',
          priceDeltaCents: 500,
          sort: 0,
        }),
        lunaActor,
      );
      const dadoDeBaja = await catalog.createModifier(
        luna.orgId,
        createModifierSchema.parse({
          groupId: group.id,
          name: 'Extra bacon',
          priceDeltaCents: 700,
          sort: 1,
        }),
        lunaActor,
      );

      const category = await nuevaCategoria('Pizzas');
      const product = await nuevoProducto({
        categoryId: category.id,
        name: 'Muzzarella',
        priceCents: 8000,
        modifierGroupIds: [group.id],
      });

      // El POS no puede ofrecer algo que el dueno saco: `active` es el filtro, no un
      // detalle de la consulta.
      await catalog.updateModifier(
        luna.orgId,
        dadoDeBaja.id,
        updateModifierSchema.parse({ active: false }),
        lunaActor,
      );

      const full = await catalog.productWithModifiers(luna.orgId, luna.venueId, product.id);
      expect(full.groups[0]!.modifiers.map((m) => m.id)).toEqual([activo.id]);

      // El listado plano si lo muestra: son dos lecturas para dos pantallas distintas
      // (la carta y la de administracion).
      const todos = await catalog.listModifiers(luna.orgId, group.id);
      expect(todos).toHaveLength(2);
    });

    it('reemplaza la lista de grupos del producto, no la agrega', async () => {
      const a = await catalog.createModifierGroup(
        luna.orgId,
        createModifierGroupSchema.parse({ name: 'Grupo A', sort: 0 }),
        lunaActor,
      );
      const b = await catalog.createModifierGroup(
        luna.orgId,
        createModifierGroupSchema.parse({ name: 'Grupo B', sort: 1 }),
        lunaActor,
      );

      const product = await nuevoProducto({
        categoryId: baseCategoryId,
        name: 'Pizza con dos grupos',
        priceCents: 9000,
        modifierGroupIds: [a.id, b.id],
      });
      expect(
        (await catalog.productWithModifiers(luna.orgId, luna.venueId, product.id)).groups,
      ).toHaveLength(2);

      // El formulario manda la lista final. Un merge dejaria grupos que el usuario
      // saco en la pantalla, y el POS los seguiria ofreciendo.
      const actualizado = await catalog.updateProduct(
        luna.orgId,
        luna.venueId,
        product.id,
        updateProductSchema.parse({ modifierGroupIds: [b.id] }),
        lunaActor,
      );
      expect(actualizado.id).toBe(product.id);

      const full = await catalog.productWithModifiers(luna.orgId, luna.venueId, product.id);
      expect(full.groups.map((g) => g.id)).toEqual([b.id]);
    });
  });

  describe('precio y disponibilidad', () => {
    it('exige motivo para cambiar el precio', async () => {
      const product = await seedProduct({ name: 'Medialunas', priceCents: 1200 });

      const detalle = await detailOfRejection(() =>
        catalog.updateProduct(
          luna.orgId,
          luna.venueId,
          product.id,
          updateProductSchema.parse({ priceCents: 1400 }),
          lunaActor,
        ),
      );
      expect(detalle).toMatch(/motivo/i);
    });

    it('cambiar el precio NO toca los items de una comanda ya abierta', async () => {
      // Esta es la property mas importante del modulo.
      //
      // Los items guardan `unit_price_cents` y `name_snapshot`. Si el catalogo
      // actualizara los items abiertos, una correccion de precio a la tarde cambiaria
      // lo que debe una mesa abierta desde la manana. El ticket tiene que seguir
      // diciendo lo que se pidio.
      const product = await seedProduct({ name: 'Cafe con leche', priceCents: 900 });

      const orderId = uuidv7();
      const itemId = uuidv7();
      await harness.asOrg(luna.orgId, async (q) => {
        await q(
          `INSERT INTO orders (id, org_id, venue_id, number_label, opened_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)`,
          [orderId, luna.orgId, luna.venueId, 'CAT-1', owner.id],
        );
        await q(
          `INSERT INTO order_items (
             id, org_id, order_id, product_id, name_snapshot, quantity,
             unit_price_cents, list_price_cents, added_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 2, $6, $6, $7::uuid)`,
          [itemId, luna.orgId, orderId, product.id, product.name, 900, owner.id],
        );
      });

      const updated = await catalog.updateProduct(
        luna.orgId,
        luna.venueId,
        product.id,
        updateProductSchema.parse({ priceCents: 1800, reason: 'Suba de precio de agosto' }),
        lunaActor,
      );
      expect(updated.priceCents).toBe(1800);

      const item = await harness.asOrg(luna.orgId, (q) =>
        q<{ unit_price_cents: number; list_price_cents: number; name_snapshot: string }>(
          `SELECT unit_price_cents, list_price_cents, name_snapshot FROM order_items WHERE id = $1::uuid`,
          [itemId],
        ),
      );
      expect(item.rows[0]!.unit_price_cents).toBe(900);
      expect(item.rows[0]!.list_price_cents).toBe(900);
      expect(item.rows[0]!.name_snapshot).toBe('Cafe con leche');
    });

    it('desactivar un producto lo saca del listado por defecto', async () => {
      const product = await seedProduct({ name: 'Torta de ricota', priceCents: 5000 });

      const antes = await catalog.listProducts(luna.orgId, luna.venueId, { search: 'Torta de' });
      expect(antes.map((p) => p.id)).toEqual([product.id]);

      await catalog.setAvailability(
        luna.orgId,
        luna.venueId,
        product.id,
        setAvailabilitySchema.parse({ available: false, reason: 'Se termino el queso' }),
        lunaActor,
      );

      const despues = await catalog.listProducts(luna.orgId, luna.venueId, { search: 'Torta de' });
      expect(despues).toHaveLength(0);

      // Sigue existiendo: la pantalla de administracion lo tiene que poder mostrar
      // dado de baja, y las comandas viejas que lo pidieron siguen siendo legibles.
      const dadosDeBaja = await catalog.listProducts(luna.orgId, luna.venueId, {
        search: 'Torta de',
        includeUnavailable: 'true',
      });
      expect(dadosDeBaja.map((p) => p.id)).toEqual([product.id]);

      // Y `available=false` explicito tambien lo trae: el filtro del query string es
      // "decime los que no estan", no un interruptor de "mostrar todo".
      const soloNoDisponibles = await catalog.listProducts(luna.orgId, luna.venueId, {
        search: 'Torta de',
        available: 'false',
      });
      expect(soloNoDisponibles.map((p) => p.id)).toEqual([product.id]);
    });

    it('deja el precio anterior en la auditoria del cambio', async () => {
      const product = await seedProduct({ name: 'Vino Malbec', priceCents: 5000 });

      await catalog.updateProduct(
        luna.orgId,
        luna.venueId,
        product.id,
        updateProductSchema.parse({ priceCents: 6500, reason: 'Lista de precios nueva' }),
        lunaActor,
      );

      // Sin el precio anterior, "el precio estaba mal" es una excusa sin pruebas.
      const rows = await harness.asOrg(luna.orgId, (q) =>
        q<{
          action: string;
          before: { priceCents?: number };
          after: { priceCents?: number };
          reason: string;
        }>(
          // `entity_id` es `varchar(64)`, no uuid: castearlo rompe la comparacion.
          `SELECT action, before, after, reason FROM audit_log
            WHERE entity = 'product' AND entity_id = $1 AND action = 'product.price_changed'`,
          [product.id],
        ),
      );

      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.before.priceCents).toBe(5000);
      expect(rows.rows[0]!.after.priceCents).toBe(6500);
      expect(rows.rows[0]!.reason).toBe('Lista de precios nueva');
    });

    it('un cambio de nombre NO queda registrado como cambio de precio', async () => {
      // Si el motivo fuera opcional, el registro de precio se llenaria de cambios de
      // nombre con `before.priceCents` identico al `after`, y el reporte de "quien
      // subio los precios" dejaria de servir para nada.
      const product = await seedProduct({ name: 'Empanada', priceCents: 1500 });

      await catalog.updateProduct(
        luna.orgId,
        luna.venueId,
        product.id,
        updateProductSchema.parse({ name: 'Empanada de carne' }),
        lunaActor,
      );

      const rows = await harness.asOrg(luna.orgId, (q) =>
        q(`SELECT action FROM audit_log WHERE entity = 'product' AND entity_id = $1`, [product.id]),
      );
      expect(rows.rows.map((r) => r.action)).not.toContain('product.price_changed');
      expect(rows.rows.map((r) => r.action)).toContain('product.updated');
    });

    it('deja la disponibilidad anterior en la auditoria', async () => {
      const product = await seedProduct({ name: 'Agua mineral', priceCents: 800 });

      await catalog.setAvailability(
        luna.orgId,
        luna.venueId,
        product.id,
        setAvailabilitySchema.parse({ available: false }),
        lunaActor,
      );

      const rows = await harness.asOrg(luna.orgId, (q) =>
        q<{ before: { available?: boolean }; after: { available?: boolean } }>(
          `SELECT before, after FROM audit_log
            WHERE entity = 'product' AND entity_id = $1 AND action = 'product.availability_changed'`,
          [product.id],
        ),
      );

      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.before.available).toBe(true);
      expect(rows.rows[0]!.after.available).toBe(false);
    });
  });

  describe('estaciones', () => {
    it('crea una estacion y la lista en el orden pedido', async () => {
      const bar = await catalog.createStation(
        luna.orgId,
        luna.venueId,
        createStationSchema.parse({ name: 'Bar', kind: 'bar', printerTarget: '192.168.0.20' }),
        lunaActor,
      );
      const cocina = await catalog.createStation(
        luna.orgId,
        luna.venueId,
        createStationSchema.parse({ name: 'Cocina', kind: 'cocina', sort: 1 }),
        lunaActor,
      );

      expect(bar.kind).toBe('bar');

      const stations = await catalog.listStations(luna.orgId, luna.venueId);
      const names = stations.map((s) => s.name);
      expect(names.indexOf('Bar')).toBeLessThan(names.indexOf('Cocina'));

      const actualizada = await catalog.updateStation(
        luna.orgId,
        luna.venueId,
        cocina.id,
        { printerTarget: '192.168.0.21' },
        lunaActor,
      );
      expect(actualizada.printerTarget).toBe('192.168.0.21');
      // El PATCH no toco lo que no vino: un `COALESCE` lo habria dejado en null.
      expect(actualizada.name).toBe('Cocina');
    });

    it('no lista las estaciones de otro local', async () => {
      const stations = await catalog.listStations(luna.orgId, luna.venueId);
      expect(stations.length).toBeGreaterThan(0);
      expect(stations.every((s) => s.venueId === luna.venueId)).toBe(true);
    });
  });
});
