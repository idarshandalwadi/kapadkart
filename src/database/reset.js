import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { getClient, closeDatabasePool, getActiveDatabaseConfig } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runReset() {
  const activeDb = getActiveDatabaseConfig();
  console.log(`[Reset] Initiating database reset on: ${activeDb.source.toUpperCase()} (${activeDb.host} / ${activeDb.database})...`);

  const client = await getClient();

  try {
    // 1. Drop existing app schema completely
    console.log('[Reset] Dropping schema "app" with CASCADE...');
    await client.query('DROP SCHEMA IF EXISTS app CASCADE;');
    console.log('[Reset] ✔ Schema "app" dropped successfully.');

    // 2. Read and execute consolidated schema.sql
    const schemaPath = path.resolve(__dirname, 'schema.sql');
    console.log(`[Reset] Applying schema from: ${schemaPath}`);
    const schemaSql = await fs.promises.readFile(schemaPath, 'utf8');
    await client.query(schemaSql);
    console.log('[Reset] ✔ Full schema re-created successfully.');

    // 3. Seed ONLY the Platform Administrator (Single Admin Account)
    console.log('[Reset] Seeding single Platform Administrator account...');
    await client.query('BEGIN');

    const adminPasswordHash = await bcrypt.hash('Admin123', 10);
    const adminRes = await client.query(
      `
      INSERT INTO app.platform_admins (username, email, password_hash, full_name)
      VALUES ($1, $2, $3, $4)
      RETURNING id, auth_key, username, email, full_name;
      `,
      ['kapadkart', 'admin@kapadkart.com', adminPasswordHash, 'Platform Administrator']
    );
    const admin = adminRes.rows[0];
    console.log(`[Reset] ✔ Platform Admin created: email='${admin.email}', auth_key='${admin.auth_key}' (ID: ${admin.id})`);

    await client.query('COMMIT');

    // 4. Verification
    const tenantCheck = await client.query('SELECT count(*) as count FROM app.tenants;');
    const prodCheck = await client.query('SELECT count(*) as count FROM app.products;');
    const bookCheck = await client.query('SELECT count(*) as count FROM app.bookings;');
    const saleCheck = await client.query('SELECT count(*) as count FROM app.sales;');

    console.log(`[Reset] ✔ Verification - Tenants: ${tenantCheck.rows[0].count}, Products: ${prodCheck.rows[0].count}, Bookings: ${bookCheck.rows[0].count}, Sales: ${saleCheck.rows[0].count}`);
    console.log('[Reset] Database reset completed successfully with only 1 Platform Admin!');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Reset] Failed to reset database:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await closeDatabasePool();
  }
}

runReset();
