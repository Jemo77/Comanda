import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, problemDetails } from '@comanda/domain';
import type { Database } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import type { CreateRuleInput, UpdateRuleInput } from './promotions.types';

/** Fila tal como la guarda Postgres. */
interface PriceRuleRow {
  id: string;
  org_id: string;
  venue_id: string | null;
  name: string;
  type: string;
  scope: string;
  scope_id: string | null;
  schedule: unknown;
  params: Record<string, number>;
  priority: number;
  stackable: boolean;
  active: boolean;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PromotionActor {
  userId: string;
  name: string;
  deviceId?: string | null;
}

export interface ListRulesFilter {
  active?: boolean;
  type?: string;
}

@Injectable()
export class PromotionsService {
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, venueId: string, filter: ListRulesFilter = {}) {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<PriceRuleRow>(
        `SELECT * FROM price_rules
          WHERE (venue_id IS NULL OR venue_id = $1::uuid)
            AND ($2::boolean IS NULL OR active = $2::boolean)
            AND ($3::text IS NULL OR type = $3)
          ORDER BY priority DESC, created_at`,
        [venueId, filter.active ?? null, filter.type ?? null],
      );
      return { rules: result.rows.map(toRule) };
    });
  }

  async create(orgId: string, venueId: string, input: CreateRuleInput, actor: PromotionActor) {
    // Si la promo es para un local puntual, tiene que ser DE este local: el
    // body podria mandar el id de otra sucursal de la misma organizacion.
    if (input.venueId && input.venueId !== venueId) {
      throw new ConflictException(
        problemDetails({
          status: 409,
          code: ERROR_CODES.CONFLICT,
          detail: 'Una promo no puede crearse para otro local del mismo dueño desde esta sesion.',
        }),
      );
    }

    const created = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<PriceRuleRow>(
        `INSERT INTO price_rules
           (org_id, venue_id, name, type, scope, scope_id, schedule, params, priority, stackable, active, created_by)
         VALUES ($1, $2::uuid, $3, $4, $5, $6::uuid, $7::jsonb, $8::jsonb, $9, $10, $11, $12::uuid)
         RETURNING *`,
        [
          orgId,
          input.venueId ?? null,
          input.name,
          input.type,
          input.scope,
          input.scopeId ?? null,
          input.schedule ? JSON.stringify(input.schedule) : null,
          JSON.stringify(input.params ?? {}),
          input.priority ?? 0,
          input.stackable ?? false,
          input.active ?? true,
          actor.userId,
        ],
      );
      return result.rows[0]!;
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'promotion.created',
      entity: 'price_rule',
      entityId: created.id,
      after: {
        name: created.name,
        type: created.type,
        scope: created.scope,
        scopeId: created.scope_id,
        priority: created.priority,
        stackable: created.stackable,
        active: created.active,
        schedule: created.schedule,
        params: created.params,
      },
    });

    return { rule: toRule(created) };
  }

  async update(orgId: string, venueId: string, id: string, input: UpdateRuleInput, actor: PromotionActor) {
    const updated = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const current = await tx.query<PriceRuleRow>(
        `SELECT * FROM price_rules WHERE id = $1::uuid FOR UPDATE`,
        [id],
      );
      const row = current.rows[0];
      if (!row) {
        throw new NotFoundException(
          problemDetails({ status: 404, code: ERROR_CODES.NOT_FOUND, detail: 'Esa promo no existe.' }),
        );
      }

      const next = {
        name: input.name ?? row.name,
        type: input.type ?? row.type,
        scope: input.scope ?? row.scope,
        scope_id: input.scopeId !== undefined ? input.scopeId : row.scope_id,
        venue_id: input.venueId !== undefined ? input.venueId : row.venue_id,
        schedule: input.schedule !== undefined ? input.schedule : row.schedule,
        params: input.params ?? row.params,
        priority: input.priority ?? row.priority,
        stackable: input.stackable ?? row.stackable,
        active: input.active ?? row.active,
      };

      // El tipo y el alcance tienen que seguir siendo coherentes con los
      // parametros: cambiar solo `type` sin cambiar `params` dejaria una regla
      // PERCENT sin bps que descuento CERO, que es el peor falso amigo.
      validateMergedRule(next);

      const result = await tx.query<PriceRuleRow>(
        `UPDATE price_rules
            SET name = $2, type = $3, scope = $4, scope_id = $5::uuid, venue_id = $6::uuid,
                schedule = $7::jsonb, params = $8::jsonb, priority = $9, stackable = $10,
                active = $11, updated_at = now()
          WHERE id = $1::uuid
        RETURNING *`,
        [
          id,
          next.name,
          next.type,
          next.scope,
          next.scope_id,
          next.venue_id,
          next.schedule ? JSON.stringify(next.schedule) : null,
          JSON.stringify(next.params),
          next.priority,
          next.stackable,
          next.active,
        ],
      );
      return { before: row, after: result.rows[0]! };
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'promotion.updated',
      entity: 'price_rule',
      entityId: id,
      before: { name: updated.before.name, type: updated.before.type, priority: updated.before.priority, active: updated.before.active },
      after: { name: updated.after.name, type: updated.after.type, priority: updated.after.priority, active: updated.after.active },
    });

    return { rule: toRule(updated.after) };
  }

  async remove(orgId: string, venueId: string, id: string, actor: PromotionActor) {
    await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<{ id: string; name: string }>(
        `UPDATE price_rules SET active = false, updated_at = now() WHERE id = $1::uuid AND active RETURNING id, name`,
        [id],
      );
      if (result.rows.length === 0) {
        throw new NotFoundException(
          problemDetails({ status: 404, code: ERROR_CODES.NOT_FOUND, detail: 'Esa promo no existe o ya esta dada de baja.' }),
        );
      }
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'promotion.deactivated',
      entity: 'price_rule',
      entityId: id,
    });

    return { ok: true };
  }
}

function validateMergedRule(next: {
  type: string;
  scope: string;
  scope_id: string | null;
  params: Record<string, number>;
}): void {
  if (next.scope === 'ORDER' && next.scope_id) {
    throw new ConflictException(
      problemDetails({ status: 409, code: ERROR_CODES.CONFLICT, detail: 'ORDER no lleva scope_id.' }),
    );
  }
  if ((next.scope === 'PRODUCT' || next.scope === 'CATEGORY') && !next.scope_id) {
    throw new ConflictException(
      problemDetails({ status: 409, code: ERROR_CODES.CONFLICT, detail: 'Falta el producto o la categoria.' }),
    );
  }
  const required: Record<string, string[]> = {
    PERCENT: ['bps'],
    FIXED: ['cents'],
    PRICE_OVERRIDE: ['priceCents'],
    NXM: ['n', 'm'],
    BOGO: [],
  };
  for (const key of required[next.type] ?? []) {
    if (next.params?.[key] === undefined) {
      throw new ConflictException(
        problemDetails({
          status: 409,
          code: ERROR_CODES.CONFLICT,
          detail: `La promo de tipo ${next.type} necesita params.${key}.`,
        }),
      );
    }
  }
}

function toRule(row: PriceRuleRow) {
  return {
    id: row.id,
    venueId: row.venue_id,
    name: row.name,
    type: row.type,
    scope: row.scope,
    scopeId: row.scope_id,
    schedule: row.schedule,
    params: row.params,
    priority: row.priority,
    stackable: row.stackable,
    active: row.active,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
