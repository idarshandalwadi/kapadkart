import { getClient, closeDatabasePool, getActiveDatabaseConfig } from '../src/config/db.js';

/**
 * Truncate all tables in the 'app' schema EXCEPT 'platform_admins'.
 * Ensures zero data loss for PlatformAdmin records while wiping tenant,
 * catalog, inventory, booking, sale, session, and audit log data.
 */
async function clearAllExceptPlatformAdmins() {
  const activeDb = getActiveDatabaseConfig();
  console.log('====================================================');
  console.log('    KAPADKART — DATABASE RESET (EXCEPT ADMINS)       ');
  console.log('====================================================');
  console.log(`Target: ${activeDb.source.toUpperCase()} (${activeDb.host} / ${activeDb.database})`);

  const client = await getClient();

  try {
    // 1. Fetch all tables from 'app' schema
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'app' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    const allTables = tablesRes.rows.map((r) => r.table_name);
    console.log(`\nFound ${allTables.length} total tables in schema "app".`);

    // 2. Strict filter: exclude platform_admins
    const tablesToTruncate = allTables.filter((t) => t !== 'platform_admins');

    if (tablesToTruncate.includes('platform_admins')) {
      throw new Error('FATAL SAFETY VIOLATION: platform_admins must NEVER be included in truncation list!');
    }

    console.log(`\nTables to truncate (${tablesToTruncate.length} tables):`);
    tablesToTruncate.forEach((t) => console.log(`  - app.${t}`));
    console.log('\nTable PRESERVED:');
    console.log('  ★ app.platform_admins (WILL NOT BE MODIFIED)');

    // 3. Inspect admin count before
    const adminBeforeRes = await client.query('SELECT count(*) as count FROM app.platform_admins;');
    const adminCountBefore = parseInt(adminBeforeRes.rows[0].count, 10);
    console.log(`\nCurrent platform_admins count before reset: ${adminCountBefore}`);

    if (adminCountBefore === 0) {
      console.warn('⚠️ Warning: app.platform_admins has 0 rows before truncation.');
    }

    // 4. Execute atomic truncation
    console.log('\nExecuting atomic TRUNCATE on 18 tables...');
    await client.query('BEGIN;');

    const truncateSql = `TRUNCATE TABLE ${tablesToTruncate.map((t) => `app."${t}"`).join(', ')} CASCADE;`;
    await client.query(truncateSql);

    await client.query('COMMIT;');
    console.log('✔ Truncation completed successfully.');

    // 5. Post-truncation verification
    console.log('\n====================================================');
    console.log('              POST-RESET VERIFICATION              ');
    console.log('====================================================');

    const adminAfterRes = await client.query('SELECT count(*) as count FROM app.platform_admins;');
    const adminCountAfter = parseInt(adminAfterRes.rows[0].count, 10);

    if (adminCountAfter !== adminCountBefore) {
      throw new Error(`Data anomaly detected! Platform admins count changed from ${adminCountBefore} to ${adminCountAfter}`);
    }
    console.log(`✔ app.platform_admins count: ${adminCountAfter} (Preserved perfectly)`);

    let allEmpty = true;
    for (const t of tablesToTruncate) {
      const countRes = await client.query(`SELECT count(*) as count FROM app."${t}";`);
      const count = parseInt(countRes.rows[0].count, 10);
      if (count !== 0) {
        console.error(`❌ app.${t} still has ${count} rows!`);
        allEmpty = false;
      } else {
        console.log(`✔ app.${t}: 0 rows`);
      }
    }

    if (!allEmpty) {
      throw new Error('One or more tables failed to truncate completely.');
    }

    console.log('\n🎉 ALL DATA HAS BEEN REMOVED FROM ALL TABLES EXCEPT app.platform_admins!');
  } catch (err) {
    await client.query('ROLLBACK;').catch(() => {});
    console.error('\n❌ ERROR during database reset:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await closeDatabasePool();
  }
}

clearAllExceptPlatformAdmins();
