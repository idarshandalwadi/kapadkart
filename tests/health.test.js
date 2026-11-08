import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { closeDatabasePool } from '../src/config/db.js';
import { disconnectPrisma } from '../src/config/prisma.js';

describe('API Health and Core Endpoints', () => {
  let server;
  let baseUrl;

  before(async () => {
    // Start server on an ephemeral random port
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

  it('GET /api/v1/health returns 200 with operational service and database status', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.status === 'ok' || body.status === 'degraded');
    assert.equal(body.service, 'kapadkart-api');
    assert.equal(typeof body.uptime, 'number');
    assert.ok(body.timestamp);
    assert.ok(Date.parse(body.timestamp));

    assert.ok(body.database);
    assert.equal(body.database.source, 'local');
    assert.ok(['connected', 'disconnected'].includes(body.database.status));
  });

  it('GET /api/v1/health/db returns probe with active configuration', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health/db`);
    assert.ok([200, 503].includes(res.status));

    const body = await res.json();
    assert.equal(body.service, 'kapadkart-api');
    assert.ok(body.config);
    assert.equal(body.config.source, 'local');
    assert.ok(body.probe);
  });

  it('GET /api/v1 returns 200 with API metadata', async () => {
    const res = await fetch(`${baseUrl}/api/v1`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.service, 'kapadkart-api');
    assert.equal(body.version, '1.0.0');
    assert.ok(body.message);
  });

  it('GET /api/v1/nonexistent returns 404 JSON error', async () => {
    const res = await fetch(`${baseUrl}/api/v1/nonexistent`);
    assert.equal(res.status, 404);

    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.ok(body.message.includes('Resource not found'));
  });

  it('POST /api/v1/validate-example validates request body via Zod', async () => {
    // 1. Invalid payload: missing message & bad email
    const invalidRes = await fetch(`${baseUrl}/api/v1/validate-example`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' })
    });
    assert.equal(invalidRes.status, 400);
    const invalidBody = await invalidRes.json();
    assert.equal(invalidBody.status, 'error');
    assert.ok(Array.isArray(invalidBody.details));

    // 2. Valid payload
    const validRes = await fetch(`${baseUrl}/api/v1/validate-example`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@kapadkart.com',
        message: 'Hello KapadKart API'
      })
    });
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json();
    assert.equal(validBody.status, 'success');
    assert.equal(validBody.data.email, 'test@kapadkart.com');
  });
});
