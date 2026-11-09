import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClient, closeDatabasePool, getActiveDatabaseConfig } from '../config/db.js';
import { seedInitialAccounts } from './seedData.js';

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

    // 3. Seed the platform admin and the Khodal test shop
    console.log('[Reset] Seeding platform admin and Khodal test shop...');
    await client.query('BEGIN');

    const { platformAdmin, shop, owner } = await seedInitialAccounts(client);
    console.log(`[Reset] ✔ Platform Admin created: email='${platformAdmin.email}', auth_key='${platformAdmin.auth_key}' (ID: ${platformAdmin.id})`);
    console.log(`[Reset] ✔ Test shop created: slug='${shop.slug}', owner='${owner.email}' (ID: ${shop.id})`);

    await client.query('COMMIT');

    // 4. Verification
    const tenantCheck = await client.query('SELECT count(*) as count FROM app.tenants;');
    const prodCheck = await client.query('SELECT count(*) as count FROM app.products;');
    const bookCheck = await client.query('SELECT count(*) as count FROM app.bookings;');
    const saleCheck = await client.query('SELECT count(*) as count FROM app.sales;');

    console.log(`[Reset] ✔ Verification - Tenants: ${tenantCheck.rows[0].count}, Products: ${prodCheck.rows[0].count}, Bookings: ${bookCheck.rows[0].count}, Sales: ${saleCheck.rows[0].count}`);
    console.log('[Reset] Database reset completed with the platform admin and the Khodal test shop.');
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
