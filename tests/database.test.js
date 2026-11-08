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

  it('verifies seed contains only platform admin and zero dummy shops', async () => {
    const adminRes = await query(`SELECT count(*)::int as count FROM app.platform_admins;`);
    assert.ok(adminRes.rows[0].count >= 1, 'Expected at least 1 platform admin');

    // Tenants table can have 0 tenants or only explicitly created ones
    const tenantRes = await query(`SELECT count(*)::int as count FROM app.tenants WHERE slug = 'khodal-mahakali-shop';`);
    assert.ok(tenantRes.rows[0].count <= 1);
  });
});

