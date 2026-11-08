import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClient, closeDatabasePool, getActiveDatabaseConfig } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const activeDb = getActiveDatabaseConfig();
  console.log(`[Migration] Starting schema migration on target: ${activeDb.source.toUpperCase()} (${activeDb.host} / ${activeDb.database})...`);

  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const client = await getClient();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');

    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'app' 
      ORDER BY table_name;
    `);

    const tableNames = res.rows.map((r) => r.table_name);
    console.log(`[Migration] Schema applied successfully! Tables verified in 'app' namespace (${tableNames.length}):`);
    console.log(tableNames.map((t) => `  - app.${t}`).join('\n'));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Migration] Migration failed, transaction rolled back:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await closeDatabasePool();
  }
}

runMigration();
