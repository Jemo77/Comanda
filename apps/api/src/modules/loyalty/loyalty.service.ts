import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Database } from '../../database/database.service';

/**
 * Fidelización: saldo, acreditación por venta y canje.
 *
 * Vive en su propio módulo (y no en `storefront`) porque la acreditación la
 * disparan los DOS caminos de cierre de comanda —online (`OrdersService`) y
 * offline-primero (`SyncService`)— y ambos tienen que poder llamarla sin
 * depender del módulo de storefront, que a su vez depende de orders y kds.
 */
@Injectable()
export class LoyaltyService {
  constructor(@Inject('DATABASE') private readonly db: Database) {}

  /** Identifica al cliente por teléfono (lo crea si no existe) y devuelve su saldo. */
  async identifyCustomer(venueId: string, input: { phone: string; name?: string }) {
    const org = await this.orgIdOf(venueId);
    return this.db.withTenant({ orgId: org, venueId }, async (tx) => {
      const found = await tx.query<{ id: string }>(
        `SELECT id FROM customers WHERE org_id = $1::uuid AND phone = $2`,
        [org, input.phone],
      );
      let customerId = found.rows[0]?.id;
      if (!customerId) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO customers (org_id, phone, name) VALUES ($1::uuid, $2, $3) RETURNING id`,
          [org, input.phone, input.name ?? null],
        );
        customerId = inserted.rows[0]!.id;
      }
      const program = await tx.query<{ id: string; kind: string }>(
        `SELECT id, kind FROM loyalty_programs WHERE org_id = $1::uuid AND active LIMIT 1`,
        [org],
      );
      const balance = await this.balanceOf(tx, customerId);
      return { customerId, balance, program: program.rows[0] ?? null };
    });
  }

  /** Acredita puntos/sellos por una comanda cerrada. Idempotente por (order_id, program_id). */
  async accrueForOrder(orderId: string) {
    const tenant = await this.db.query<{ org_id: string; venue_id: string }>(
      `SELECT org_id, venue_id FROM platform_order_tenant($1::uuid)`,
      [orderId],
    );
    const t = tenant.rows[0];
    if (!t) return { accrued: false };

    return this.db.withTenant({ orgId: t.org_id, venueId: t.venue_id }, async (tx) => {
      const order = await tx.query<{
        customer_phone: string | null;
        total_cents: number;
        status: string;
      }>(`SELECT customer_phone, total_cents, status FROM orders WHERE id = $1::uuid`, [orderId]);
      const row = order.rows[0];
      if (!row || row.status !== 'CLOSED' || !row.customer_phone) return { accrued: false };

      const program = await tx.query<{ id: string; kind: string; points_per_cents: number }>(
        `SELECT id, kind, points_per_cents FROM loyalty_programs WHERE org_id = $1::uuid AND active LIMIT 1`,
        [t.org_id],
      );
      const programRow = program.rows[0];
      if (!programRow) return { accrued: false };

      // El cliente se puede identificar después de cerrar la comanda (QR/takeaway
      // sin lealtad). No perdemos la acreditación: lo creamos al primer pedido
      // con ese teléfono. Sin esto, un local nuevo nunca acumularía puntos.
      const customer = await tx.query<{ id: string }>(
        `SELECT id FROM customers WHERE org_id = $1::uuid AND phone = $2`,
        [t.org_id, row.customer_phone],
      );
      let customerId = customer.rows[0]?.id;
      if (!customerId) {
        const orderName = await tx.query<{ customer_name: string | null }>(
          `SELECT customer_name FROM orders WHERE id = $1::uuid`,
          [orderId],
        );
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO customers (org_id, phone, name) VALUES ($1::uuid, $2, $3)
           ON CONFLICT (org_id, phone) WHERE phone IS NOT NULL DO NOTHING
           RETURNING id`,
          [t.org_id, row.customer_phone, orderName.rows[0]?.customer_name ?? null],
        );
        customerId =
          inserted.rows[0]?.id ??
          (
            await tx.query<{ id: string }>(
              `SELECT id FROM customers WHERE org_id = $1::uuid AND phone = $2`,
              [t.org_id, row.customer_phone],
            )
          ).rows[0]?.id;
      }
      if (!customerId) return { accrued: false };

      const delta =
        programRow.kind === 'POINTS'
          ? Math.max(1, Math.floor(row.total_cents / programRow.points_per_cents))
          : 1;
      const inserted = await tx.query(
        `INSERT INTO loyalty_entries (org_id, venue_id, customer_id, program_id, delta, reason, order_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'ACCRUE', $6::uuid)
         ON CONFLICT (order_id, program_id) WHERE order_id IS NOT NULL AND reason = 'ACCRUE' DO NOTHING
         RETURNING id`,
        [t.org_id, t.venue_id, customerId, programRow.id, delta, orderId],
      );
      return { accrued: (inserted.rowCount ?? 0) > 0, delta };
    });
  }

  /** Canje en POS: descuenta del saldo y deja asiento inmutable. */
  async redeem(
    orgId: string,
    venueId: string,
    input: { phone: string; points: number; actorUserId: string | null },
  ) {
    if (input.points <= 0)
      throw new NotFoundException('El canje tiene que ser de al menos un punto.');
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const customer = await tx.query<{ id: string }>(
        `SELECT id FROM customers WHERE org_id = $1::uuid AND phone = $2`,
        [orgId, input.phone],
      );
      const customerId = customer.rows[0]?.id;
      if (!customerId) throw new NotFoundException('Cliente no encontrado.');
      const program = await tx.query<{ id: string }>(
        `SELECT id FROM loyalty_programs WHERE org_id = $1::uuid AND active LIMIT 1`,
        [orgId],
      );
      const current = await this.balanceOf(tx, customerId);
      if (current < input.points) {
        throw new NotFoundException(`Saldo insuficiente: tiene ${current} y pide ${input.points}.`);
      }
      await tx.query(
        `INSERT INTO loyalty_entries (org_id, venue_id, customer_id, program_id, delta, reason, actor_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'REDEEM', $6)`,
        [orgId, venueId, customerId, program.rows[0]?.id ?? null, -input.points, input.actorUserId],
      );
      return { redeemed: input.points, remaining: current - input.points };
    });
  }

  /** Saldo: puntos vigentes (los negativos siempre cuentan; los positivos vencen al año). */
  private async balanceOf(
    tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { balance: string }[] }> },
    customerId: string,
  ): Promise<number> {
    const balance = await tx.query(
      `SELECT COALESCE(SUM(delta), 0)::text AS balance FROM loyalty_entries
        WHERE customer_id = $1::uuid AND (delta < 0 OR created_at > now() - interval '365 days')`,
      [customerId],
    );
    return Number(balance.rows[0]?.balance ?? 0);
  }

  private async orgIdOf(venueId: string): Promise<string> {
    const result = await this.db.query<{ org_id: string }>(
      `SELECT org_id FROM platform_venue_tenant($1::uuid)`,
      [venueId],
    );
    if (!result.rows[0]) throw new NotFoundException('Local no encontrado o inactivo.');
    return result.rows[0].org_id;
  }
}
