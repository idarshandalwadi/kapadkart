import { getClient, closeDatabasePool, getActiveDatabaseConfig } from '../config/db.js';
import { seedInitialAccounts } from './seedData.js';

async function runSeed() {
  const activeDb = getActiveDatabaseConfig();
  console.log(`[Seed] Starting database seeding on target: ${activeDb.source.toUpperCase()} (${activeDb.host} / ${activeDb.database})...`);

  const client = await getClient();

  try {
    await client.query('BEGIN');

    const { platformAdmin, shop, owner } = await seedInitialAccounts(client);
    console.log(`[Seed] ✔ Platform Admin seeded: username='${platformAdmin.username}', email='${platformAdmin.email}', auth_key='${platformAdmin.auth_key}' (ID: ${platformAdmin.id})`);
    console.log(`[Seed] ✔ Test shop seeded: slug='${shop.slug}', owner='${owner.email}' (ID: ${shop.id})`);

    await client.query('COMMIT');
    console.log('[Seed] Platform admin and Khodal test shop seeded successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Seed] Seeding failed, transaction rolled back:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await closeDatabasePool();
  }
}

runSeed();
