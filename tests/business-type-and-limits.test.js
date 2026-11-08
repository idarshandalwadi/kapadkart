import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';

describe('Shop Business Type and Configurable Usage Limits Verification', () => {
  let server;
  let baseUrl;
  let adminToken = '';

  const timestamp = Date.now();
  const salesSlug = `test-sales-shop-${timestamp}`;
  const salesEmail = `sales-owner-${timestamp}@test.com`;
  let shopToken = '';
  let prod1Id = null;

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    // Obtain Admin Token
    const adminLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@reantario.com', password: 'Admin123' })
    });
    const adminData = await adminLoginRes.json();
    adminToken = adminData.token;
  });

  after(async () => {
    // Clean up test shop
    const tenant = await prisma.tenant.findUnique({ where: { slug: salesSlug } });
    if (tenant) {
      await prisma.saleItem.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.sale.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.bookingItem.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.booking.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.product.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.user.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.setting.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.activityLog.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }

    if (server) {
      await new Promise((res) => server.close(res));
    }
  });

  it('Creates shop with SALES business type and numerical limits', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: 'Sales Only Shop',
        slug: salesSlug,
        businessType: 'SALES',
        owner_name: 'Sales Owner',
        owner_email: salesEmail,
        owner_phone: '9876543210',
        owner_password: 'Password@123',
        maxProducts: 2,
        maxBookings: 1,
        maxSales: 1
      })
    });

    const data = await res.json();
    assert.equal(res.status, 201);
    assert.equal(data.data.businessType, 'SALES');
    assert.equal(data.data.maxProducts, 2);
    assert.equal(data.data.maxBookings, 1);
    assert.equal(data.data.maxSales, 1);
  });

  it('Shop owner logs in and receives businessType and limits in auth payload', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: salesEmail,
        password: 'Password@123'
      })
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.token);
    shopToken = data.token;
    assert.equal(data.user.tenant.businessType, 'SALES');
    assert.equal(data.user.tenant.maxProducts, 2);
    assert.equal(data.user.tenant.maxSales, 1);
    assert.equal(data.tenant.businessType, 'SALES');
  });

  it('Public branding endpoint returns businessType and limits without admin session', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenants/${salesSlug}/branding`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.data.business_type, 'SALES');
    assert.equal(data.data.max_products, 2);
    assert.equal(data.data.max_sales, 1);
  });

  it('Enforces maxProducts limit when adding products', async () => {
    // Product 1 (success)
    const p1 = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shopToken}`
      },
      body: JSON.stringify({
        product_name: 'Product 1',
        product_code: 'SKU-001',
        sale_price: 1500,
        availability_type: 'sell',
        total_quantity: 10
      })
    });
    const p1Data = await p1.json();
    assert.equal(p1.status, 201);
    prod1Id = p1Data.data.id;

    // Product 2 (success)
    const p2 = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shopToken}`
      },
      body: JSON.stringify({
        product_name: 'Product 2',
        product_code: 'SKU-002',
        sale_price: 2500,
        availability_type: 'sell',
        total_quantity: 5
      })
    });
    assert.equal(p2.status, 201);

    // Product 3 (exceeds quota of 2 -> 403 Forbidden)
    const p3 = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shopToken}`
      },
      body: JSON.stringify({
        product_name: 'Product 3',
        product_code: 'SKU-003',
        sale_price: 3500,
        availability_type: 'sell',
        total_quantity: 2
      })
    });
    const p3Data = await p3.json();
    assert.equal(p3.status, 403);
    assert.match(p3Data.message, /Product limit reached/i);
  });

  it('Booking creation is rejected for SALES shop with 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tenant/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shopToken}`
      },
      body: JSON.stringify({
        customer_name: 'Test Customer',
        phone_number: '9876543210',
        pickup_date: new Date().toISOString(),
        return_date: new Date(Date.now() + 86400000 * 3).toISOString(),
        items: [{ product_id: prod1Id, quantity: 1, unit_rent: 500, rental_days: 3, total_amount: 1500 }]
      })
    });

    const data = await res.json();
    assert.equal(res.status, 400);
    assert.match(data.message, /Rental bookings are not supported for sales-only shops/i);
  });

  it('Rejects sale creation when unit_price is 0 or negative with 400', async () => {
    const zeroPriceRes = await fetch(`${baseUrl}/api/v1/tenant/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shopToken}`
      },
      body: JSON.stringify({
        customer_name: 'Customer Zero',
        phone_number: '9999988888',
        paid_amount: 0,
        items: [{ product_id: prod1Id, quantity: 1, unit_price: 0, total_amount: 0 }]
      })
    });
    const zeroData = await zeroPriceRes.json();
    assert.equal(zeroPriceRes.status, 400);
    assert.match(zeroData.message, /unit price greater than 0/i);

    const negPriceRes = await fetch(`${baseUrl}/api/v1/tenant/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shopToken}`
      },
      body: JSON.stringify({
        customer_name: 'Customer Neg',
        phone_number: '9999988888',
        paid_amount: 0,
        items: [{ product_id: prod1Id, quantity: 1, unit_price: -100, total_amount: -100 }]
      })
    });
    const negData = await negPriceRes.json();
    assert.equal(negPriceRes.status, 400);
    assert.match(negData.message, /unit price greater than 0/i);
  });

  it('Enforces maxSales limit when recording sales', async () => {
    // Sale 1 (success)
    const s1 = await fetch(`${baseUrl}/api/v1/tenant/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shopToken}`
      },
      body: JSON.stringify({
        customer_name: 'Customer 1',
        phone_number: '9999988888',
        paid_amount: 1500,
        items: [{ product_id: prod1Id, quantity: 1, unit_price: 1500, total_amount: 1500 }]
      })
    });
    const s1Data = await s1.json();
    assert.equal(s1.status, 201);

    // Sale 2 (exceeds quota of 1 -> 403 Forbidden)
    const s2 = await fetch(`${baseUrl}/api/v1/tenant/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shopToken}`
      },
      body: JSON.stringify({
        customer_name: 'Customer 2',
        phone_number: '9999988888',
        paid_amount: 1500,
        items: [{ product_id: prod1Id, quantity: 1, unit_price: 1500, total_amount: 1500 }]
      })
    });
    const s2Data = await s2.json();
    assert.equal(s2.status, 403);
    assert.match(s2Data.message, /Sales limit reached/i);
  });

  it('Switching from SALES to RENTAL with existing products and sales is blocked with 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/tenants/${salesSlug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        business_type: 'RENTAL'
      })
    });

    const data = await res.json();
    assert.equal(res.status, 400);
    assert.match(data.message, /Cannot (?:change|switch) shop from Sales to Rental/i);
  });

  it('Upgrading from SALES to SALES_AND_RENTAL is allowed', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/tenants/${salesSlug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        business_type: 'SALES_AND_RENTAL',
        max_products: 10,
        max_bookings: 10,
        max_sales: 10
      })
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.data.businessType, 'SALES_AND_RENTAL');
    assert.equal(data.data.maxProducts, 10);
  });

  it('Downgrading from SALES_AND_RENTAL to RENTAL is strictly forbidden with 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/tenants/${salesSlug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        business_type: 'RENTAL'
      })
    });

    const data = await res.json();
    assert.equal(res.status, 400);
    assert.match(data.message, /cannot be downgraded to a single business type/i);
  });

  it('Downgrading from SALES_AND_RENTAL to SALES is strictly forbidden with 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/tenants/${salesSlug}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        business_type: 'SALES'
      })
    });

    const data = await res.json();
    assert.equal(res.status, 400);
    assert.match(data.message, /cannot be downgraded to a single business type/i);
  });
});
