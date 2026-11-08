import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { closeDatabasePool, query } from '../src/config/db.js';
import { disconnectPrisma } from '../src/config/prisma.js';
import { storageService, ALLOWED_MIME_TYPES } from '../src/services/storage/index.js';
import { ensureTestTenant } from './testTenantHelper.js';

describe('Generic Storage Engine & Dual Product Images', () => {
  let server;
  let baseUrl;
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

    // Obtain tenant token
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'khodal@kapadkart.com', password: 'Khodal@123' })
    });
    const loginData = await loginRes.json();
    tenantToken = loginData.token;
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

  it('StorageService defaults to "local" provider when not overridden', () => {
    const provider = storageService.getActiveProviderName();
    assert.equal(provider, 'local');
    assert.ok(ALLOWED_MIME_TYPES.includes('image/jpeg'));
    assert.ok(ALLOWED_MIME_TYPES.includes('image/png'));
    assert.ok(ALLOWED_MIME_TYPES.includes('image/webp'));
  });

  it('StorageService rejects dangerous or disallowed MIME types', async () => {
    const fakeBuffer = Buffer.from('console.log("malicious");');
    await assert.rejects(
      async () => {
        await storageService.upload({
          buffer: fakeBuffer,
          mimetype: 'application/javascript',
          originalname: 'hack.js'
        });
      },
      /Invalid file type/
    );
  });

  it('StorageService successfully stores an image locally and deletes it', async () => {
    // 1x1 transparent PNG sample buffer
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    const uploaded = await storageService.upload({
      buffer: pngBuffer,
      mimetype: 'image/png',
      originalname: 'test-pixel.png',
      folder: 'test',
      tenantId: 'test-tenant'
    });

    assert.equal(uploaded.provider, 'local');
    assert.ok(uploaded.key.startsWith('test/test-tenant/'));
    assert.ok(uploaded.url.includes('/uploads/test/test-tenant/'));
    assert.equal(uploaded.mimetype, 'image/webp');
    assert.ok(uploaded.key.endsWith('.webp'));

    const deleted = await storageService.delete(uploaded.key);
    assert.equal(deleted, true);
  });

  it('POST /api/v1/upload/image accepts multipart image upload', async () => {
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    const formData = new FormData();
    const blob = new Blob([pngBuffer], { type: 'image/png' });
    formData.append('file', blob, 'pixel.png');
    formData.append('folder', 'logos');

    const res = await fetch(`${baseUrl}/api/v1/upload/image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantToken}` },
      body: formData
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.status, 'success');
    assert.ok(data.data.url.includes('/uploads/logos/'));

    // Cleanup
    await storageService.delete(data.data.key);
  });

  it('POST /api/v1/upload/product-images accepts 2 product images simultaneously', async () => {
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    const formData = new FormData();
    formData.append('image', new Blob([pngBuffer], { type: 'image/png' }), 'primary.png');
    formData.append('image2', new Blob([pngBuffer], { type: 'image/png' }), 'secondary.png');

    const res = await fetch(`${baseUrl}/api/v1/upload/product-images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantToken}` },
      body: formData
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.status, 'success');
    assert.ok(data.data.image.url.includes('/uploads/products/'));
    assert.ok(data.data.image2.url.includes('/uploads/products/'));

    // Cleanup
    await storageService.delete(data.data.image.key);
    await storageService.delete(data.data.image2.key);
  });

  it('Product creation supports 2 images per product (image and image2)', async () => {
    const testCode = `TEST-P-${Date.now().toString().slice(-4)}`;
    const productRes = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        product_name: 'Dual Image Royal Sherwani',
        product_code: testCode,
        size: 'L',
        image: 'http://localhost:4000/uploads/products/khodal/front-view.jpg',
        image2: 'http://localhost:4000/uploads/products/khodal/back-view.jpg',
        category: 'Sherwani',
        daily_rent: 2200,
        sale_price: 25000,
        total_quantity: 3
      })
    });

    const data = await productRes.json();
    assert.equal(productRes.status, 201);
    assert.equal(data.status, 'success');
    assert.equal(data.data.product_code, testCode);
    assert.equal(data.data.image, 'http://localhost:4000/uploads/products/khodal/front-view.jpg');
    assert.equal(data.data.image2, 'http://localhost:4000/uploads/products/khodal/back-view.jpg');

    // Verify retrieval in product list
    const listRes = await fetch(`${baseUrl}/api/v1/tenant/products`, {
      headers: { Authorization: `Bearer ${tenantToken}` }
    });
    const listData = await listRes.json();
    const createdProduct = listData.data.find((p) => p.product_code === testCode);
    assert.ok(createdProduct);
    assert.equal(createdProduct.image, 'http://localhost:4000/uploads/products/khodal/front-view.jpg');
    assert.equal(createdProduct.image2, 'http://localhost:4000/uploads/products/khodal/back-view.jpg');

    // Clean test row
    await query(`DELETE FROM app.products WHERE product_code = $1;`, [testCode]);
  });

  it('Shop settings updates and persists logo_url and bill_show_logo', async () => {
    const testLogoUrl = 'http://localhost:4000/uploads/logos/khodal-logo.png';
    const settingsRes = await fetch(`${baseUrl}/api/v1/tenant/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`
      },
      body: JSON.stringify({
        logo_url: testLogoUrl,
        bill_show_logo: true
      })
    });

    const settingsData = await settingsRes.json();
    assert.equal(settingsRes.status, 200);
    assert.equal(settingsData.status, 'success');
    assert.equal(settingsData.data.logo_url, testLogoUrl);
    assert.equal(settingsData.data.bill_show_logo, true);
  });
});
