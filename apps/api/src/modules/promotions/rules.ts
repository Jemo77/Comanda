import type { PoolClient } from 'pg';
import { PROMOTION_SCOPES, PROMOTION_TYPES } from '@comanda/pricing-engine';
import type { PromotionRule } from '@comanda/pricing-engine';

/**
 * Carga de reglas para el motor de precios.
 *
 * `orders.service#addItem` la llama antes de `priceLine`: el motor corre
 * igual en el POS (offline, sobre la replica de `price_rules` en Dexie)
 * y en el servidor, asi que la unica forma de que den lo mismo es que el
 * servidor vea las mismas reglas que el POS tiene replicadas. La linea
 * congela `unit_price_cents` + `applied_rules` como snapshot en ambos
 * lados (ver ASSUMPTIONS A-24).
 *
 * Las reglas inactivas y las de otro local se filtran en SQL para no gastar
 * ciclos del motor, no por confianza: el motor igual las descartaria
 * (`RuleSet` ignora las inactivas), pero filtrar aca mantiene acotado el
 * trabajo por linea.
 */
export async function loadActiveRules(
  tx: PoolClient,
  venueId: string,
): Promise<PromotionRule[]> {
  const result = await tx.query<{
    id: string;
    type: string;
    scope: string;
    scope_id: string | null;
    schedule: unknown;
    params: Record<string, number>;
    priority: number;
    stackable: boolean;
    active: boolean;
  }>(
    `SELECT id, type, scope, scope_id, schedule, params, priority, stackable, active
       FROM price_rules
      WHERE active
        AND (venue_id IS NULL OR venue_id = $1::uuid)
      ORDER BY priority DESC`,
    [venueId],
  );

  return result.rows.map((row) => toRule(row));
}

function toRule(row: {
  id: string;
  type: string;
  scope: string;
  scope_id: string | null;
  schedule: unknown;
  params: Record<string, number>;
  priority: number;
  stackable: boolean;
  active: boolean;
}): PromotionRule {
  // Las filas pasan por CHECK constraints de la base, asi que el casteo es
  // seguro. Si alguien escribe un tipo nuevo en la base sin actualizar el
  // enum, `PROMOTION_TYPES.includes` lo delata en desarrollo.
  const type = PROMOTION_TYPES.includes(row.type as (typeof PROMOTION_TYPES)[number])
    ? (row.type as PromotionRule['type'])
    : (() => {
        throw new Error(`Tipo de promo desconocido en base: ${row.type}`);
      })();
  const scope = PROMOTION_SCOPES.includes(row.scope as (typeof PROMOTION_SCOPES)[number])
    ? (row.scope as PromotionRule['scope'])
    : (() => {
        throw new Error(`Ambito de promo desconocido en base: ${row.scope}`);
      })();

  return {
    id: row.id,
    type,
    scope,
    scopeId: row.scope_id,
    schedule: row.schedule as PromotionRule['schedule'],
    params: row.params ?? {},
    priority: row.priority,
    stackable: row.stackable,
    active: row.active,
  };
}
