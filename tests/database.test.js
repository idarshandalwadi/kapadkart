import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { query, closeDatabasePool } from '../src/config/db.js';
import { disconnectPrisma } from '../src/config/prisma.js';

describe('Database Schema & Seed Verification', () => {
  after(async () => {
    await Promise.allSettled([
      closeDatabasePool(),
      disconnectPrisma()
    ]);
  });

  it('verifies all 19 tables exist in the app schema', async () => {
    const res = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'app' 
      ORDER BY table_name;
    `);

    const tableNames = res.rows.map((r) => r.table_name);
    const expectedTables = [
      'activity_logs',
      'booking_items',
      'booking_returns',
      'bookings',
      'brands',
      'categories',
      'email_logs',
      'password_change_logs',
      'password_reset_otps',
      'payments',
      'platform_admins',
      'product_inventory_logs',
      'products',
      'revoked_tokens',
      'sale_items',
      'sales',
      'settings',
      'tenants',
      'users'
    ];

    for (const expected of expectedTables) {
      assert.ok(tableNames.includes(expected), `Missing expected table: app.${expected}`);
    }
  });

  it('verifies seeded PlatformAdmin credentials and password hash', async () => {
    const res = await query(
      `SELECT username, email, password_hash, full_name FROM app.platform_admins WHERE username = $1`,
      ['kapadkart']
    );

    assert.equal(res.rows.length, 1);
    const admin = res.rows[0];
    assert.equal(admin.username, 'kapadkart');
    assert.equal(admin.email, 'admin@kapadkart.com');

    const isValidPassword = await bcrypt.compare('Admin123', admin.password_hash);
    assert.equal(isValidPassword, true, 'Admin123 password should match the bcrypt hash');
  });

  it('verifies the seeded Khodal test shop and owner password', async () => {
    const tenantRes = await query(
      `SELECT id, slug, status FROM app.tenants WHERE slug = $1`,
      ['khodal-mahakali-shop']
    );
    assert.equal(tenantRes.rows.length, 1);
    assert.equal(tenantRes.rows[0].status, 'active');

    const userRes = await query(
      `SELECT email, password_hash, full_name FROM app.users WHERE tenant_id = $1 AND email = $2`,
      [tenantRes.rows[0].id, 'khodal@kapadkart.com']
    );
    assert.equal(userRes.rows.length, 1);
    assert.equal(userRes.rows[0].full_name, 'mahakali');
    const passwordMatches = await bcrypt.compare('Khodal@123', userRes.rows[0].password_hash);
    assert.equal(passwordMatches, true, 'Khodal@123 password should match the bcrypt hash');
  });
});

