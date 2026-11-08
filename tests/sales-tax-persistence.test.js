import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/config/prisma.js';
import { closeDatabasePool } from '../src/config/db.js';
import { ensureTestTenant } from './testTenantHelper.js';

describe('Sales Tax Rate Persistence and Item Breakdown Tests', () => {
  let server;
  let baseUrl;
  let tenantToken = '';
  let tenantId = '';
  let testProduct1Id = '';
  let testProduct2Id = '';

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
      body: JSON.stringify({ email: 'khodal@kapadkart.com', password: 'Khodal@123' })
    });
    const loginData = await loginRes.json();
    tenantToken = loginData.token;

    // Create 2 test products
    const suffix = Date.now().toString().slice(-4);
    const p1 = await prisma.product.create({
      data: {
        tenantId,
        productName: 'GST Test Product X',
        productCode: `GX-${suffix}`,
        salePrice: 1000,
        totalQuantity: 20,
        availabilityType: 'sell',
        category: 'Test'
      }
    });
    testProduct1Id = p1.id;

    const p2 = await prisma.product.create({
      data: {
        tenantId,
        productName: 'GST Test Product Y',
        productCode: `GY-${suffix}`,
        salePrice: 2000,
        totalQuantity: 20,
        availabilityType: 'sell',
        category: 'Test'
      }
    });
    testProduct2Id = p2.id;
  });

  after(async () => {
    if (tenantId) {
      await prisma.billShareToken.deleteMany({
        where: { tenantId }
      });
      await prisma.saleItem.deleteMany({
        where: { sale: { tenantId, customerName: { in: ['GST Flow Test Customer', 'Cash and Carry Customer'] } } }
      });
      await prisma.sale.deleteMany({
        where: { tenantId, customerName: { in: ['GST Flow Test Customer', 'Cash and Carry Customer'] } }
      });
      await prisma.productInventoryLog.deleteMany({
        where: { productId: { in: [testProduct1Id, testProduct2Id] } }
      });
      await prisma.product.deleteMany({
        where: { id: { in: [testProduct1Id, testProduct2Id] } }
      });
    }
    await Promise.allSettled([closeDatabasePool(), disconnectPrisma()]);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('1. Creates a sale with 0% tax rate and preserves 0% tax even if store settings change', async () => {
    // Bill with X=1000 (qty 1) and Y=2000 (qty 1) -> Subtotal 3000, Tax 0, Total 3000
    const createRes = await fetch(`${baseUrl}/api/v1/tenant/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        customer_name: 'GST Flow Test Customer',
        phone_number: '9876543210',
        tax_rate: 0,
        tax_amount: 0,
        discount_amount: 0,
        paid_amount: 3000,
        items: [
          { product_id: testProduct1Id, quantity: 1, unit_price: 1000, total_amount: 1000 },
          { product_id: testProduct2Id, quantity: 1, unit_price: 2000, total_amount: 2000 }
        ]
      })
    });

    const createData = await createRes.json();
    assert.strictEqual(createRes.status, 201);
    assert.strictEqual(Number(createData.data.tax_rate), 0);
    assert.strictEqual(Number(createData.data.tax_amount), 0);
    assert.strictEqual(Number(createData.data.sale_total), 3000);
    assert.strictEqual(Number(createData.data.paid_amount), 3000);
    assert.strictEqual(Number(createData.data.due_amount), 0);

    const saleId = createData.data.id;

    // Verify item-level breakdown on fetched sale
    const getRes = await fetch(`${baseUrl}/api/v1/tenant/sales/${saleId}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const getData = await getRes.json();
    assert.strictEqual(getData.data.items.length, 2);
    assert.strictEqual(Number(getData.data.items[0].tax_amount), 0);
    assert.strictEqual(Number(getData.data.items[1].tax_amount), 0);

    // 2. Now update the sale: add another unit of X (qty 2 of X = 2000, qty 1 of Y = 2000 -> Subtotal 4000)
    // The bill must preserve tax_rate = 0!
    const updateRes = await fetch(`${baseUrl}/api/v1/tenant/sales/${saleId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        customer_name: 'GST Flow Test Customer',
        phone_number: '9876543210',
        tax_rate: 0,
        tax_amount: 0,
        discount_amount: 0,
        paid_amount: 4000,
        items: [
          { product_id: testProduct1Id, quantity: 2, unit_price: 1000, total_amount: 2000 },
          { product_id: testProduct2Id, quantity: 1, unit_price: 2000, total_amount: 2000 }
        ]
      })
    });

    const updateData = await updateRes.json();
    assert.strictEqual(updateRes.status, 200);
    assert.strictEqual(Number(updateData.data.tax_rate), 0);
    assert.strictEqual(Number(updateData.data.tax_amount), 0);
    assert.strictEqual(Number(updateData.data.sale_total), 4000);
  });

  it('2. Creates a sale with 10% tax rate and stores item-level proportional GST breakdown', async () => {
    // Subtotal 3000, Discount 300, Taxable 2700, 10% Tax = 270, Final Total = 2970
    const createRes = await fetch(`${baseUrl}/api/v1/tenant/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        customer_name: 'GST Flow Test Customer',
        phone_number: '9876543210',
        tax_rate: 10,
        tax_amount: 270,
        discount_amount: 300,
        paid_amount: 2970,
        items: [
          { product_id: testProduct1Id, quantity: 1, unit_price: 1000, discount_amount: 100, tax_amount: 90, total_amount: 990 },
          { product_id: testProduct2Id, quantity: 1, unit_price: 2000, discount_amount: 200, tax_amount: 180, total_amount: 1980 }
        ]
      })
    });

    const createData = await createRes.json();
    assert.strictEqual(createRes.status, 201);
    assert.strictEqual(Number(createData.data.tax_rate), 10);
    assert.strictEqual(Number(createData.data.tax_amount), 270);
    assert.strictEqual(Number(createData.data.sale_total), 2970);
    assert.strictEqual(Number(createData.data.paid_amount), 2970);

    const saleId = createData.data.id;

    // Check item-level breakdown
    const getRes = await fetch(`${baseUrl}/api/v1/tenant/sales/${saleId}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const getData = await getRes.json();
    assert.strictEqual(getData.data.items.length, 2);
    // Product 1 (1000 - 100 discount + 90 tax = 990)
    assert.strictEqual(Number(getData.data.items[0].discount_amount), 100);
    assert.strictEqual(Number(getData.data.items[0].tax_amount), 90);
    assert.strictEqual(Number(getData.data.items[0].total_amount), 990);

    // Product 2 (2000 - 200 discount + 180 tax = 1980)
    assert.strictEqual(Number(getData.data.items[1].discount_amount), 200);
    assert.strictEqual(Number(getData.data.items[1].tax_amount), 180);
    assert.strictEqual(Number(getData.data.items[1].total_amount), 1980);
  });

  it('3. Direct sale with paid amount less than gross auto-discounts difference, sets due to 0, and PDF invoice omits zero due row', async () => {
    // Subtotal 1000, 0% tax, Customer pays 800 -> Discount 200, Final 800, Paid 800, Due 0
    const createRes = await fetch(`${baseUrl}/api/v1/tenant/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        customer_name: 'Cash and Carry Customer',
        phone_number: '9876543210',
        tax_rate: 0,
        tax_amount: 0,
        discount_amount: 200,
        paid_amount: 800,
        items: [
          { product_id: testProduct1Id, quantity: 1, unit_price: 1000, discount_amount: 200, tax_amount: 0, total_amount: 800 }
        ]
      })
    });

    const createData = await createRes.json();
    assert.strictEqual(createRes.status, 201);
    assert.strictEqual(Number(createData.data.sale_total), 800);
    assert.strictEqual(Number(createData.data.paid_amount), 800);
    assert.strictEqual(Number(createData.data.discount_amount), 200);
    assert.strictEqual(Number(createData.data.due_amount), 0);

    const saleId = createData.data.id;

    // Test PDF generation endpoint via share-link
    const shareRes = await fetch(`${baseUrl}/api/v1/tenant/sales/${saleId}/share-link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const shareData = await shareRes.json();
    assert.strictEqual(shareRes.status, 200);
    const token = shareData.data.token;

    const pdfRes = await fetch(`${baseUrl}/api/v1/public/bills/download/${token}`);
    assert.strictEqual(pdfRes.status, 200);
    assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');

    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
    assert.ok(pdfBuffer.length > 500, 'PDF buffer should be non-empty');
    const pdfText = pdfBuffer.toString('latin1');
    assert.ok(!pdfText.includes('Remaining Due (Baki)'), 'PDF should omit Remaining Due row when due is 0');
    assert.ok(!pdfText.includes('Fully Paid (₹0.00 Due)'), 'PDF should omit Fully Paid (₹0.00 Due) row when due is 0');
  });
});
