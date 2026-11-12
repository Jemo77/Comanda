import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ERROR_CODES,
  problemDetails,
  productWithModifiersSchema,
  type Category,
  type Modifier,
  type ModifierGroup,
  type Product,
  type ProductWithModifiers,
  type Station,
} from '@comanda/domain';
import type { PoolClient } from 'pg';
import type { Database } from '../../database/database.service';
// Import de VALOR a proposito: `emitDecoratorMetadata` escribe la clase real del
// segundo argumento del constructor en `design:paramtypes`, y con `import type` la
// clase se borra y Nest recibe `Function`. El arranque falla con un error que no
// menciona la causa. Ver el mismo comentario en `sync.service.ts`.
import { AuditService } from '../audit/audit.service';
import type {
  CreateCategoryInput,
  CreateModifierGroupInput,
  CreateModifierInput,
  CreateProductInput,
  CreateStationInput,
  ListCategoriesOptions,
  ProductFilter,
  SetAvailabilityInput,
  UpdateCategoryInput,
  UpdateModifierGroupInput,
  UpdateModifierInput,
  UpdateProductInput,
  UpdateStationInput,
} from './catalog.types';

/**
 * Actor de una escritura de catalogo.
 *
 * Se pasa explicito y no se deduce de un global: los metodos se prueban fuera de
 * HTTP y un `request` inyectado a mano seria una mentira. En produccion la
 * identidad sale de la sesion verificada (`CurrentSession`), nunca de un body ni de
 * un header.
 */
export interface CatalogActor {
  userId: string;
  /** Dispositivo desde el que se hizo el cambio. Va a la auditoria: "quien, desde
   *  que tablet" es lo que permite reconstruir un cambio de precio. */
  deviceId?: string | null;
}

/** Fila cruda de `products` tal como la devuelve Postgres. */
interface ProductRow extends Record<string, unknown> {
  id: string;
  category_id: string;
  name: string;
  sku: string | null;
  price_cents: number;
  tax_rate: string;
  station_id: string | null;
  available: boolean;
  allergens: string[];
  tags: string[];
  sort: number;
}

/**
 * Catalogo: estaciones, categorias, productos y modificadores.
 *
 * Cada operacion abre su propia transaccion con `withTenant` en vez de confiar en la
 * que abre el interceptor. La razon no es la RLS (esa funciona igual en los dos
 * casos): es que `withTenant` hace el servicio verificable. Un metodo que depende de
 * un contexto invisible solo se puede probar armando un HTTP entero, y un modulo de
 * catalogo probado asi deja de probarse. El costo es una transaccion por operacion,
 * que es lo que ya paga cada request de todas formas.
 *
 * Aun asi **ningun SELECT filtra por `org_id`**: la RLS filtra cada tabla y si un
 * filtro manual se olvidara en uno, la base sigue siendo el filtro. `orgId` se
 * recibe y se usa igual, porque las escrituras lo necesitan (`WITH CHECK` lo compara
 * contra el contexto) y porque la auditoria lo exige.
 *
 * Tres reglas que atraviesan todo el modulo:
 *
 *  1. **Dinero entero.** `price_cents` y `price_delta_cents` son `integer` y se
 *     escriben como `number`. Un float se acumula en el arqueo y no se nota hasta que
 *     el dia cierra descuadrado.
 *
 *  2. **Cambiar el precio no toca las comandas abiertas.** Los items guardan
 *     snapshot (`name_snapshot`, `unit_price_cents`, `list_price_cents`), asi que
 *     este modulo no escribe jamas en `order_items`. Es la unica forma de que el
 *     ticket de una mesa abierta siga diciendo lo que se pidio, aunque el dueno
 *     haya cambiado los precios a la tarde.
 *
 *  3. **El precio y la disponibilidad son acciones sensibles.** Van al registro de
 *     auditoria con el valor anterior, porque "el precio era 1200 y ahora es 1500" es
 *     exactamente la pregunta que se hace cuando alguien reclama por un cobro.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Estaciones
  // ---------------------------------------------------------------------------

  /**
   * Estaciones de un local, en el orden en que las muestra la pantalla.
   *
   * El filtro por local si es manual: `app.current_venue` existe, pero la RLS solo
   * filtra por organizacion, y una estacion de otro local no es un secreto: sencillamente
   * no es de este mostrador.
   *
   * Los SELECT no llevan `org_id` en el WHERE, asi que `$1` es el primer filtro de
   * verdad. Es a proposito: la RLS ya filtro por organizacion, y un `org_id = $1`
   * repetido en cada consulta es una segunda copia del mismo filtro que alguien va a
   * olvidar en alguna.
   */
  async listStations(orgId: string, venueId: string): Promise<Station[]> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<StationRow>(
        `SELECT id, venue_id, name, kind, printer_target, sort, active
           FROM stations
          WHERE venue_id = $1::uuid
          ORDER BY sort, name`,
        [venueId],
      );
      return result.rows.map(toStation);
    });
  }

  async createStation(
    orgId: string,
    venueId: string,
    input: CreateStationInput,
    actor: CatalogActor,
  ): Promise<Station> {
    const stationId = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO stations (org_id, venue_id, name, kind, printer_target, sort)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6) RETURNING id`,
        [orgId, venueId, input.name, input.kind, input.printerTarget, input.sort],
      );
      return result.rows[0]!.id;
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'station.created',
      entity: 'station',
      entityId: stationId,
      after: { name: input.name, kind: input.kind, printerTarget: input.printerTarget },
    });

    return this.getStation(orgId, venueId, stationId);
  }

  /**
   * Edita una estacion.
   *
   * Cada campo se escribe solo si vino: un PATCH que completa con `COALESCE` no
   * distingue "no lo mande" de "lo mande en null", y `printer_target` en null es un
   * valor legitimo (estacion todavia sin impresora).
   */
  async updateStation(
    orgId: string,
    venueId: string,
    stationId: string,
    input: UpdateStationInput,
    actor: CatalogActor,
  ): Promise<Station> {
    await this.db.withTenant({ orgId, venueId }, async (tx) => {
      await applyPartialUpdate(tx, 'stations', stationId, input, {
        name: 'name',
        kind: 'kind',
        printerTarget: 'printer_target',
        sort: 'sort',
      });
    });

    const station = await this.getStation(orgId, venueId, stationId);

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'station.updated',
      entity: 'station',
      entityId: stationId,
      after: { name: station.name, kind: station.kind, sort: station.sort },
    });

    return station;
  }

  async getStation(orgId: string, venueId: string, stationId: string): Promise<Station> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<StationRow>(
        `SELECT id, venue_id, name, kind, printer_target, sort, active
           FROM stations WHERE id = $1::uuid`,
        [stationId],
      );
      const row = result.rows[0];
      if (!row) throw notFound('Esa estacion no existe en este local.');
      return toStation(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Categorias
  // ---------------------------------------------------------------------------

  /**
   * Categorias del local mas las compartidas por la organizacion.
   *
   * `venue_id IS NULL` significa "compartida" en el esquema. Filtrar solo por el
   * local dejaria fuera la categoria "Comidas" que el dueno creo para toda la cadena,
   * y la carta del local mostraría menos de lo que el local realmente vende.
   */
  async listCategories(
    orgId: string,
    venueId: string,
    options: ListCategoriesOptions = {},
  ): Promise<Category[]> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const conditions = ['(venue_id = $1::uuid OR venue_id IS NULL)'];
      if (!options.includeArchived) conditions.push('active');

      const result = await tx.query<CategoryRow>(
        `SELECT id, venue_id, name, sort, active
           FROM categories
          WHERE ${conditions.join(' AND ')}
          ORDER BY sort, name`,
        [venueId],
      );
      return result.rows.map(toCategory);
    });
  }

  async createCategory(
    orgId: string,
    venueId: string,
    input: CreateCategoryInput,
    actor: CatalogActor,
  ): Promise<Category> {
    const categoryId = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO categories (org_id, venue_id, name, sort)
         VALUES ($1::uuid, $2::uuid, $3, $4) RETURNING id`,
        [orgId, venueId, input.name, input.sort],
      );
      return result.rows[0]!.id;
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'category.created',
      entity: 'category',
      entityId: categoryId,
      after: { name: input.name, sort: input.sort },
    });

    return this.getCategory(orgId, categoryId);
  }

  async updateCategory(
    orgId: string,
    categoryId: string,
    input: UpdateCategoryInput,
    actor: CatalogActor,
  ): Promise<Category> {
    await this.db.withTenant({ orgId }, async (tx) => {
      await applyPartialUpdate(tx, 'categories', categoryId, input, {
        name: 'name',
        sort: 'sort',
        active: 'active',
      });
    });

    const category = await this.getCategory(orgId, categoryId);

    await this.audit.record({
      orgId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'category.updated',
      entity: 'category',
      entityId: categoryId,
      after: { name: category.name, sort: category.sort, active: category.active },
    });

    return category;
  }

  /**
   * Archiva una categoria: `active = false`, nunca `DELETE`.
   *
   * Los productos cuelgan de la categoria con `ON DELETE RESTRICT`, asi que un borrado
   * fisico no podria ejecutarse con productos cargados y, si pudiera, dejaria
   * comandas historicas apuntando a nada. Archivar la saca de la carta y conserva el
   * historial, que es lo que hace falta cuando el dueno quiere "dar de baja" la linea
   * sin perder los tickets del año pasado.
   */
  async archiveCategory(orgId: string, categoryId: string, actor: CatalogActor): Promise<Category> {
    const before = await this.getCategory(orgId, categoryId);

    await this.db.withTenant({ orgId }, async (tx) => {
      await tx.query(
        `UPDATE categories SET active = false, updated_at = now() WHERE id = $1::uuid`,
        [categoryId],
      );
    });

    await this.audit.record({
      orgId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'category.updated',
      entity: 'category',
      entityId: categoryId,
      before: { name: before.name, active: before.active },
      after: { active: false },
    });

    return this.getCategory(orgId, categoryId);
  }

  async getCategory(orgId: string, categoryId: string): Promise<Category> {
    return this.db.withTenant({ orgId }, async (tx) => {
      const result = await tx.query<CategoryRow>(
        `SELECT id, venue_id, name, sort, active FROM categories WHERE id = $1::uuid`,
        [categoryId],
      );
      const row = result.rows[0];
      if (!row) throw notFound('Esa categoria no existe.');
      return toCategory(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Productos
  // ---------------------------------------------------------------------------

  /**
   * Productos del local, con filtros opcionales.
   *
   * El ambito de local se resuelve por la categoria: `products` no tiene `venue_id`
   * (el catalogo de un producto lo define donde se reimprime, no donde esta la barra),
   * asi que un producto es del local si su categoria lo es o si la categoria es
   * compartida.
   *
   * Sin `available` ni `includeUnavailable` devuelve solo lo disponible: es lo que
   * pinta la carta del POS, y un producto agotado tiene que estar fuera de la pantalla
   * sin que nadie applicable un filtro.
   */
  async listProducts(
    orgId: string,
    venueId: string,
    filter: ProductFilter = {},
  ): Promise<Product[]> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const conditions = ['(c.venue_id IS NULL OR c.venue_id = $1::uuid)'];
      const params: unknown[] = [venueId];

      if (filter.categoryId !== undefined) {
        params.push(filter.categoryId);
        conditions.push(`p.category_id = $${params.length}::uuid`);
      }

      if (filter.stationId !== undefined) {
        params.push(filter.stationId);
        conditions.push(`p.station_id = $${params.length}::uuid`);
      }

      if (filter.available !== undefined) {
        // El filtro llega como `"true"`/`"false"` y se pasa a boolean explicitamente:
        // mandarlo crudo a Postgres llegaria como texto y compararlo con un booleano
        // daria falso siempre.
        params.push(filter.available === 'true');
        conditions.push(`p.available = $${params.length}`);
      } else if (filter.includeUnavailable !== 'true') {
        conditions.push('p.available');
      }

      if (filter.search !== undefined) {
        params.push(`%${filter.search}%`);
        // `ILIKE` con el comodin adentro del parametro, no del SQL: el texto entra
        // como dato y la consulta no se puede romper desde el input.
        conditions.push(`p.name ILIKE $${params.length}`);
      }

      const result = await tx.query<ProductRow>(
        `SELECT p.id, p.category_id, p.name, p.sku, p.price_cents, p.tax_rate,
                p.station_id, p.available, p.allergens, p.tags, p.sort
           FROM products p
           JOIN categories c ON c.id = p.category_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY c.sort, p.sort, p.name`,
        params,
      );

      return result.rows.map(toProduct);
    });
  }

  async createProduct(
    orgId: string,
    venueId: string,
    input: CreateProductInput,
    actor: CatalogActor,
  ): Promise<Product> {
    // El alta del producto y la de sus grupos van en una transaccion: un producto sin
    // sus grupos esta a medio cargar, y el POS lo muestra como no configurable.
    const productId = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO products (
           org_id, category_id, name, sku, price_cents, tax_rate, station_id,
           tracks_stock, available, allergens, tags, sort)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[], $12)
         RETURNING id`,
        [
          orgId,
          input.categoryId,
          input.name,
          input.sku,
          input.priceCents,
          input.taxRate,
          input.stationId,
          input.tracksStock,
          input.available,
          input.allergens,
          input.tags,
          input.sort,
        ],
      );

      await linkModifierGroups(tx, orgId, created.rows[0]!.id, input.modifierGroupIds);
      return created.rows[0]!.id;
    });

    const product = await this.getProduct(orgId, productId);

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'product.created',
      entity: 'product',
      entityId: productId,
      after: { name: product.name, priceCents: product.priceCents, categoryId: product.categoryId },
    });

    return product;
  }

  /**
   * Edita un producto.
   *
   * **No toca `order_items`.** Los items de una comanda abierta guardan el precio y el
   * nombre del momento en que se agregaron, y cambiar el catalogo no puede alterar lo
   * que ya esta pedido ni el total que se va a cobrar. Si este metodo actualizara los
   * items abiertos, una correccion de precio a la tarde cambiaria lo que debe una mesa
   * abierta desde la manana. Esa es la razon por la que el snapshot existe.
   *
   * Un cambio de precio exige motivo y se audita por separado de la edicion normal: es
   * la accion que el dueno necesita poder revisar ("¿quien subio esto y por que?"), y
   * mezclada con un cambio de nombre quedaria enterrada en el historial.
   */
  async updateProduct(
    orgId: string,
    venueId: string,
    productId: string,
    input: UpdateProductInput,
    actor: CatalogActor,
  ): Promise<Product> {
    const before = await this.getProduct(orgId, productId);
    const priceChanged = input.priceCents !== undefined && input.priceCents !== before.priceCents;

    if (priceChanged && input.reason === undefined) {
      // El dominio ya marca `product.price_changed` como accion que exige motivo
      // escrito (`AUDIT_ACTIONS_REQUIRING_REASON`). La regla se aplica aca y no en el
      // esquema porque depende del precio anterior, que el esquema no conoce.
      throw new UnprocessableEntityException(
        problemDetails({
          status: 422,
          code: ERROR_CODES.VALIDATION_FAILED,
          detail: 'Cambiar el precio exige un motivo: queda en el registro de auditoria.',
          errors: [{ path: 'reason', message: 'El motivo es obligatorio.' }],
        }),
      );
    }

    await this.db.withTenant({ orgId, venueId }, async (tx) => {
      await applyPartialUpdate(
        tx,
        'products',
        productId,
        {
          categoryId: input.categoryId,
          name: input.name,
          sku: input.sku,
          priceCents: input.priceCents,
          taxRate: input.taxRate,
          stationId: input.stationId,
          available: input.available,
          tracksStock: input.tracksStock,
          allergens: input.allergens,
          tags: input.tags,
          sort: input.sort,
        },
        {
          categoryId: 'category_id',
          name: 'name',
          sku: 'sku',
          priceCents: 'price_cents',
          taxRate: 'tax_rate',
          stationId: 'station_id',
          available: 'available',
          tracksStock: 'tracks_stock',
          allergens: 'allergens',
          tags: 'tags',
          sort: 'sort',
        },
        // `text[]` y `numeric` no aceptan el formato que `pg` arma para una lista de
        // parametros: el cast va explicito en el SQL.
        { allergens: '::text[]', tags: '::text[]' },
      );

      if (input.modifierGroupIds !== undefined) {
        // Reemplazo completo y no merge: el formulario manda la lista final de
        // grupos. Un merge dejaria grupos que el usuario saco en la pantalla.
        await tx.query(`DELETE FROM product_modifier_groups WHERE product_id = $1::uuid`, [
          productId,
        ]);
        await linkModifierGroups(tx, orgId, productId, input.modifierGroupIds);
      }
    });

    const product = await this.getProduct(orgId, productId);

    if (priceChanged) {
      await this.audit.record({
        orgId,
        venueId,
        actorId: actor.userId,
        deviceId: actor.deviceId ?? null,
        action: 'product.price_changed',
        entity: 'product',
        entityId: productId,
        before: { priceCents: before.priceCents },
        after: { priceCents: product.priceCents },
        reason: input.reason ?? null,
      });
    }

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'product.updated',
      entity: 'product',
      entityId: productId,
      after: { name: product.name, taxRate: product.taxRate, sort: product.sort },
    });

    return product;
  }

  /**
   * Activa o desactiva un producto.
   *
   * Es una accion sensible y va auditada con el estado anterior: dar de baja un
   * producto con comandas abiertas es una decision operativa ("hoy no hay"), y saber
   * quien lo hizo y cuando es lo que permite revertirla con criterio. El motivo aqui
   * es opcional (el dominio no lo exige para esta accion) pero cuando viene se guarda.
   */
  async setAvailability(
    orgId: string,
    venueId: string,
    productId: string,
    input: SetAvailabilityInput,
    actor: CatalogActor,
  ): Promise<Product> {
    const before = await this.getProduct(orgId, productId);

    await this.db.withTenant({ orgId, venueId }, async (tx) => {
      await tx.query(`UPDATE products SET available = $2, updated_at = now() WHERE id = $1::uuid`, [
        productId,
        input.available,
      ]);
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'product.availability_changed',
      entity: 'product',
      entityId: productId,
      before: { available: before.available, name: before.name },
      after: { available: input.available },
      reason: input.reason ?? null,
    });

    return this.getProduct(orgId, productId);
  }

  /**
   * Producto con sus grupos y modificadores anidados, en UNA consulta.
   *
   * El POS pinta la carta entera de golpe y hace esto por cada producto visible: con
   * "4 consultas por producto" una carta de 60 productos son 240 viajes de red en un
   * celular con la barra del bar. Los agregados anidados (`json_agg` sobre `json_agg`)
   * traen el arbol entero en una fila.
   *
   * Solo trae grupos y modificadores activos: son los que se pueden elegir. El POS no
   * puede ofrecer "leche de origen animal" si el dueno la saco del grupo.
   */
  async productWithModifiers(
    orgId: string,
    venueId: string,
    productId: string,
  ): Promise<ProductWithModifiers> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<ProductRow & { groups: unknown }>(
        `SELECT p.id, p.category_id, p.name, p.sku, p.price_cents, p.tax_rate,
                p.station_id, p.available, p.allergens, p.tags, p.sort,
                COALESCE(
                  (SELECT json_agg(group_row ORDER BY group_row.sort, group_row.name)
                     FROM (
                       SELECT mg.id, mg.name, mg.min_select, mg.max_select, mg.sort, mg.active,
                              COALESCE(
                                (SELECT json_agg(modifier_row ORDER BY modifier_row.sort, modifier_row.name)
                                   FROM (
                                     SELECT m.id, m.group_id, m.name, m.price_delta_cents,
                                            m.recipe_override, m.sort, m.active
                                       FROM modifiers m
                                      WHERE m.group_id = mg.id AND m.active
                                   ) AS modifier_row
                                ),
                                '[]'::json
                              ) AS modifiers
                         FROM product_modifier_groups pmg
                         JOIN modifier_groups mg ON mg.id = pmg.group_id AND mg.active
                        WHERE pmg.product_id = p.id
                   ) AS group_row
                  ),
                  '[]'::json
                ) AS groups
           FROM products p
          WHERE p.id = $1::uuid`,
        [productId],
      );

      const row = result.rows[0];
      if (!row) throw notFound('Ese producto no existe.');

      // Se valida con el esquema del dominio en vez de castear a mano: el POS
      // consume exactamente esta forma, y una fila que no entre en el esquema es un
      // bug de formato que tiene que fallar aca y no en el mostrador del bar.
      return productWithModifiersSchema.parse({
        ...toProduct(row),
        groups: (row.groups as Array<Record<string, unknown>>).map((group) => ({
          id: group.id,
          name: group.name,
          minSelect: group.min_select,
          maxSelect: group.max_select,
          sort: group.sort,
          active: group.active,
          modifiers: (group.modifiers as Array<Record<string, unknown>>).map((modifier) => ({
            id: modifier.id,
            groupId: modifier.group_id,
            name: modifier.name,
            priceDeltaCents: modifier.price_delta_cents,
            recipeOverride: modifier.recipe_override ?? {},
            sort: modifier.sort,
            active: modifier.active,
          })),
        })),
      });
    });
  }

  async getProduct(orgId: string, productId: string): Promise<Product> {
    return this.db.withTenant({ orgId }, async (tx) => {
      const result = await tx.query<ProductRow>(
        `SELECT id, category_id, name, sku, price_cents, tax_rate, station_id,
                available, allergens, tags, sort
           FROM products WHERE id = $1::uuid`,
        [productId],
      );
      const row = result.rows[0];
      if (!row) throw notFound('Ese producto no existe.');
      return toProduct(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Grupos de modificadores y modificadores
  // ---------------------------------------------------------------------------

  /**
   * Grupos de modificadores de la organizacion.
   *
   * Sin filtro por local a proposito: un grupo ("Leche", "Punto de coccion") no es de
   * un mostrador, es de la carta. Filtrarlo por `venue_id` haria que un producto de
   * una categoria compartida quedara sin grupos configurables en un local.
   */
  async listModifierGroups(orgId: string): Promise<ModifierGroup[]> {
    return this.db.withTenant({ orgId }, async (tx) => {
      const result = await tx.query<ModifierGroupRow>(
        `SELECT id, name, min_select, max_select, sort, active
           FROM modifier_groups
          ORDER BY sort, name`,
        [orgId],
      );
      return result.rows.map(toModifierGroup);
    });
  }

  async createModifierGroup(
    orgId: string,
    input: CreateModifierGroupInput,
    actor: CatalogActor,
  ): Promise<ModifierGroup> {
    const groupId = await this.db.withTenant({ orgId }, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO modifier_groups (org_id, name, min_select, max_select, sort)
         VALUES ($1::uuid, $2, $3, $4, $5) RETURNING id`,
        [orgId, input.name, input.minSelect, input.maxSelect, input.sort],
      );
      return result.rows[0]!.id;
    });

    const group = await this.getModifierGroup(orgId, groupId);

    await this.audit.record({
      orgId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'modifier.created',
      entity: 'modifier_group',
      entityId: groupId,
      after: { name: group.name, minSelect: group.minSelect, maxSelect: group.maxSelect },
    });

    return group;
  }

  async updateModifierGroup(
    orgId: string,
    groupId: string,
    input: UpdateModifierGroupInput,
    actor: CatalogActor,
  ): Promise<ModifierGroup> {
    await this.db.withTenant({ orgId }, async (tx) => {
      await applyPartialUpdate(tx, 'modifier_groups', groupId, input, {
        name: 'name',
        minSelect: 'min_select',
        maxSelect: 'max_select',
        sort: 'sort',
        active: 'active',
      });
    });

    const group = await this.getModifierGroup(orgId, groupId);

    await this.audit.record({
      orgId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'modifier.updated',
      entity: 'modifier_group',
      entityId: groupId,
      after: { name: group.name, minSelect: group.minSelect, maxSelect: group.maxSelect },
    });

    return group;
  }

  async getModifierGroup(orgId: string, groupId: string): Promise<ModifierGroup> {
    return this.db.withTenant({ orgId }, async (tx) => {
      const result = await tx.query<ModifierGroupRow>(
        `SELECT id, name, min_select, max_select, sort, active
           FROM modifier_groups WHERE id = $1::uuid`,
        [groupId],
      );
      const row = result.rows[0];
      if (!row) throw notFound('Ese grupo de modificadores no existe.');
      return toModifierGroup(row);
    });
  }

  /** Modificadores de un grupo. */
  async listModifiers(orgId: string, groupId: string): Promise<Modifier[]> {
    return this.db.withTenant({ orgId }, async (tx) => {
      const result = await tx.query<ModifierRow>(
        `SELECT id, group_id, name, price_delta_cents, recipe_override, sort, active
           FROM modifiers
          WHERE group_id = $1::uuid
          ORDER BY sort, name`,
        [groupId],
      );
      return result.rows.map(toModifier);
    });
  }

  async createModifier(
    orgId: string,
    input: CreateModifierInput,
    actor: CatalogActor,
  ): Promise<Modifier> {
    const modifierId = await this.db.withTenant({ orgId }, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO modifiers (org_id, group_id, name, price_delta_cents, recipe_override, sort)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6) RETURNING id`,
        [
          orgId,
          input.groupId,
          input.name,
          input.priceDeltaCents,
          JSON.stringify(input.recipeOverride),
          input.sort,
        ],
      );
      return result.rows[0]!.id;
    });

    const modifier = await this.getModifier(orgId, modifierId);

    await this.audit.record({
      orgId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'modifier.created',
      entity: 'modifier',
      entityId: modifierId,
      after: { name: modifier.name, priceDeltaCents: modifier.priceDeltaCents },
    });

    return modifier;
  }

  async updateModifier(
    orgId: string,
    modifierId: string,
    input: UpdateModifierInput,
    actor: CatalogActor,
  ): Promise<Modifier> {
    await this.db.withTenant({ orgId }, async (tx) => {
      await applyPartialUpdate(
        tx,
        'modifiers',
        modifierId,
        input,
        {
          name: 'name',
          priceDeltaCents: 'price_delta_cents',
          recipeOverride: 'recipe_override',
          sort: 'sort',
          active: 'active',
        },
        { recipeOverride: '::jsonb' },
      );
    });

    const modifier = await this.getModifier(orgId, modifierId);

    await this.audit.record({
      orgId,
      actorId: actor.userId,
      deviceId: actor.deviceId ?? null,
      action: 'modifier.updated',
      entity: 'modifier',
      entityId: modifierId,
      after: {
        name: modifier.name,
        priceDeltaCents: modifier.priceDeltaCents,
        active: modifier.active,
      },
    });

    return modifier;
  }

  async getModifier(orgId: string, modifierId: string): Promise<Modifier> {
    return this.db.withTenant({ orgId }, async (tx) => {
      const result = await tx.query<ModifierRow>(
        `SELECT id, group_id, name, price_delta_cents, recipe_override, sort, active
           FROM modifiers WHERE id = $1::uuid`,
        [modifierId],
      );
      const row = result.rows[0];
      if (!row) throw notFound('Ese modificador no existe.');
      return toModifier(row);
    });
  }
}

// -----------------------------------------------------------------------------
// Mapeo de filas
// -----------------------------------------------------------------------------

interface StationRow extends Record<string, unknown> {
  id: string;
  venue_id: string;
  name: string;
  kind: string;
  printer_target: string | null;
  sort: number;
  active: boolean;
}

interface CategoryRow extends Record<string, unknown> {
  id: string;
  venue_id: string | null;
  name: string;
  sort: number;
  active: boolean;
}

interface ModifierGroupRow extends Record<string, unknown> {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  sort: number;
  active: boolean;
}

interface ModifierRow extends Record<string, unknown> {
  id: string;
  group_id: string;
  name: string;
  price_delta_cents: number;
  recipe_override: Record<string, unknown>;
  sort: number;
  active: boolean;
}

function toStation(row: StationRow): Station {
  return {
    id: row.id,
    venueId: row.venue_id,
    name: row.name,
    kind: row.kind as Station['kind'],
    printerTarget: row.printer_target,
    sort: row.sort,
    active: row.active,
  };
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    venueId: row.venue_id,
    name: row.name,
    sort: row.sort,
    active: row.active,
  };
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    sku: row.sku,
    priceCents: row.price_cents,
    // `numeric` vuelve como texto en `pg`: sin el `Number` el dominio veria "0.2100"
    // y toda comparacion de tasa daria falso.
    taxRate: Number(row.tax_rate),
    stationId: row.station_id,
    available: row.available,
    allergens: row.allergens ?? [],
    tags: row.tags ?? [],
    sort: row.sort,
  };
}

function toModifierGroup(row: ModifierGroupRow): ModifierGroup {
  return {
    id: row.id,
    name: row.name,
    minSelect: row.min_select,
    maxSelect: row.max_select,
    sort: row.sort,
    active: row.active,
  };
}

function toModifier(row: ModifierRow): Modifier {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    priceDeltaCents: row.price_delta_cents,
    recipeOverride: row.recipe_override ?? {},
    sort: row.sort,
    active: row.active,
  };
}

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

function notFound(detail: string): NotFoundException {
  return new NotFoundException(
    problemDetails({ status: 404, code: ERROR_CODES.NOT_FOUND, detail }),
  );
}

/**
 * Asocia grupos de modificadores a un producto.
 *
 * `ON CONFLICT DO NOTHING` y no un update: la tabla puente tiene PK
 * `(product_id, group_id)`, y reenviar la misma lista (el POS es optimista y
 * reintenta) no puede romper nada.
 */
async function linkModifierGroups(
  tx: PoolClient,
  orgId: string,
  productId: string,
  groupIds: readonly string[],
): Promise<void> {
  for (const [index, groupId] of groupIds.entries()) {
    await tx.query(
      `INSERT INTO product_modifier_groups (org_id, product_id, group_id, sort)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
       ON CONFLICT (product_id, group_id) DO NOTHING`,
      [orgId, productId, groupId, index],
    );
  }
}

/**
 * Aplica un PATCH parcial construyendo el `SET` con los campos que vinieron.
 *
 * El nombre de la tabla y el de cada columna salen de una constante del propio
 * metodo, nunca del input. El `SET` es la unica parte del SQL que se arma por
 * concatenacion, y tiene que ser imposible de envenenar con un body.
 *
 * `orgId` no aparece en el WHERE a proposito: la RLS ya filtro la fila y un
 * `org_id = $1` repetido en cada UPDATE seria una segunda copia del filtro que
 * alguien termina olvidando. `$1` es el id de la fila.
 *
 * `casts` cubre los tipos que no aceptan el texto que `pg` arma para una lista de
 * parametros (`text[]`, `jsonb`, `numeric`).
 */
async function applyPartialUpdate(
  tx: PoolClient,
  table: string,
  rowId: string,
  input: Record<string, unknown>,
  columns: Record<string, string>,
  casts: Record<string, string> = {},
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [rowId];

  for (const [field, column] of Object.entries(columns)) {
    const value = input[field];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}${casts[field] ?? ''}`);
  }

  if (sets.length === 0) return;

  sets.push('updated_at = now()');

  await tx.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1::uuid`, params);
}
