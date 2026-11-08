import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/config/prisma.js';
import { closeDatabasePool } from '../src/config/db.js';
import { ensureTestTenant } from './testTenantHelper.js';

describe('Product Inventory Endpoints: add-stock, restore-damaged, inventory-logs, and delete', () => {
  let server;
  let baseUrl;
  let tenantToken = '';
  let tenantId = '';
  let createdProductId = '';

  before(async () => {
    tenantId = await ensureTestTenant();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com', password: 'Khodal@123' })
    });
    const loginData = await loginRes.json();
    tenantToken = loginData.token;

    // Create a product for testing
    const createRes = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Inventory Test Jodhpuri',
        product_code: 'INV-TEST-001',
        category: 'Suits',
        size: 'L',
        total_quantity: 5,
        daily_rent: 1200
      })
    });
    const createData = await createRes.json();
    createdProductId = createData.data.id;
  });

  after(async () => {
    if (tenantId && createdProductId) {
      await prisma.productInventoryLog.deleteMany({
        where: { productId: createdProductId }
      });
      await prisma.product.deleteMany({
        where: { id: createdProductId }
      });
    }
    await Promise.allSettled([closeDatabasePool(), disconnectPrisma()]);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('1. Adds stock via POST /products/:id/add-stock and logs inventory event', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products/${createdProductId}/add-stock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        quantity: 3,
        reason: 'New shipment arrived'
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.data.total_quantity, 8); // 5 + 3 = 8
    assert.equal(body.log.change_type, 'STOCK_ADDED');
    assert.equal(body.log.quantity, 3);
    assert.equal(body.log.reason, 'New shipment arrived');
  });

  it('2. Fails to add stock with invalid or non-positive quantity', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products/${createdProductId}/add-stock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        quantity: 0
      })
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.status, 'error');
  });

  it('3. Fetches inventory logs via GET /products/:id/inventory-logs', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products/${createdProductId}/inventory-logs`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tenantToken}`
      }
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 2); // Initial creation log + stock added log
    const addLog = body.data.find((l) => l.change_type === 'STOCK_ADDED');
    assert.ok(addLog);
    assert.equal(addLog.quantity, 3);
  });

  it('4. Restores damaged stock via POST /products/:id/restore-damaged', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products/${createdProductId}/restore-damaged`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        quantity: 1,
        reason: 'Dry-cleaned and repaired tear'
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.log.change_type, 'RESTORED');
    assert.equal(body.log.quantity, 1);
    assert.equal(body.log.reason, 'Dry-cleaned and repaired tear');
  });

  it('5. Rejects restoring with zero or negative quantity', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products/${createdProductId}/restore-damaged`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        quantity: 0
      })
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.status, 'error');
  });

  it('6. Deletes product via DELETE /products/:id when no active bookings exist', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products/${createdProductId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${tenantToken}`
      }
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');

    // Confirm product is gone
    const checkRes = await fetch(`${baseUrl}/api/v1/tenant/products/${createdProductId}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(checkRes.status, 404);
  });
});
