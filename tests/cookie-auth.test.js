import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import app from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/config/prisma.js';
import { closeDatabasePool } from '../src/config/db.js';
import { ensureTestTenant } from './testTenantHelper.js';
import { AUTH_COOKIE_NAME } from '../src/utils/cookie.js';

describe('HttpOnly Cookie Authentication & Session Lifecycle', () => {
  let server;
  let baseUrl;

  before(async () => {
    await ensureTestTenant();

    // Ensure platform admin exists
    const adminHash = await bcrypt.hash('Admin@123', 10);
    await prisma.platformAdmin.upsert({
      where: { username: 'cookie_test_admin' },
      update: { passwordHash: adminHash },
      create: {
        username: 'cookie_test_admin',
        email: 'cookie_admin@kapadkart.com',
        passwordHash: adminHash,
        fullName: 'Cookie Test Admin'
      }
    });

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

  it('POST /api/v1/auth/login sets secure HttpOnly cookie for tenant user', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'khodal@reantario.com',
        password: 'Khodal@123'
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.role, 'tenant_user');

    // Verify Set-Cookie header contains kapadkart_token with HttpOnly and SameSite=Lax
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Set-Cookie header must be present');
    assert.ok(setCookie.includes(`${AUTH_COOKIE_NAME}=`), `Must set cookie ${AUTH_COOKIE_NAME}`);
    assert.ok(/httponly/i.test(setCookie), 'Cookie must have HttpOnly flag');
    assert.ok(/samesite=lax/i.test(setCookie), 'Cookie must have SameSite=Lax attribute');
  });

  it('GET /api/v1/auth/me authenticates via Cookie without Authorization header', async () => {
    // 1. Login to obtain cookie
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'khodal@kapadkart.com',
        password: 'Khodal@123'
      })
    });
    const setCookie = loginRes.headers.get('set-cookie');
    const cookieHeader = setCookie.split(';')[0]; // kapadkart_token=...

    // 2. Query /me sending ONLY the cookie, no Authorization header
    const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      method: 'GET',
      headers: {
        Cookie: cookieHeader,
        'X-Tenant-Slug': 'khodal-mahakali-shop'
      }
    });

    assert.equal(meRes.status, 200);
    const meBody = await meRes.json();
    assert.equal(meBody.status, 'success');
    assert.equal(meBody.role, 'tenant_user');
    assert.equal(meBody.user.email, 'khodal@reantario.com');
  });

  it('POST /api/v1/auth/logout clears cookie and revokes session server-side', async () => {
    // 1. Login
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'khodal@reantario.com',
        password: 'Khodal@123'
      })
    });
    const setCookie = loginRes.headers.get('set-cookie');
    const cookieHeader = setCookie.split(';')[0];

    // 2. Call logout using the cookie
    const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'X-Tenant-Slug': 'khodal-mahakali-shop'
      }
    });

    assert.equal(logoutRes.status, 200);
    const logoutCookie = logoutRes.headers.get('set-cookie');
    assert.ok(logoutCookie, 'Logout must send cookie clearance');
    // Express clearCookie sends either Max-Age=0 or an expired date
    assert.ok(
      logoutCookie.includes('Max-Age=0') || /expires=thu, 01 jan 1970/i.test(logoutCookie),
      'Logout must expire the cookie'
    );

    // 3. Re-verify /me using the revoked cookie -> must return 401 TOKEN_REVOKED
    const checkRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: {
        Cookie: cookieHeader,
        'X-Tenant-Slug': 'khodal-mahakali-shop'
      }
    });
    assert.equal(checkRes.status, 401);
    const checkBody = await checkRes.json();
    assert.equal(checkBody.code, 'TOKEN_REVOKED');
  });

  it('Platform Admin login sets HttpOnly cookie and validates session', async () => {
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'cookie_admin@kapadkart.com',
        password: 'Admin@123'
      })
    });

    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie');
    assert.ok(setCookie.includes(`${AUTH_COOKIE_NAME}=`));

    const cookieHeader = setCookie.split(';')[0];

    const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: {
        Cookie: cookieHeader
      }
    });

    assert.equal(meRes.status, 200);
    const meBody = await meRes.json();
    assert.equal(meBody.role, 'platform_admin');
    assert.equal(meBody.user.username, 'cookie_test_admin');
  });
});
