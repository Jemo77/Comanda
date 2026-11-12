import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '../../database/database.service';

export type SalesGroupBy = 'day' | 'product' | 'category';

export interface SalesReportRow {
  group: string;
  ordersCount: number;
  units: number;
  totalCents: number;
}

export interface SalesReport {
  from: string;
  to: string;
  groupBy: SalesGroupBy;
  currency: string;
  totalCents: number;
  ordersCount: number;
  averageTicketCents: number;
  rows: SalesReportRow[];
}

/**
 * Reportes basicos de ventas (Fase 2).
 *
 * Solo ventas REALES: se suma sobre comandas `CLOSED` con pagos aprobados, y el
 * rango se aplica sobre `closed_at`, que es cuando la venta ocurrio a efectos del
 * negocio. El motor BI completo (CMV, ingeniería de menú, heatmaps) es Fase 5.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject('DATABASE') private readonly db: Database) {}

  async sales(
    orgId: string,
    venueId: string,
    params: { from: Date; to: Date; groupBy: SalesGroupBy; currency?: string },
  ): Promise<SalesReport> {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const params_ = [params.from.toISOString(), params.to.toISOString(), venueId];
      const breakdown = await this.breakdownBy(tx, params.groupBy, params_);
      const totals = await tx.query<{ total_cents: number; count: number }>(
        `SELECT COALESCE(SUM(total_cents), 0)::int AS total_cents, COUNT(*)::int AS count
           FROM orders
          WHERE status = 'CLOSED'
            AND venue_id = $3::uuid
            AND closed_at >= $1::timestamptz
            AND closed_at < $2::timestamptz`,
        params_,
      );
      const totalCents = totals.rows[0]?.total_cents ?? 0;
      const ordersCount = totals.rows[0]?.count ?? 0;

      return {
        from: params.from.toISOString(),
        to: params.to.toISOString(),
        groupBy: params.groupBy,
        currency: params.currency ?? 'ARS',
        totalCents,
        ordersCount,
        averageTicketCents: ordersCount > 0 ? Math.round(totalCents / ordersCount) : 0,
        rows: breakdown,
      };
    });
  }

  private async breakdownBy(
    tx: { query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
    groupBy: SalesGroupBy,
    params: string[],
  ): Promise<SalesReportRow[]> {
    switch (groupBy) {
      case 'day': {
        const rows = await tx.query<{ group: string; orders_count: number; units: number; total_cents: number }>(
          `SELECT to_char(o.closed_at, 'YYYY-MM-DD') AS group,
                  COUNT(DISTINCT o.id)::int AS orders_count,
                  COALESCE(SUM(i.quantity), 0)::int AS units,
                  COALESCE(SUM((i.unit_price_cents + COALESCE(m.delta, 0)) * i.quantity), 0)::int AS total_cents
             FROM orders o
             LEFT JOIN order_items i ON i.order_id = o.id AND i.status = 'ACTIVE'
             LEFT JOIN LATERAL (
               SELECT SUM(m2.price_delta_cents)::int AS delta
                 FROM order_item_modifiers m2 WHERE m2.order_item_id = i.id
             ) m ON true
            WHERE o.status = 'CLOSED'
              AND o.venue_id = $3::uuid
              AND o.closed_at >= $1::timestamptz
              AND o.closed_at < $2::timestamptz
            GROUP BY 1
            ORDER BY 1`,
          params,
        );
        return rows.rows.map((r) => ({ group: r.group, ordersCount: r.orders_count, units: r.units, totalCents: r.total_cents }));
      }
      case 'product': {
        const rows = await tx.query<{ group: string; orders_count: number; units: number; total_cents: number }>(
          `SELECT i.name_snapshot AS group,
                  COUNT(DISTINCT o.id)::int AS orders_count,
                  SUM(i.quantity)::int AS units,
                  SUM((i.unit_price_cents + COALESCE(m.delta, 0)) * i.quantity)::int AS total_cents
             FROM orders o
             JOIN order_items i ON i.order_id = o.id AND i.status = 'ACTIVE'
             LEFT JOIN LATERAL (
               SELECT SUM(m2.price_delta_cents)::int AS delta
                 FROM order_item_modifiers m2 WHERE m2.order_item_id = i.id
             ) m ON true
            WHERE o.status = 'CLOSED'
              AND o.venue_id = $3::uuid
              AND o.closed_at >= $1::timestamptz
              AND o.closed_at < $2::timestamptz
            GROUP BY 1
            ORDER BY total_cents DESC
            LIMIT 50`,
          params,
        );
        return rows.rows.map((r) => ({ group: r.group, ordersCount: r.orders_count, units: r.units, totalCents: r.total_cents }));
      }
      case 'category': {
        const rows = await tx.query<{ group: string; orders_count: number; units: number; total_cents: number }>(
          `SELECT COALESCE(c.name, 'Sin categoria') AS group,
                  COUNT(DISTINCT o.id)::int AS orders_count,
                  SUM(i.quantity)::int AS units,
                  SUM((i.unit_price_cents + COALESCE(m.delta, 0)) * i.quantity)::int AS total_cents
             FROM orders o
             JOIN order_items i ON i.order_id = o.id AND i.status = 'ACTIVE'
             LEFT JOIN LATERAL (
               SELECT SUM(m2.price_delta_cents)::int AS delta
                 FROM order_item_modifiers m2 WHERE m2.order_item_id = i.id
             ) m ON true
             LEFT JOIN products p ON p.id = i.product_id
             LEFT JOIN categories c ON c.id = p.category_id
            WHERE o.status = 'CLOSED'
              AND o.venue_id = $3::uuid
              AND o.closed_at >= $1::timestamptz
              AND o.closed_at < $2::timestamptz
            GROUP BY 1
            ORDER BY total_cents DESC`,
          params,
        );
        return rows.rows.map((r) => ({ group: r.group, ordersCount: r.orders_count, units: r.units, totalCents: r.total_cents }));
      }
    }
  }
}
