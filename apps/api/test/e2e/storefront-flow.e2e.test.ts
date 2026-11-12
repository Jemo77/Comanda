import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import request from 'supertest';
import { createTestDatabase } from '../support/db';
import type { TestDatabase as TestDatabaseType } from '../support/env';
import { assignRole, seedDefaultRoles, seedDevice, seedUser } from '../support/fixtures';
import { PasswordHasher } from '../../src/common/security/hash';
import { MockPaymentProvider } from '@comanda/payment-providers';
import { tableToken } from '../../src/modules/storefront/qr-token';
import { uuidv7 } from '@comanda/domain';

/**
 * E2E del recorrido del cliente, de punta a punta y por HTTP:
 *
 *  QR → cuenta → pago con webhook verificado → cierre de mesa desde el "POS"
 *  (evento de sync con sesión real) → acreditación de puntos → canje.
 *
 *  Y el camino takeaway: slot → estado de retiro listo → puntos.
 */

const QR_SECRET = 'e2e-qr-token-secret-de-prueba';
const WEBHOOK_SECRET = 'comanda-mock-webhook-secret';

let harness: TestDatabaseType;
let apiProcess: ChildProcess | null = null;
let orgId: string;
let venueId: string;
let tableId: string;
let productId: string;
let shiftId: string;
let accessToken: string;
const requestApi = () => request('http://localhost:3100');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-que-no-se-usa-fuera-de-los-tests-01';
  process.env.PIN_PEPPER = 'test-pin-pepper-de-16-chars-o-mas';
  process.env.JWT_ISSUER = 'comanda-test';
  process.env.JWT_AUDIENCE = 'comanda-test-api';
  process.env.FISCAL_WORKER_INTERVAL_MS = '0';
  process.env.QR_TOKEN_SECRET = QR_SECRET;
  process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.SEED_OWNER_PASSWORD = 'Comanda1234!';

  harness = await createTestDatabase();
  const org = await harness.createOrg('E2E Comanda');
  orgId = org.orgId;
  venueId = org.venueId;

  const hasher = new PasswordHasher(
    'test-pin-pepper-de-16-chars-o-mas',
    { memoryCost: 8_192, timeCost: 1 },
    { memoryCost: 8_192, timeCost: 1 },
  );
  const email = `encargado-${Date.now()}@e2e.test`;
  const userId = await seedUser(harness, {
    orgId,
    name: 'Encargado E2E',
    email,
    password: { plain: 'Comanda1234!', hasher },
  });
  const roles = await seedDefaultRoles(harness, orgId);
  await assignRole(harness, { orgId, userId, roleId: roles.get('cajero')!, venueId });
  const deviceId = await seedDevice(harness, {
    orgId,
    venueId,
    name: 'Tablet E2E',
    fingerprint: `fp-${Date.now()}`,
  });

  // Turno abierto, requisito para cerrar comandas.
  const shift = await harness.adminQuery<{ id: string }>(
    `INSERT INTO shifts (org_id, venue_id, opened_by, opening_float_cents)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 10000)
     RETURNING id`,
    [orgId, venueId, userId],
  );
  shiftId = shift.rows[0]!.id;

  // Carta mínima: 1 categoría, 1 producto con precio, 1 mesa, 1 estación.
  const seeded = await harness.adminQuery<{
    category_id: string;
    product_id: string;
    table_id: string;
  }>(
    `WITH c AS (
       INSERT INTO categories (org_id, venue_id, name, sort) VALUES ($1::uuid, $2::uuid, 'Café', 1) RETURNING id
     ), f AS (
       INSERT INTO floors (org_id, venue_id, name, sort) VALUES ($1::uuid, $2::uuid, 'Salón', 1) RETURNING id
     ), s AS (
       INSERT INTO stations (org_id, venue_id, name, kind, sort) VALUES ($1::uuid, $2::uuid, 'Cocina', 'cocina', 1) RETURNING id
     ), p AS (
       INSERT INTO products (org_id, category_id, name, price_cents, available, station_id)
       SELECT $1::uuid, id, 'Café cortado', 1800, true, (SELECT id FROM s) FROM c RETURNING id
     ), t AS (
       INSERT INTO tables (org_id, venue_id, floor_id, label, seats)
       SELECT $1::uuid, $2::uuid, id, 'M4', 4 FROM f RETURNING id
     )
     SELECT (SELECT id FROM c) AS category_id, (SELECT id FROM p) AS product_id,
            (SELECT id FROM t) AS table_id`,
    [orgId, venueId],
  );
  productId = seeded.rows[0]!.product_id;
  await harness.adminQuery(
    `INSERT INTO loyalty_programs (org_id, name, kind, points_per_cents, redeem_cost_points)
     VALUES ($1::uuid, 'Café Comanda', 'POINTS', 100, 10)`,
    [orgId],
  );
  tableId = seeded.rows[0]!.table_id;

  // Levantamos la API COMPILADA como subproceso: es el mismo binario que corre en
  // producción y evita los problemas de metadata de decoradores de Nest bajo
  // el transform de vitest (los providers cargan por design:paramtypes, que
  // esbuild no emite con fiabilidad). Este es el verdadero contrato HTTP.
  apiProcess = spawn('node', ['dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      API_PORT: '3100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProcess.stderr?.on('data', (d) => process.stderr.write(d));
  // Espera a que el servidor responda (o muere tras 30s).
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch('http://localhost:3100/api/v1/health');
      if (res.ok) break;
    } catch {
      /* todavia no arranca */
    }
    if (Date.now() > deadline) throw new Error('La API no arranco a tiempo');
    await new Promise((r) => setTimeout(r, 500));
  }

  const response = await requestApi()
    .post('/api/v1/auth/login')
    .send({ method: 'password', email, password: 'Comanda1234!', deviceId });
  expect(response.status).toBe(200);
  accessToken = response.body.accessToken as string;
}, 90_000);

afterAll(async () => {
  apiProcess?.kill('SIGTERM');
  await harness?.close();
});

describe('Fase 3 E2E: QR → pedido → pago → cierre en POS → puntos', () => {
  it('menú público responde', async () => {
    const res = await requestApi().get(`/api/v1/storefront/venues/${venueId}/menu?lang=es`);
    expect(res.status).toBe(200);
    expect(res.body.products.map((p: { name: string }) => p.name)).toContain('Café cortado');
  });

  it('token de mesa inválido no resuelve', async () => {
    const res = await requestApi().get(
      `/api/v1/storefront/venues/${venueId}/tables/${tableId}/resolve?token=token-trucho`,
    );
    expect(res.status).toBe(404);
  });

  it('flujo completo con webhook idempotente', async () => {
    const token = tableToken(QR_SECRET, venueId, tableId, 1);

    const orderRes = await requestApi()
      .post(`/api/v1/storefront/venues/${venueId}/tables/${tableId}/orders`)
      .set('Idempotency-Key', uuidv7())
      .send({ token, guests: 2, items: [{ productId, quantity: 2 }] });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.status).toBe('OPEN');
    const orderId = orderRes.body.orderId as string;

    const billRes = await requestApi().get(
      `/api/v1/storefront/venues/${venueId}/tables/${tableId}/bill?token=${token}`,
    );
    expect(billRes.status).toBe(200);
    expect(billRes.body.totals.totalCents).toBe(3600);

    const checkoutRes = await requestApi()
      .post(`/api/v1/storefront/venues/${venueId}/tables/${tableId}/checkout`)
      .send({ token, provider: 'mock', tipCents: 0, sourceEventId: uuidv7() });
    expect(checkoutRes.status).toBe(201);
    const externalRef = checkoutRes.body.externalRef as string;

    const provider = new MockPaymentProvider(WEBHOOK_SECRET);
    const evtId = `evt_${uuidv7()}`;
    const body = provider.simulateApprovalBody(externalRef, evtId);
    const signature = provider.signWebhookBody(body);

    const hookRes = await requestApi()
      .post('/api/v1/storefront/webhooks/payments/mock')
      .set('x-signature', signature)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(hookRes.status).toBe(201);
    expect(hookRes.body.duplicate).toBe(false);

    // Reenvío del mismo webhook: idempotente.
    const hookRes2 = await requestApi()
      .post('/api/v1/storefront/webhooks/payments/mock')
      .set('x-signature', signature)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(hookRes2.body.duplicate).toBe(true);

    // Firma falsa: 401, no doble pago.
    const badHook = await requestApi()
      .post('/api/v1/storefront/webhooks/payments/mock')
      .set('x-signature', 'falsa')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(badHook.status).toBe(401);

    const bill2 = await requestApi().get(
      `/api/v1/storefront/venues/${venueId}/tables/${tableId}/bill?token=${token}`,
    );
    expect(bill2.body.totals.paidCents).toBe(3600);

    // Cierre desde el POS: evento de sync con sesión real.
    const closeRes = await requestApi()
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        events: [
          {
            eventId: uuidv7(),
            type: 'ORDER_CLOSED',
            seq: 1,
            occurredAt: new Date().toISOString(),
            payload: { orderId, shiftId },
          },
        ],
      });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.results[0].status).toBe('APPLIED');

    const orderRes2 = await requestApi()
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(orderRes2.body.order.status).toBe('CLOSED');
  });
});

describe('Fase 3 E2E: takeaway → retiro y puntos canjeables', () => {
  it('pedido takeaway acredita puntos al cerrarse y se puede canjear', async () => {
    const takeawayRes = await requestApi()
      .post(`/api/v1/storefront/venues/${venueId}/takeaway/orders`)
      .send({
        slotAt: new Date(Date.now() + 3600_000).toISOString(),
        customerName: 'Cliente E2E',
        customerPhone: '+5491155550000',
        items: [{ productId, quantity: 3 }],
        sourceEventId: uuidv7(),
      });
    expect(takeawayRes.status).toBe(201);
    const orderId = takeawayRes.body.orderId as string;

    // El cliente consulta el estado: todavía no listo.
    const status1 = await requestApi().get(`/api/v1/storefront/orders/${orderId}/takeaway-status`);
    expect(status1.body.readyForPickup).toBe(false);

    // La cocina marca el ticket READY (como lo haría un cocinero).
    await harness.adminQuery(
      `UPDATE kitchen_tickets SET status = 'READY' WHERE order_id = $1::uuid`,
      [orderId],
    );
    const status2 = await requestApi().get(`/api/v1/storefront/orders/${orderId}/takeaway-status`);
    expect(status2.body.readyForPickup).toBe(true);

    const closeRes = await requestApi()
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        events: [
          {
            eventId: uuidv7(),
            type: 'ORDER_CLOSED',
            seq: 2,
            occurredAt: new Date().toISOString(),
            payload: { orderId, shiftId },
          },
        ],
      });
    expect(closeRes.body.results[0].status).toBe('APPLIED');

    const identify = await requestApi()
      .post(`/api/v1/storefront/venues/${venueId}/customers/identify`)
      .send({ phone: '+5491155550000', name: 'Cliente E2E' });
    expect(identify.status).toBe(201);
    expect(identify.body.balance).toBeGreaterThan(0);

    // Canje en "POS" (endpoint staff con permiso del cajero).
    const redeemRes = await requestApi()
      .post('/api/v1/storefront/loyalty/redeem')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ phone: '+5491155550000', points: 10 });
    expect(redeemRes.status).toBe(201);
    expect(redeemRes.body.remaining).toBe(identify.body.balance - 10);
  });
});

describe('Fase 3 E2E: comanda QR con aprobación del mozo', () => {
  it('queda PENDIENTE_APROBACION hasta que el mozo aprueba', async () => {
    await harness.adminQuery(
      `UPDATE venues SET settings = settings || '{"qrApprovalMode":"WAITER"}'::jsonb WHERE id = $1::uuid`,
      [venueId],
    );
    const token = tableToken(QR_SECRET, venueId, tableId, 1);
    const orderRes = await requestApi()
      .post(`/api/v1/storefront/venues/${venueId}/tables/${tableId}/orders`)
      .set('Idempotency-Key', uuidv7())
      .send({ token, guests: 1, items: [{ productId, quantity: 1 }] });
    expect(orderRes.body.status).toBe('PENDIENTE_APROBACION');

    const approveRes = await requestApi()
      .post(`/api/v1/storefront/orders/${orderRes.body.orderId}/approve`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(approveRes.status).toBe(201);
    expect(approveRes.body.approved).toBe(true);

    const tickets = await harness.adminQuery(
      `SELECT id FROM kitchen_tickets WHERE order_id = $1::uuid`,
      [orderRes.body.orderId],
    );
    expect(tickets.rows.length).toBeGreaterThan(0);

    await harness.adminQuery(
      `UPDATE venues SET settings = settings - 'qrApprovalMode' WHERE id = $1::uuid`,
      [venueId],
    );
  });
});
