import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { closeDatabasePool } from '../src/config/db.js';
import { disconnectPrisma } from '../src/config/prisma.js';
import { ensureTestTenant } from './testTenantHelper.js';

describe('Multi-Portal Authentication & APIs', () => {
  let server;
  let baseUrl;
  let adminToken = '';
  let tenantToken = '';

  before(async () => {
    await ensureTestTenant();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await Promise.allSettled([
      closeDatabasePool(),
      disconnectPrisma()
    ]);
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it('POST /api/v1/auth/login succeeds for Platform Admin', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@reantario.com', password: 'Admin123' })
    });

    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'success');
    assert.equal(body.role, 'platform_admin');
    assert.ok(typeof body.token === 'string' && body.token.split('.').length === 3, 'Expected signed 3-part JWT');
    adminToken = body.token;
  });

  it('POST /api/v1/auth/login succeeds for Tenant User', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@reantario.com', password: 'Khodal@123' })
    });

    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'success');
    assert.equal(body.role, 'tenant_user');
    assert.ok(typeof body.token === 'string' && body.token.split('.').length === 3, 'Expected signed 3-part JWT');
    assert.equal(body.tenant.slug, 'khodal-mahakali-shop');
    tenantToken = body.token;
  });

  it('POST /api/v1/auth/login rejects incorrect password', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@reantario.com', password: 'WrongPassword' })
    });

    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.status, 'error');
  });

  it('Platform Admin can access admin overview and tenant detail', async () => {
    const overviewRes = await fetch(`${baseUrl}/api/v1/admin/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const overviewBody = await overviewRes.json();
    assert.equal(overviewRes.status, 200);
    assert.ok(overviewBody.data.tenants);

    const tenantsRes = await fetch(`${baseUrl}/api/v1/admin/tenants`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const tenantsBody = await tenantsRes.json();
    assert.equal(tenantsRes.status, 200);
    assert.ok(Array.isArray(tenantsBody.data));
    const khodalShop = tenantsBody.data.find((t) => t.slug === 'khodal-mahakali-shop');
    assert.ok(khodalShop, 'Expected khodal-mahakali-shop to exist in tenants');

    const detailRes = await fetch(`${baseUrl}/api/v1/admin/tenants/khodal-mahakali-shop`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const detailBody = await detailRes.json();
    assert.equal(detailRes.status, 200);
    assert.equal(detailBody.data.tenant.slug, 'khodal-mahakali-shop');
  });

  it('Tenant User can access tenant store overview and settings', async () => {
    const overviewRes = await fetch(`${baseUrl}/api/v1/tenant/overview`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const overviewBody = await overviewRes.json();
    assert.equal(overviewRes.status, 200);
    assert.ok(overviewBody.data.products);
    assert.ok(overviewBody.data.bookings);

    const settingsRes = await fetch(`${baseUrl}/api/v1/tenant/settings`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const settingsBody = await settingsRes.json();
    assert.equal(settingsRes.status, 200);
    assert.equal(settingsBody.data.company_name, 'khodal-mahakali-shop');
  });

  it('GET /api/v1/auth/me returns current session profile for both roles', async () => {
    const adminMeRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const adminMeBody = await adminMeRes.json();
    assert.equal(adminMeRes.status, 200);
    assert.equal(adminMeBody.role, 'platform_admin');
    assert.equal(adminMeBody.user.email, 'admin@reantario.com');

    const tenantMeRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const tenantMeBody = await tenantMeRes.json();
    assert.equal(tenantMeRes.status, 200);
    assert.equal(tenantMeBody.role, 'tenant_user');
    assert.equal(tenantMeBody.tenant.slug, 'khodal-mahakali-shop');
  });

  it('POST /api/v1/auth/logout revokes session token server-side', async () => {
    const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(logoutRes.status, 200);

    // Re-trying /me with the revoked token must return 401
    const postLogoutRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    assert.equal(postLogoutRes.status, 401);
    const postLogoutBody = await postLogoutRes.json();
    assert.equal(postLogoutBody.code, 'TOKEN_REVOKED');
  });
});
