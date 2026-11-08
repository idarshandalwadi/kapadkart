import bcrypt from 'bcryptjs';
import { getClient, closeDatabasePool, getActiveDatabaseConfig } from '../config/db.js';

async function runSeed() {
  const activeDb = getActiveDatabaseConfig();
  console.log(`[Seed] Starting database seeding on target: ${activeDb.source.toUpperCase()} (${activeDb.host} / ${activeDb.database})...`);

  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Seed ONLY the single PlatformAdmin: admin@kapadkart.com / Admin123
    const adminPasswordHash = await bcrypt.hash('Admin123', 10);
    const adminRes = await client.query(
      `
      INSERT INTO app.platform_admins (username, email, password_hash, full_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username) 
      DO UPDATE SET 
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        full_name = EXCLUDED.full_name,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, auth_key, username, email, full_name;
      `,
      ['kapadkart', 'admin@kapadkart.com', adminPasswordHash, 'Platform Administrator']
    );

    const platformAdmin = adminRes.rows[0];
    console.log(`[Seed] ✔ Single Platform Admin seeded: username='${platformAdmin.username}', email='${platformAdmin.email}', auth_key='${platformAdmin.auth_key}' (ID: ${platformAdmin.id})`);

    await client.query('COMMIT');
    console.log(`[Seed] Initial platform admin account seeded successfully!`);
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
