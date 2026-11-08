import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/config/prisma.js';
import { closeDatabasePool } from '../src/config/db.js';
import { ensureTestTenant } from './testTenantHelper.js';

describe('Product Defaults, Brand Optionality, and Tenant Business Type Enforcement', () => {
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

    // Obtain tenant token for default SALES_AND_RENTAL tenant
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com', password: 'Khodal@123' })
    });
    const loginData = await loginRes.json();
    tenantToken = loginData.token;
  });

  after(async () => {
    if (tenantId) {
      await prisma.productInventoryLog.deleteMany({
        where: {
          product: { productCode: { in: ['TS-001', 'TS-002', 'TS-003', 'TS-004', 'TS-005', 'TS-006', 'TS-007', 'TS-DUP'] } }
        }
      });
      await prisma.product.deleteMany({
        where: { productCode: { in: ['TS-001', 'TS-002', 'TS-003', 'TS-004', 'TS-005', 'TS-006', 'TS-007', 'TS-DUP'] } }
      });
    }
    await Promise.allSettled([closeDatabasePool(), disconnectPrisma()]);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('Creates product with optional brand omitted -> brand is null', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Test Sherwani No Brand',
        product_code: 'TS-001',
        category: 'Ethnic Wear',
        size: 'XL'
        // brand omitted
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.data.brand, null);
    assert.equal(body.data.product_name, 'Test Sherwani No Brand');
  });

  it('Defaults status to "Available" when omitted', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Status Check Product',
        product_code: 'TS-002',
        category: 'Suits'
        // status omitted
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.status, 'Available');
  });

  it('Defaults total_quantity to 1 when omitted or empty', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Qty Default Product',
        product_code: 'TS-003',
        category: 'Accessories',
        total_quantity: '' // Empty string from frontend input
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.total_quantity, 1);
  });

  it('Defaults purchase_price, daily_rent, and sale_price to 0 when omitted or empty', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Zero Price Product',
        product_code: 'TS-004',
        category: 'Jewelry',
        purchase_price: '',
        daily_rent: '',
        sale_price: ''
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(Number(body.data.purchase_price), 0);
    assert.equal(Number(body.data.daily_rent), 0);
    assert.equal(Number(body.data.sale_price), 0);
  });

  it('Enforces availability_type and price isolation when tenant is RENTAL', async () => {
    // Temporarily switch tenant businessType to RENTAL
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { businessType: 'RENTAL' }
    });

    // Re-login to get updated token
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com', password: 'Khodal@123' })
    });
    const { token: rentalToken } = await loginRes.json();

    try {
      const res = await fetch(`${baseUrl}/api/v1/tenant/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rentalToken}`
        },
        body: JSON.stringify({
          product_name: 'Rental Bridal Lehenga',
          product_code: 'TS-005',
          category: 'Lehenga',
          daily_rent: 1500,
          sale_price: 25000, // Should be zeroed out because shop is RENTAL only
          availability_type: 'both' // Should be coerced to rent
        })
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.data.availability_type, 'rent');
      assert.equal(Number(body.data.daily_rent), 1500);
      assert.equal(Number(body.data.sale_price), 0); // Sale price zeroed for RENTAL business
    } finally {
      // Revert tenant back to SALES_AND_RENTAL
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { businessType: 'SALES_AND_RENTAL' }
      });
    }
  });

  it('Enforces availability_type and price isolation when tenant is SALES', async () => {
    // Temporarily switch tenant businessType to SALES
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { businessType: 'SALES' }
    });

    // Re-login to get updated token
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com', password: 'Khodal@123' })
    });
    const { token: salesToken } = await loginRes.json();

    try {
      const res = await fetch(`${baseUrl}/api/v1/tenant/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${salesToken}`
        },
        body: JSON.stringify({
          product_name: 'Retail Kurta',
          product_code: 'TS-006',
          category: 'Kurta',
          daily_rent: 500, // Should be zeroed out because shop is SALES only
          sale_price: 3200,
          availability_type: 'both' // Should be coerced to sell
        })
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.data.availability_type, 'sell');
      assert.equal(Number(body.data.sale_price), 3200);
      assert.equal(Number(body.data.daily_rent), 0); // Rent zeroed for SALES business
    } finally {
      // Revert tenant back to SALES_AND_RENTAL
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { businessType: 'SALES_AND_RENTAL' }
      });
    }
  });

  it('Persists gender on product creation, updates it via PUT, and returns it in formatProduct', async () => {
    // 1. Create with gender: 'Female'
    const createRes = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Bridal Lehenga',
        product_code: 'TS-007',
        category: 'Lehenga',
        gender: 'Female',
        daily_rent: 4500
      })
    });

    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.equal(createBody.status, 'success');
    assert.equal(createBody.data.gender, 'Female');
    const prodId = createBody.data.id;

    // 2. Fetch by ID and verify gender
    const getRes = await fetch(`${baseUrl}/api/v1/tenant/products/${prodId}`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.data.gender, 'Female');

    // 3. Update gender to 'Unisex' via PUT
    const updateRes = await fetch(`${baseUrl}/api/v1/tenant/products/${prodId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        gender: 'Unisex'
      })
    });

    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json();
    assert.equal(updateBody.data.gender, 'Unisex');

    // 4. Verify GET /products?gender=Unisex matches
    const filterRes = await fetch(`${baseUrl}/api/v1/tenant/products?gender=Unisex`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(filterRes.status, 200);
    const filterBody = await filterRes.json();
    const found = filterBody.data.find((p) => p.id === prodId);
    assert.ok(found);
    assert.equal(found.gender, 'Unisex');
  });

  it('Auto-selects availability_type to both when omitted for SALES_AND_RENTAL tenant and rejects invalid values', async () => {
    // 1. Creation with omitted availability_type for SALES_AND_RENTAL tenant
    const res = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Dual Purpose Sherwani',
        product_code: `TS-${Date.now()}`,
        category: 'Sherwani',
        daily_rent: 2000,
        sale_price: 15000
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.availability_type, 'both');
    const createdId = body.data.id;

    // 2. PUT with invalid availability_type -> 400
    const badPutRes = await fetch(`${baseUrl}/api/v1/tenant/products/${createdId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        availability_type: 'unknown_type'
      })
    });
    assert.equal(badPutRes.status, 400);

    // 3. PUT with valid availability_type 'rent' -> 200
    const goodPutRes = await fetch(`${baseUrl}/api/v1/tenant/products/${createdId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        availability_type: 'rent'
      })
    });
    assert.equal(goodPutRes.status, 200);
    const goodPutBody = await goodPutRes.json();
    assert.equal(goodPutBody.data.availability_type, 'rent');
  });

  it('Returns 409 with DUPLICATE_PRODUCT_CODE and inline fieldErrors when submitting duplicate product_code', async () => {
    // 1. Create first product with TS-DUP
    const firstRes = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Original Unique Product',
        product_code: 'TS-DUP',
        size: 'M',
        daily_rent: 1000
      })
    });
    assert.equal(firstRes.status, 201);

    // 2. Attempt creating second product with identical TS-DUP
    const dupRes = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Second Product With Same Code',
        product_code: 'TS-DUP',
        size: 'L',
        daily_rent: 1200
      })
    });

    assert.equal(dupRes.status, 409);
    const body = await dupRes.json();
    assert.equal(body.status, 'error');
    assert.equal(body.code, 'DUPLICATE_PRODUCT_CODE');
    assert.ok(body.fieldErrors?.product_code);
    assert.match(body.fieldErrors.product_code, /already exists/i);
    // Ensure no raw SQL / Prisma error is leaked
    assert.ok(!JSON.stringify(body).includes('Unique constraint failed'));
    assert.ok(!JSON.stringify(body).includes('Invalid `prisma.'));
  });
});


