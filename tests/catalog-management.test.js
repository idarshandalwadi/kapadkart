import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { closeDatabasePool } from '../src/config/db.js';
import { disconnectPrisma } from '../src/config/prisma.js';
import { ensureTestTenant } from './testTenantHelper.js';

describe('Catalog Management: Brands & Categories', () => {
  let server;
  let baseUrl;
  let tenantToken = '';
  let tenantId = '';

  before(async () => {
    tenantId = await ensureTestTenant();

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    // Login as tenant user
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com', password: 'Khodal@123' })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    tenantToken = body.token;

    // Clean up test brands and categories for this test suite
    await prisma.product.deleteMany({
      where: {
        tenantId,
        productCode: { in: ['TEST-CAT-01', 'TEST-BRD-01'] }
      }
    });
    await prisma.brand.deleteMany({
      where: {
        tenantId,
        name: { in: ['Demo', 'Demo Brand', 'Nike', 'માનસી', 'ચણિયા ચોળી', 'Zara', 'H&m', 'H&M', 'Mango', 'Levis', 'Gucci', 'Prada', 'Chanel', 'Armani'] }
      }
    });
    await prisma.category.deleteMany({
      where: {
        tenantId,
        name: { in: ['Demo', 'Sherwani', 'શેરવાની', 'ચણિયા ચોળી', 'Designer Suit'] }
      }
    });
  });

  after(async () => {
    // Clean up test data
    if (tenantId) {
      await prisma.product.deleteMany({
        where: {
          tenantId,
          productCode: { in: ['TEST-CAT-01', 'TEST-BRD-01'] }
        }
      });
      await prisma.category.deleteMany({
        where: {
          tenantId,
          name: { in: ['Demo', 'Sherwani', 'શેરવાની', 'ચણિયા ચોળી', 'Designer Suit'] }
        }
      });
      await prisma.brand.deleteMany({
        where: {
          tenantId,
          name: { in: ['Demo', 'Demo Brand', 'Nike', 'માનસી', 'ચણિયા ચોળી', 'Zara', 'H&m', 'H&M', 'Mango', 'Levis', 'Gucci', 'Prada', 'Chanel', 'Armani'] }
        }
      });
    }

    await Promise.allSettled([
      closeDatabasePool(),
      disconnectPrisma()
    ]);
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it('Stores new category in Title Case and supports Gujarati values', async () => {
    // Test English Title Case: "dEMo" -> "Demo"
    const res1 = await fetch(`${baseUrl}/api/v1/tenant/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({ name: 'dEMo' })
    });
    const body1 = await res1.json();
    assert.equal(res1.status, 201);
    assert.equal(body1.data.name, 'Demo', 'Should convert dEMo to Title Case Demo');

    // Test Gujarati value: "શેરવાની" (Sherwani in Gujarati)
    const res2 = await fetch(`${baseUrl}/api/v1/tenant/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({ name: 'શેરવાની' })
    });
    const body2 = await res2.json();
    assert.equal(res2.status, 201);
    assert.equal(body2.data.name, 'શેરવાની', 'Should preserve Gujarati script without corruption');
  });

  it('Enforces case-insensitive duplicate rejection (Demo vs DEMO vs demo)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({ name: 'DEMO' })
    });
    const body = await res.json();
    assert.equal(res.status, 409, 'Should return 409 Conflict when case-variant already exists');
    assert.match(body.message, /already exists/i);
  });

  it('Supports pagination with 10 data items per page', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/categories?page=1&limit=10`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.pagination, 'Should include pagination metadata');
    assert.equal(body.pagination.page, 1);
    assert.equal(body.pagination.limit, 10);
    assert.ok(body.pagination.total >= 2);
  });

  it('POST /categories/bulk ignores template sample rows and deduplicates case-insensitively', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/categories/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        items: [
          'Sample Category (Example)',     // Template row -> ignored
          'Sherwani',                      // Real new item -> created
          'SHERWANI',                      // Duplicate of Sherwani in batch -> skipped
          'Demo',                          // Already in DB -> skipped
          'ચણિયા ચોળી',                     // Gujarati real item -> created
          'Sample Category 2 (Template)'   // Template row -> ignored
        ]
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.ignoredSampleCount, 2, 'Should ignore 2 sample template rows');
    assert.equal(body.data.importedCount, 2, 'Should import Sherwani and ચણિયા ચોળી');
    assert.equal(body.data.skippedCount, 2, 'Should skip SHERWANI (batch dup) and Demo (already in DB)');
  });

  it('Rejects bulk import if file contains ONLY template sample rows', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/categories/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        items: [
          'Sample Category 1 (Example)',
          'Sample Category 2 (Template)'
        ]
      })
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.match(body.message, /only sample template data/i);
  });

  it('POST /brands/bulk supports sheet source, 10 items, Title Casing, Gujarati, and records activity log', async () => {
    const sheetItems = [
      'zara',           // -> Zara
      'H&M',            // -> H&M
      'MANGO',          // -> Mango
      'levis',          // -> Levis
      'gucci',          // -> Gucci
      'PRADA',          // -> Prada
      'chanel',         // -> Chanel
      'માનસી',          // -> માનસી (Gujarati)
      'armani',         // -> Armani
      'zara'            // Duplicate in sheet -> skipped
    ];

    const res = await fetch(`${baseUrl}/api/v1/tenant/brands/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        items: sheetItems,
        source: 'sheet'
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.importedCount, 9, 'Should import 9 unique items');
    assert.equal(body.data.skippedCount, 1, 'Should skip 1 duplicate zara');

    // Verify activity log was recorded with source: 'sheet'
    const log = await prisma.activityLog.findFirst({
      where: {
        tenantId,
        action: 'bulk_create',
        entityType: 'brand'
      },
      orderBy: { createdAt: 'desc' }
    });
    assert.ok(log, 'Activity log entry should exist for bulk sheet add');
    assert.match(log.summary, /Bulk sheet added 9 brands/i);
    assert.equal(log.metadata?.source, 'sheet');
    assert.equal(log.metadata?.importedCount, 9);
    assert.equal(log.metadata?.skippedCount, 1);
  });

  it('Prevents deleting a category if even a single product is linked to it', async () => {
    // 1. Find category "Demo"
    const cat = await prisma.category.findFirst({
      where: { tenantId, name: 'Demo' }
    });
    assert.ok(cat, 'Category Demo should exist');

    // 2. Create a product assigned to category "Demo"
    await prisma.product.create({
      data: {
        tenantId,
        productName: 'Test Demo Sherwani',
        productCode: 'TEST-CAT-01',
        category: 'Demo',
        totalQuantity: 1
      }
    });

    // 3. Attempt to delete category "Demo" -> Should fail with 400
    const delRes = await fetch(`${baseUrl}/api/v1/tenant/categories/${cat.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const delBody = await delRes.json();
    assert.equal(delRes.status, 400, 'Should block deletion with 400');
    assert.match(delBody.message, /Cannot delete category/i);
    assert.match(delBody.message, /1 product\(s\) are assigned/i);

    // 4. Delete the product
    await prisma.product.deleteMany({
      where: { tenantId, productCode: 'TEST-CAT-01' }
    });

    // 5. Deletion of category "Demo" now succeeds
    const successRes = await fetch(`${baseUrl}/api/v1/tenant/categories/${cat.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(successRes.status, 200, 'Should delete successfully when 0 products linked');
  });

  it('Prevents deleting a brand if even a single product is linked to it', async () => {
    // 1. Create brand "Nike"
    const brand = await prisma.brand.create({
      data: { tenantId, name: 'Nike' }
    });

    // 2. Create a product assigned to brand "Nike"
    await prisma.product.create({
      data: {
        tenantId,
        productName: 'Test Nike Shoe',
        productCode: 'TEST-BRD-01',
        brand: 'Nike',
        totalQuantity: 1
      }
    });

    // 3. Attempt to delete brand "Nike" -> Should fail with 400
    const delRes = await fetch(`${baseUrl}/api/v1/tenant/brands/${brand.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const delBody = await delRes.json();
    assert.equal(delRes.status, 400, 'Should block deletion with 400');
    assert.match(delBody.message, /Cannot delete brand/i);
    assert.match(delBody.message, /1 product\(s\) are assigned/i);

    // 4. Delete the product
    await prisma.product.deleteMany({
      where: { tenantId, productCode: 'TEST-BRD-01' }
    });

    // 5. Deletion of brand "Nike" now succeeds
    const successRes = await fetch(`${baseUrl}/api/v1/tenant/brands/${brand.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(successRes.status, 200, 'Should delete successfully when 0 products linked');
  });
});
