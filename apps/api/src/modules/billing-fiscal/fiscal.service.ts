import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ERROR_CODES, problemDetails } from '@comanda/domain';
import {
  AfipFiscalProvider,
  FiscalRejectionError,
  FiscalUnavailableError,
  HttpWsaaTransport,
  MockFiscalProvider,
  type FiscalInvoiceRequest,
  type FiscalProvider,
  type FiscalVoucherType,
} from '@comanda/fiscal-adapters';
import type { PoolClient } from 'pg';
import type { Database } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { computeInvoiceTotals } from './fiscal.math';
import type { IssueInvoiceInput, SettingsInput } from './fiscal.types';

/** Fila de fiscal_settings. */
interface SettingsRow {
  venue_id: string;
  org_id: string;
  provider: string;
  environment: string;
  point_of_sale: string;
  cuit: string;
  cert_ref: string;
  caea_number: string;
  caea_expires_on: Date | string | null;
  max_attempts: number;
}

/** Fila de invoices tal como la devuelve Postgres. */
interface InvoiceRow {
  id: string;
  org_id: string;
  venue_id: string;
  order_id: string;
  type: FiscalVoucherType;
  status: 'PENDING' | 'EMITIDA' | 'RECHAZADA' | 'ERROR';
  provider: string;
  environment: string;
  point_of_sale: string;
  voucher_number: number | null;
  cae: string | null;
  cae_due: Date | string | null;
  contingency: boolean;
  qr_payload: string | null;
  receiver: Record<string, unknown>;
  neto_cents: number;
  iva_cents: number;
  total_cents: number;
  currency: string;
  attempts: number;
  next_attempt_at: Date | string;
  last_error: string | null;
  raw_request: {
    ivaLines?: FiscalInvoiceRequest['ivaLines'];
    creditNote?: { type: FiscalVoucherType; pointOfSale: string; number: number };
  } | null;
  issued_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  credit_note_for: string | null;
}

export interface FiscalActor {
  userId: string;
  name: string;
  deviceId?: string | null;
}

@Injectable()
export class FiscalService {
  /**
   * `providerFactory` permite inyectar providers en tests (rechazar, caer,
   * medir reintentos) sin tocar la configuracion de la base. En produccion se
   * usa la fabrica por defecto que lee `fiscal_settings`.
   */
  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly audit: AuditService,
    @Optional()
    private readonly providerFactory?: (settings: {
      provider: string;
      environment: string;
      pointOfSale: string;
      cuit: string;
      certRef: string;
      caeaNumber: string;
      caeaExpiresOn: Date | string | null;
      maxAttempts: number;
    }) => FiscalProvider | undefined,
  ) {}

  // ---------------------------------------------------------------------------
  // Configuracion
  // ---------------------------------------------------------------------------

  async getSettings(orgId: string, venueId: string) {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<SettingsRow>(
        `SELECT * FROM fiscal_settings WHERE venue_id = $1::uuid`,
        [venueId],
      );
      return { settings: result.rows[0] ? toSettings(result.rows[0]) : null };
    });
  }

  async putSettings(orgId: string, venueId: string, input: SettingsInput, actor: FiscalActor) {
    const updated = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<SettingsRow>(
        `INSERT INTO fiscal_settings
           (venue_id, org_id, provider, environment, point_of_sale, cuit, cert_ref, caea_number, caea_expires_on, max_attempts, updated_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid)
         ON CONFLICT (venue_id) DO UPDATE SET
           provider = EXCLUDED.provider,
           environment = EXCLUDED.environment,
           point_of_sale = EXCLUDED.point_of_sale,
           cuit = EXCLUDED.cuit,
           cert_ref = EXCLUDED.cert_ref,
           caea_number = EXCLUDED.caea_number,
           caea_expires_on = EXCLUDED.caea_expires_on,
           max_attempts = EXCLUDED.max_attempts,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING *`,
        [
          venueId,
          orgId,
          input.provider,
          input.environment,
          input.pointOfSale,
          input.cuit,
          input.certRef,
          input.caeaNumber,
          input.caeaExpiresOn ?? null,
          input.maxAttempts,
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
      action: 'fiscal.settings_updated',
      entity: 'fiscal_settings',
      entityId: venueId,
      after: {
        provider: updated.provider,
        environment: updated.environment,
        pointOfSale: updated.point_of_sale,
        maxAttempts: updated.max_attempts,
      },
    });

    return { settings: toSettings(updated) };
  }

  // ---------------------------------------------------------------------------
  // Emision
  // ---------------------------------------------------------------------------

  async issueInvoice(
    orgId: string,
    venueId: string,
    orderId: string,
    input: IssueInvoiceInput,
    actor: FiscalActor,
  ) {
    const invoiceId = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      // ------------------------------------------------------------------
      // Nota de credito: se emite sobre la factura original, con sus mismos
      // totales. La NC no va atada a la comanda como tal sino a la FACT.
      // ------------------------------------------------------------------
      if (input.creditNoteFor) {
        const original = await tx.query<InvoiceRow>(
          `SELECT * FROM invoices WHERE id = $1::uuid`,
          [input.creditNoteFor],
        );
        const originalRow = original.rows[0];
        if (!originalRow) {
          throw new NotFoundException(
            problemDetails({ status: 404, code: ERROR_CODES.NOT_FOUND, detail: 'La factura original no existe.' }),
          );
        }
        if (originalRow.status !== 'EMITIDA' || !originalRow.voucher_number || !originalRow.cae) {
          throw new ConflictException(
            problemDetails({
              status: 409,
              code: ERROR_CODES.CONFLICT,
              detail: 'Solo se acreditan facturas emitidas.',
            }),
          );
        }
        const ncType = `NC_${originalRow.type.split('_')[1]}` as FiscalVoucherType;
        const existingNc = await tx.query<{ status: string }>(
          `SELECT status FROM invoices WHERE credit_note_for = $1::uuid AND status <> 'ERROR' LIMIT 1`,
          [originalRow.id],
        );
        if (existingNc.rows.length > 0) {
          throw new ConflictException(
            problemDetails({
              status: 409,
              code: ERROR_CODES.CONFLICT,
              detail: 'Esa factura ya tiene una nota de credito.',
            }),
          );
        }

        const settings = await this.settingsOf(tx, venueId);
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO invoices
             (org_id, venue_id, order_id, type, status, provider, environment, point_of_sale,
              receiver, neto_cents, iva_cents, total_cents, currency, raw_request, credit_note_for, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'PENDING', $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14::uuid, $15::uuid)
           RETURNING id`,
          [
            orgId,
            venueId,
            originalRow.order_id,
            ncType,
            settings.provider,
            settings.environment,
            settings.point_of_sale,
            JSON.stringify(originalRow.receiver),
            originalRow.neto_cents,
            originalRow.iva_cents,
            originalRow.total_cents,
            originalRow.currency,
            JSON.stringify({
              ivaLines: (originalRow as unknown as { raw_request?: { ivaLines: Array<{ rate: number; netoCents: number; ivaCents: number }> } | null }).raw_request?.ivaLines ?? [],
              creditNote: {
                type: originalRow.type,
                pointOfSale: originalRow.point_of_sale,
                number: originalRow.voucher_number,
              },
            }),
            originalRow.id,
            actor.userId,
          ],
        );
        return inserted.rows[0]!.id;
      }

      // Una comanda factura UNA vez salvo ERROR (que permite reintentar con fila
      // nueva). RECHAZADA es decision del fisco: no se reemite igual.
      const existing = await tx.query<{ status: string }>(
        `SELECT status FROM invoices
          WHERE order_id = $1::uuid AND type LIKE 'FACT%' AND status <> 'ERROR'
          LIMIT 1`,
        [orderId],
      );
      if (existing.rows.length > 0) {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: `Esa comanda ya tiene un comprobante ${existing.rows[0]!.status.toLowerCase()}.`,
          }),
        );
      }

      const order = await tx.query<{ id: string; status: string; total_cents: number }>(
        `SELECT id, status, total_cents FROM orders WHERE id = $1::uuid`,
        [orderId],
      );
      const row = order.rows[0];
      if (!row) {
        throw new NotFoundException(
          problemDetails({ status: 404, code: ERROR_CODES.NOT_FOUND, detail: 'La comanda no existe.' }),
        );
      }
      if (row.status !== 'CLOSED') {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'Solo se facturan comandas cerradas.',
          }),
        );
      }

      const settings = await this.settingsOf(tx, venueId);
      const items = await this.itemsOf(tx, orderId);
      const totals = computeInvoiceTotals(items);

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO invoices
           (org_id, venue_id, order_id, type, status, provider, environment, point_of_sale,
            receiver, neto_cents, iva_cents, total_cents, currency, raw_request, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'PENDING', $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14::uuid)
         RETURNING id`,
        [
          orgId,
          venueId,
          orderId,
          input.type,
          settings.provider,
          settings.environment,
          settings.point_of_sale,
          JSON.stringify(input.receiver),
          totals.netoCents,
          totals.ivaCents,
          totals.totalCents,
          'ARS',
          JSON.stringify({ ivaLines: totals.ivaLines }),
          actor.userId,
        ],
      );
      return inserted.rows[0]!.id;
    });

    // Fuera de la transaccion: el provider es I/O de red y no puede vivir dentro.
    await this.processInvoice(orgId, venueId, invoiceId);

    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<InvoiceRow>(`SELECT * FROM invoices WHERE id = $1::uuid`, [invoiceId]);
      return { invoice: toInvoice(result.rows[0]!) };
    });
  }

  async getInvoice(orgId: string, venueId: string, invoiceId: string) {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<InvoiceRow>(`SELECT * FROM invoices WHERE id = $1::uuid`, [invoiceId]);
      if (!result.rows[0]) {
        throw new NotFoundException(
          problemDetails({ status: 404, code: ERROR_CODES.NOT_FOUND, detail: 'La factura no existe.' }),
        );
      }
      return { invoice: toInvoice(result.rows[0]!) };
    });
  }

  async listInvoices(
    orgId: string,
    venueId: string,
    filter: { status?: string; orderId?: string } = {},
  ) {
    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<InvoiceRow>(
        `SELECT * FROM invoices
          WHERE ($1::text IS NULL OR status = $1)
            AND ($2::uuid IS NULL OR order_id = $2::uuid)
          ORDER BY created_at DESC
          LIMIT 200`,
        [filter.status ?? null, filter.orderId ?? null],
      );
      return { invoices: result.rows.map(toInvoice) };
    });
  }

  async retry(orgId: string, venueId: string, invoiceId: string, actor: FiscalActor) {
    await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<{ status: string }>(
        `UPDATE invoices
            SET status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
          WHERE id = $1::uuid AND status IN ('ERROR', 'RECHAZADA')
          RETURNING status`,
        [invoiceId],
      );
      if (result.rows.length === 0) {
        throw new ConflictException(
          problemDetails({
            status: 409,
            code: ERROR_CODES.CONFLICT,
            detail: 'Solo se reintentan comprobantes con error o rechazados.',
          }),
        );
      }
    });

    await this.audit.record({
      orgId,
      venueId,
      actorId: actor.userId,
      actorName: actor.name,
      deviceId: actor.deviceId ?? null,
      action: 'invoice.retry',
      entity: 'invoices',
      entityId: invoiceId,
    });

    await this.processInvoice(orgId, venueId, invoiceId);

    return this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<InvoiceRow>(`SELECT * FROM invoices WHERE id = $1::uuid`, [invoiceId]);
      return { invoice: toInvoice(result.rows[0]!) };
    });
  }

  // ---------------------------------------------------------------------------
  // Cola: reclamar pendientes y procesarlos
  // ---------------------------------------------------------------------------

  /**
   * Procesa hasta `limit` facturas pendientes. Lo llama el worker con el pool
   * directo (sin tenant: el claim es de plataforma) y los tests lo invocan a mano.
   */
  async processDueInvoices(limit = 10): Promise<{ processed: number }> {
    const claimed = await this.db.pool.query<{ id: string; org_id: string; venue_id: string }>(
      `SELECT * FROM platform_claim_pending_fiscal_invoices($1)`,
      [limit],
    );

    for (const row of claimed.rows) {
      await this.processInvoice(row.org_id, row.venue_id, row.id);
    }
    return { processed: claimed.rows.length };
  }

  /**
   * Un intento concreto de emitir. Cualquier resultado queda persistido:
   * EMITIDA, RECHAZADA (terminal), ERROR (cola agotada) o PENDING (reintentando).
   */
  async processInvoice(orgId: string, venueId: string, invoiceId: string): Promise<void> {
    // Cargar el pedido sin hacer I/O de red dentro de la transaccion.
    const request = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const result = await tx.query<InvoiceRow>(`SELECT * FROM invoices WHERE id = $1::uuid`, [invoiceId]);
      const row = result.rows[0];
      if (!row || row.status !== 'PENDING') return null;
      const settings = await this.settingsOf(tx, venueId);
      return { row, settings };
    });
    if (!request) return;

    const provider = this.providerFor(request.settings);
    const issueDate = new Date();
    const storedIvaLines = request.row.raw_request?.ivaLines ?? [];

    const fiscalRequest: FiscalInvoiceRequest = {
      type: request.row.type,
      pointOfSale: request.row.point_of_sale,
      internalId: request.row.id,
      receiver: request.row.receiver as unknown as FiscalInvoiceRequest['receiver'],
      concept: 1,
      issueDate: `${issueDate.getFullYear()}${String(issueDate.getMonth() + 1).padStart(2, '0')}${String(issueDate.getDate()).padStart(2, '0')}`,
      currency: request.row.currency,
      netoCents: request.row.neto_cents,
      ivaCents: request.row.iva_cents,
      totalCents: request.row.total_cents,
      ivaLines: storedIvaLines,
      creditNoteFor: request.row.raw_request?.creditNote,
    };

    try {
      const result = await provider.issueInvoice(fiscalRequest);
      await this.db.withTenant({ orgId, venueId }, async (tx) => {
        await tx.query(
          `UPDATE invoices
              SET status = 'EMITIDA', voucher_number = $2, cae = $3, cae_due = $4::date,
                  qr_payload = $5, contingency = $6, issued_at = now(), last_error = NULL,
                  raw_response = $7::jsonb, updated_at = now()
            WHERE id = $1::uuid`,
          [
            invoiceId,
            result.voucherNumber,
            result.cae,
            result.caeDue,
            result.qrPayload,
            result.contingency,
            JSON.stringify({ voucherNumber: result.voucherNumber, cae: result.cae, caeDue: result.caeDue, contingency: result.contingency }),
          ],
        );
      });
      await this.audit.record({
        orgId,
        venueId,
        actorId: null,
        actorName: 'cola-fiscal',
        action: result.contingency ? 'invoice.contingency_issued' : 'invoice.issued',
        entity: 'invoices',
        entityId: invoiceId,
        after: {
          voucherNumber: result.voucherNumber,
          cae: result.cae,
          contingency: result.contingency,
        },
      });
    } catch (error) {
      if (error instanceof FiscalRejectionError) {
        await this.markRejected(orgId, venueId, invoiceId, error.message, error.observations);
        return;
      }
      if (error instanceof FiscalUnavailableError) {
        await this.markRetryOrDead(orgId, venueId, invoiceId, request.settings, error.message);
        return;
      }
      // Error desconocido: mismo camino que el transitorio, pero queda en el log.
      await this.markRetryOrDead(
        orgId,
        venueId,
        invoiceId,
        request.settings,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  private async markRejected(
    orgId: string,
    venueId: string,
    invoiceId: string,
    message: string,
    observations?: string[],
  ): Promise<void> {
    await this.db.withTenant({ orgId, venueId }, async (tx) => {
      await tx.query(
        `UPDATE invoices SET status = 'RECHAZADA', last_error = $2, updated_at = now(), raw_response = $3::jsonb WHERE id = $1::uuid`,
        [invoiceId, message.slice(0, 500), JSON.stringify({ observations: observations ?? [] })],
      );
    });
    await this.audit.record({
      orgId,
      venueId,
      actorId: null,
      actorName: 'cola-fiscal',
      action: 'invoice.rejected',
      entity: 'invoices',
      entityId: invoiceId,
      after: { reason: message, observations: observations ?? [] },
    });
  }

  private async markRetryOrDead(
    orgId: string,
    venueId: string,
    invoiceId: string,
    settings: SettingsRow,
    message: string,
  ): Promise<void> {
    const attempts = await this.db.withTenant({ orgId, venueId }, async (tx) => {
      const current = await tx.query<{ attempts: number }>(`SELECT attempts FROM invoices WHERE id = $1::uuid`, [invoiceId]);
      const attemptsUsed = current.rows[0]?.attempts ?? 0;
      if (attemptsUsed >= settings.max_attempts) {
        await tx.query(
          `UPDATE invoices SET status = 'ERROR', last_error = $2, updated_at = now() WHERE id = $1::uuid`,
          [invoiceId, message.slice(0, 500)],
        );
        return attemptsUsed;
      }
      // Backoff exponencial: 1m, 2m, 4m, 8m... tope 2h. El claim ya sumó el intento.
      const delaySeconds = Math.min(60 * 2 ** attemptsUsed, 2 * 3600);
      await tx.query(
        `UPDATE invoices SET status = 'PENDING', last_error = $2,
           next_attempt_at = now() + ($3 || ' seconds')::interval, updated_at = now()
         WHERE id = $1::uuid`,
        [invoiceId, message.slice(0, 500), String(delaySeconds)],
      );
      return attemptsUsed;
    });

    const exhausted = attempts >= settings.max_attempts;
    await this.audit.record({
      orgId,
      venueId,
      actorId: null,
      actorName: 'cola-fiscal',
      action: exhausted ? 'invoice.failed' : 'invoice.retry_scheduled',
      entity: 'invoices',
      entityId: invoiceId,
      after: { attempts, reason: message },
    });
  }

  private providerFor(settings: SettingsRow): FiscalProvider {
    const override = this.providerFactory?.({
      provider: settings.provider,
      environment: settings.environment,
      pointOfSale: settings.point_of_sale,
      cuit: settings.cuit,
      certRef: settings.cert_ref,
      caeaNumber: settings.caea_number,
      caeaExpiresOn: settings.caea_expires_on,
      maxAttempts: settings.max_attempts,
    });
    if (override) return override;

    if (settings.provider === 'afip') {
      const transport = new HttpWsaaTransport();
      return new AfipFiscalProvider(
        {
          cuit: settings.cuit,
          certRef: settings.cert_ref,
          environment: settings.environment as 'homo' | 'prod',
          caeaNumber: settings.caea_number || undefined,
          caeaExpiresOn: settings.caea_expires_on ? toIsoDate(settings.caea_expires_on) : undefined,
        },
        transport,
        // CMS provider real requiere el material fiscal en el vault; el wiring
        // completo llega cuando exista el secret manager (PLAN §14). En este
        // entorno de desarrollo solo se usa el mock o un homologador externo.
        async () => {
          throw new FiscalUnavailableError('Material fiscal no configurado en este ambiente');
        },
      );
    }
    return new MockFiscalProvider({ cuit: settings.cuit || '30712345678', environment: settings.environment as 'homo' | 'prod' });
  }

  private async settingsOf(tx: PoolClient, venueId: string): Promise<SettingsRow> {
    const result = await tx.query<SettingsRow>(
      `SELECT * FROM fiscal_settings WHERE venue_id = $1::uuid`,
      [venueId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ConflictException(
        problemDetails({
          status: 409,
          code: ERROR_CODES.CONFLICT,
          detail: 'El local no tiene configuración fiscal. Cargala antes de facturar.',
        }),
      );
    }
    return row;
  }

  /**
   * Lineas para la factura: bruto por linea (items + modificadores) con la
   * alicuota de su producto. Los modificadores heredan la alicuota del producto,
   * que es lo razonable en una venta de mostrador.
   */
  private async itemsOf(
    tx: PoolClient,
    orderId: string,
  ): Promise<Array<{ grossCents: number; taxRate: number }>> {
    const result = await tx.query<{ quantity: number; unit_price_cents: number; tax_rate: string; modifiers_count: number; delta_total: number }>(
      `SELECT i.quantity, i.unit_price_cents, p.tax_rate::text,
              (SELECT COUNT(*) FROM order_item_modifiers m WHERE m.order_item_id = i.id)::int AS modifiers_count,
              COALESCE((SELECT SUM(m.price_delta_cents) FROM order_item_modifiers m WHERE m.order_item_id = i.id), 0)::int AS delta_total
         FROM order_items i
         JOIN products p ON p.id = i.product_id
        WHERE i.order_id = $1::uuid AND i.status = 'ACTIVE'`,
      [orderId],
    );

    return result.rows.map((row) => ({
      grossCents: (row.unit_price_cents + row.delta_total) * row.quantity,
      taxRate: Number(row.tax_rate),
    }));
  }
}

function toSettings(row: SettingsRow) {
  return {
    provider: row.provider,
    environment: row.environment,
    pointOfSale: row.point_of_sale,
    cuit: row.cuit,
    certRef: row.cert_ref,
    caeaNumber: row.caea_number,
    caeaExpiresOn: row.caea_expires_on ? toIsoDate(row.caea_expires_on) : null,
    maxAttempts: row.max_attempts,
  };
}

function toInvoice(row: InvoiceRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    type: row.type,
    status: row.status,
    provider: row.provider,
    environment: row.environment,
    pointOfSale: row.point_of_sale,
    voucherNumber: row.voucher_number,
    cae: row.cae,
    caeDue: row.cae_due ? toIsoDate(row.cae_due) : null,
    contingency: row.contingency,
    qrPayload: row.qr_payload,
    receiver: row.receiver,
    netoCents: row.neto_cents,
    ivaCents: row.iva_cents,
    totalCents: row.total_cents,
    currency: row.currency,
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    lastError: row.last_error,
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toIsoDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
