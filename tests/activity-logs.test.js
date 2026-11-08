import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/config/prisma.js';
import { closeDatabasePool } from '../src/config/db.js';
import { ensureTestTenant } from './testTenantHelper.js';

describe('Tenant Activity Logs and Audit Tracking', () => {
  let server;
  let baseUrl;
  let tenantToken = '';
  let tenantId = '';
  const testRunId = Date.now();

  before(async () => {
    tenantId = await ensureTestTenant();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    // Obtain tenant token for default tenant (this also logs a 'login' activity!)
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({ email: 'khodal@kapadkart.com', password: 'Khodal@123' })
    });
    const loginData = await loginRes.json();
    tenantToken = loginData.token;
  });

  after(async () => {
    if (tenantId) {
      await prisma.activityLog.deleteMany({
        where: {
          tenantId,
          summary: { contains: String(testRunId) }
        }
      });
      await prisma.product.deleteMany({
        where: { productCode: { contains: String(testRunId) } }
      });
    }
    await Promise.allSettled([closeDatabasePool(), disconnectPrisma()]);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('Logs login activity with device context when tenant user logs in', async () => {
    // Perform a distinct login with Chrome UA
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({ email: 'khodal@kapadkart.com', password: 'Khodal@123' })
    });
    assert.equal(loginRes.status, 200);

    const res = await fetch(`${baseUrl}/api/v1/tenant/activity?action=login&limit=5`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0);

    const loginLog = body.data.find((l) => l.action === 'login' && l.user_email === 'khodal@kapadkart.com');
    assert.ok(loginLog);
    assert.equal(loginLog.entity_type, 'auth');
    assert.equal(loginLog.user_email, 'khodal@kapadkart.com');
    assert.ok(typeof loginLog.browser_name === 'string');
    assert.ok(loginLog.created_at);
  });

  it('Supports GET /api/v1/activity with pagination metadata matching frontend schema', async () => {
    const res = await fetch(`${baseUrl}/api/v1/activity?page=1&limit=10`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.pagination);
    assert.equal(body.pagination.page, 1);
    assert.equal(body.pagination.limit, 10);
    assert.ok(typeof body.pagination.total === 'number');
    assert.ok(typeof body.pagination.totalPages === 'number');

    // Verify row keys match ActivityPage.jsx expectation
    if (body.data.length > 0) {
      const row = body.data[0];
      assert.ok('id' in row);
      assert.ok('created_at' in row);
      assert.ok('user_name' in row);
      assert.ok('user_email' in row);
      assert.ok('action' in row);
      assert.ok('entity_type' in row);
      assert.ok('summary' in row);
      assert.ok('ip_address' in row);
    }
  });

  it('Logs activity on product creation, update, and deletion', async () => {
    const prodCode = `ACT-${testRunId}`;

    // 1. Create product
    const createRes = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: `Audit Test Chaniya Choli ${testRunId}`,
        product_code: prodCode,
        category: 'Chaniya Choli',
        daily_rent: 1200,
        sale_price: 8000
      })
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()).data;

    // Verify create log
    const createLogRes = await fetch(`${baseUrl}/api/v1/tenant/activity?entity_type=product&search=${prodCode}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(createLogRes.status, 200);
    const createLogs = (await createLogRes.json()).data;
    assert.ok(createLogs.length >= 1);
    const createLog = createLogs.find((l) => l.action === 'create');
    assert.ok(createLog);
    assert.equal(createLog.entity_id, created.id);
    assert.ok(createLog.summary.includes(prodCode));

    // 2. Update product
    const updateRes = await fetch(`${baseUrl}/api/v1/tenant/products/${created.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        daily_rent: 1400
      })
    });
    assert.equal(updateRes.status, 200);

    // Verify update log
    const updateLogRes = await fetch(`${baseUrl}/api/v1/tenant/activity?entity_type=product&action=update&search=${prodCode}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(updateLogRes.status, 200);
    const updateLogs = (await updateLogRes.json()).data;
    assert.ok(updateLogs.length >= 1);
    assert.equal(updateLogs[0].entity_id, created.id);

    // 3. Add stock
    const stockRes = await fetch(`${baseUrl}/api/v1/tenant/products/${created.id}/add-stock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        quantity: 5,
        reason: 'Restock shipment'
      })
    });
    assert.equal(stockRes.status, 200);

    // Verify stock_added log
    const stockLogRes = await fetch(`${baseUrl}/api/v1/tenant/activity?action=stock_added&search=${prodCode}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(stockLogRes.status, 200);
    const stockLogs = (await stockLogRes.json()).data;
    assert.ok(stockLogs.length >= 1);

    // 4. Delete product
    const deleteRes = await fetch(`${baseUrl}/api/v1/tenant/products/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(deleteRes.status, 200);

    // Verify delete log
    const deleteLogRes = await fetch(`${baseUrl}/api/v1/tenant/activity?action=delete&search=${prodCode}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(deleteLogRes.status, 200);
    const deleteLogs = (await deleteLogRes.json()).data;
    assert.ok(deleteLogs.length >= 1);
  });

  it('Logs activity on settings update and allows single record lookup via GET /activity/:id', async () => {
    const updateRes = await fetch(`${baseUrl}/api/v1/tenant/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        company_name: `Khodal Bridal Studio ${testRunId}`
      })
    });
    assert.equal(updateRes.status, 200);

    const logRes = await fetch(`${baseUrl}/api/v1/tenant/activity?entity_type=settings&action=update&limit=1`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(logRes.status, 200);
    const logs = (await logRes.json()).data;
    assert.ok(logs.length >= 1);
    const logId = logs[0].id;

    // Single record fetch
    const singleRes = await fetch(`${baseUrl}/api/v1/tenant/activity/${logId}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(singleRes.status, 200);
    const singleBody = await singleRes.json();
    assert.equal(singleBody.status, 'success');
    // Revert settings to preserve initial test fixture
    await fetch(`${baseUrl}/api/v1/tenant/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        company_name: 'khodal-mahakali-shop'
      })
    });
  });

  it('Enforces multi-tenant isolation: Tenant cannot access another tenant logs', async () => {
    // Create a temporary log belonging to a different dummy tenant ID
    const otherTenant = await prisma.tenant.create({
      data: {
        slug: `other-${testRunId}`,
        name: `Other Shop ${testRunId}`,
        businessType: 'RENTAL',
        status: 'active'
      }
    });

    const otherLog = await prisma.activityLog.create({
      data: {
        tenantId: otherTenant.id,
        action: 'create',
        entityType: 'product',
        summary: `Secret item from other tenant ${testRunId}`
      }
    });

    try {
      // 1. GET /activity for khodal should not contain other tenant's log
      const res = await fetch(`${baseUrl}/api/v1/tenant/activity?search=${testRunId}`, {
        headers: { Authorization: `Bearer ${tenantToken}` }
      });
      assert.equal(res.status, 200);
      const data = (await res.json()).data;
      const leaked = data.find((l) => l.id === otherLog.id);
      assert.equal(leaked, undefined, 'Tenant A must not see Tenant B activity log');

      // 2. GET /activity/:id for other tenant's log ID should return 404
      const singleRes = await fetch(`${baseUrl}/api/v1/tenant/activity/${otherLog.id}`, {
        headers: { Authorization: `Bearer ${tenantToken}` }
      });
      assert.equal(singleRes.status, 404);
    } finally {
      await prisma.activityLog.deleteMany({ where: { tenantId: otherTenant.id } });
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
    }
  });
});
