import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { uuidv7 } from '@comanda/domain';
import {
  MockFiscalProvider,
  type FiscalInvoiceRequest,
  type FiscalInvoiceResult,
  type FiscalProvider,
} from '@comanda/fiscal-adapters';
import { FiscalRejectionError, FiscalUnavailableError } from '@comanda/fiscal-adapters';
import { loadEnv } from '../../src/config/env';
import { DatabaseService, type TenantContext } from '../../src/database/database.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CashService, type CashActor } from '../../src/modules/cash/cash.service';
import { OrdersService, type OrderActor } from '../../src/modules/orders/orders.service';
import { PaymentsService, type PaymentActor } from '../../src/modules/payments/payments.service';
import { FiscalService, type FiscalActor } from '../../src/modules/billing-fiscal/fiscal.service';
import { addItemSchema, openOrderSchema } from '../../src/modules/orders/orders.types';
import { paySchema } from '../../src/modules/payments/payments.types';
import { createTestDatabase, truncateAuditLog, truncateOrg } from '../support/db';
import type { TestDatabase } from '../support/env';

/**
 * Facturacion: el camino feliz con el mock, los reintentos con backoff, el
 * agotamiento de la cola (ERROR), el rechazo terminal (RECHAZADA) y la
 * unicidad de un comprobante por comanda.
 *
 * Lo importante no es que el provider autorice (el mock es trivial): es que el
 * SQL y los estados no mientan. Una factura no puede quedar PENDING para
 * siempre sin que el operador lo vea, ni RECHAZADA sin motivo.
 */

describe('billing-fiscal: emision, estados y cola', () => {
  let harness: TestDatabase;
  let db: DatabaseService;
  let audit: AuditService;
  let fiscal: FiscalService;
  let orders: OrdersService;
  let payments: PaymentsService;
  let cash: CashService;

  const luna = { orgId: '', venueId: '' };
  let productoId = '';
  let tablaId = '';
  let turnoId = '';
  let cajeroId = '';

  const actorCajero = (): OrderActor & PaymentActor & CashActor & FiscalActor => ({
    userId: cajeroId,
    name: 'Cajero',
    deviceId: null,
  });

  const inTenant = <T>(ctx: TenantContext, work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let result: T;
      db.runInTenantStream(ctx, () => {
        const done = new Subject<T>();
        void work().then(
          (value) => {
            result = value;
            done.complete();
          },
          (error: unknown) => done.error(error),
        );
        return done;
      }).subscribe({ complete: () => resolve(result!), error: reject });
    });

  const asLuna = <T>(work: () => Promise<T>) =>
    inTenant({ orgId: luna.orgId, venueId: luna.venueId, userId: actorCajero().userId }, work);

  /** Comanda cerrada con items, para facturar. */
  const comandaCerrada = async (precio: number, qty: number): Promise<string> => {
    const order = await asLuna(() =>
      orders.openOrder(luna.orgId, luna.venueId, openOrderSchema.parse({ tableId: tablaId, guests: 2 }), actorCajero(), uuidv7()),
    );
    const orderId = order.order.id;
    await asLuna(() => orders.addItem(luna.orgId, luna.venueId, orderId, addItemSchema.parse({ productId: productoId, quantity: qty }), actorCajero()));
    await asLuna(() =>
      payments.pay(luna.orgId, luna.venueId, orderId, paySchema.parse({ lines: [{ method: 'CASH', amountCents: precio * qty }] }), actorCajero(), uuidv7()),
    );
    return orderId;
  };

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
    audit = new AuditService(db, env);
    orders = new OrdersService(db, audit);
    payments = new PaymentsService(db, audit);
    cash = new CashService(db, audit);
    fiscal = new FiscalService(db, audit);

    const lunaOrg = await harness.createOrg('Fiscal Luna');
    luna.orgId = lunaOrg.orgId;
    luna.venueId = lunaOrg.venueId;

    await harness.asOrg(luna.orgId, async (q) => {
      const category = await q<{ id: string }>(
        `INSERT INTO categories (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Bebidas') RETURNING id`,
        [luna.orgId, luna.venueId],
      );
      const product = await q<{ id: string }>(
        `INSERT INTO products (org_id, category_id, name, price_cents, tax_rate)
         VALUES ($1::uuid, $2::uuid, 'Fernet', 10000, 0.21) RETURNING id`,
        [luna.orgId, category.rows[0]!.id],
      );
      productoId = product.rows[0]!.id;

      const floor = await q<{ id: string }>(
        `INSERT INTO floors (org_id, venue_id, name) VALUES ($1::uuid, $2::uuid, 'Salon') RETURNING id`,
        [luna.orgId, luna.venueId],
      );
      const table = await q<{ id: string }>(
        `INSERT INTO tables (org_id, venue_id, floor_id, label, seats)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'F1', 4) RETURNING id`,
        [luna.orgId, luna.venueId, floor.rows[0]!.id],
      );
      tablaId = table.rows[0]!.id;
    });

    await harness.asOrg(luna.orgId, async (q) => {
      const user = await q<{ id: string }>(
        `INSERT INTO users (org_id, name, email) VALUES ($1::uuid, 'Cajero', 'cajero@fiscal.test') RETURNING id`,
        [luna.orgId],
      );
      cajeroId = user.rows[0]!.id;
    });

    const abierto = await asLuna(() => cash.openShift(luna.orgId, luna.venueId, { openingFloatCents: 5000 }, actorCajero()));
    turnoId = abierto.id;
    void turnoId;

    // Configuracion fiscal minima: provider mock, homologacion.
    await asLuna(() =>
      fiscal.putSettings(
        luna.orgId,
        luna.venueId,
        {
          provider: 'mock',
          environment: 'homo',
          pointOfSale: '00001',
          cuit: '30712345678',
          certRef: '',
          caeaNumber: '',
          caeaExpiresOn: null,
          maxAttempts: 3,
        },
        actorCajero(),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await truncateAuditLog(harness, luna.orgId);
    await truncateOrg(harness, luna.orgId);
    await db.onModuleDestroy();
    await harness.close();
  });

  it('emite un FACT_B y guarda CAE + QR + totales', async () => {
    const orderId = await comandaCerrada(10000, 2);
    const { invoice } = await asLuna(() =>
      fiscal.issueInvoice(luna.orgId, luna.venueId, orderId, { type: 'FACT_B', receiver: { name: 'Consumidor Final', taxId: '0', condition: 'CONSUMIDOR_FINAL' } }, actorCajero()),
    );

    expect(invoice.status).toBe('EMITIDA');
    expect(invoice.cae).toMatch(/^\d{14}$/);
    expect(invoice.voucherNumber).toBeGreaterThan(0);
    expect(invoice.qrPayload).toContain('afip.gob.ar/fe/qr');
    // Bruto $20000 con 21% IVA -> neto 16529 (redondeo por grupo), iva 3471.
    expect(invoice.netoCents + invoice.ivaCents).toBe(20000);
    expect(invoice.ivaCents).toBe(3471);
  });

  it('no permite factura duplicada sobre la misma comanda', async () => {
    const orderId = await comandaCerrada(10000, 1);
    await asLuna(() => fiscal.issueInvoice(luna.orgId, luna.venueId, orderId, { type: 'FACT_B', receiver: { name: 'Consumidor Final', taxId: '0', condition: 'CONSUMIDOR_FINAL' } }, actorCajero()));

    let detail = '';
    try {
      await asLuna(() => fiscal.issueInvoice(luna.orgId, luna.venueId, orderId, { type: 'FACT_B', receiver: { name: 'Consumidor Final', taxId: '0', condition: 'CONSUMIDOR_FINAL' } }, actorCajero()));
    } catch (error) {
      detail = (error as HttpException).getResponse() instanceof Object
        ? String(((error as HttpException).getResponse() as { detail: string }).detail)
        : String(error);
    }
    expect(detail).toMatch(/ya tiene un comprobante/);
  });

  it('un provider caido deja PENDING con reintento programado, y agotar la cola da ERROR', async () => {
    const orderId = await comandaCerrada(10000, 1);
    const failing: FiscalProvider = {
      key: 'afip',
      async issueInvoice(): Promise<FiscalInvoiceResult> {
        throw new FiscalUnavailableError('WSFE no responde: 503');
      },
      async creditNote(): Promise<FiscalInvoiceResult> {
        throw new FiscalUnavailableError('WSFE no responde');
      },
    };
    const fiscalConFallas = new FiscalService(db, audit, () => failing);

    const first = await asLuna(() =>
      fiscalConFallas.issueInvoice(luna.orgId, luna.venueId, orderId, { type: 'FACT_B', receiver: { name: 'Consumidor Final', taxId: '0', condition: 'CONSUMIDOR_FINAL' } }, actorCajero()),
    );
    expect(first.invoice.status).toBe('PENDING');
    expect(first.invoice.lastError).toMatch(/503/);

    // Simular dos intentos mas contra la cola: next_attempt_at forzo a vencer.
    await harness.adminQuery(
      `UPDATE invoices SET attempts = 2, next_attempt_at = now() WHERE order_id = $1::uuid`,
      [orderId],
    );
    await fiscalConFallas.processDueInvoices(5);

    const after = await asLuna(() => fiscalConFallas.getInvoice(luna.orgId, luna.venueId, first.invoice.id));
    expect(after.invoice.status).toBe('ERROR');
    expect(after.invoice.attempts).toBeGreaterThanOrEqual(3);
    expect(after.invoice.lastError).toMatch(/503/);
  });

  it('un rechazo del fisco es terminal: RECHAZADA con motivo', async () => {
    const orderId = await comandaCerrada(10000, 1);
    const rejecting: FiscalProvider = {
      key: 'afip',
      async issueInvoice(_request: FiscalInvoiceRequest): Promise<FiscalInvoiceResult> {
        throw new FiscalRejectionError('CUIT del emisor invalido', ['CUIT del emisor invalido']);
      },
      async creditNote(_request: FiscalInvoiceRequest): Promise<FiscalInvoiceResult> {
        throw new FiscalRejectionError('rechazado');
      },
    };
    const fiscalConRechazo = new FiscalService(db, audit, () => rejecting);

    const { invoice } = await asLuna(() =>
      fiscalConRechazo.issueInvoice(luna.orgId, luna.venueId, orderId, { type: 'FACT_B', receiver: { name: 'Consumidor Final', taxId: '0', condition: 'CONSUMIDOR_FINAL' } }, actorCajero()),
    );
    expect(invoice.status).toBe('RECHAZADA');
    expect(invoice.lastError).toMatch(/CUIT/);

    // El reintento manual vuelve a pasar por el provider: tambien se rechaza.
    const retried = await asLuna(() => fiscalConRechazo.retry(luna.orgId, luna.venueId, invoice.id, actorCajero()));
    expect(retried.invoice.status).toBe('RECHAZADA');
  });

  it('el arqueo de auditoria deja rastro de lo emitido', async () => {
    const orderId = await comandaCerrada(10000, 1);
    await asLuna(() => fiscal.issueInvoice(luna.orgId, luna.venueId, orderId, { type: 'FACT_B', receiver: { name: 'Consumidor Final', taxId: '0', condition: 'CONSUMIDOR_FINAL' } }, actorCajero()));

    const rows = await harness.asOrg(luna.orgId, async (q) => {
      return q<{ action: string }>(`SELECT action FROM audit_log WHERE entity = 'invoices' ORDER BY created_at`);
    });
    expect(rows.rows.some((r) => r.action === 'invoice.issued')).toBe(true);
  });
});
