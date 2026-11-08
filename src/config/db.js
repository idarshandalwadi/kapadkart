import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

/**
 * Local PostgreSQL connection used by the API.
 */
function resolveDatabaseConfig() {
  return {
    source: 'local',
    host: env.LOCAL_DB_HOST || 'localhost',
    port: env.LOCAL_DB_PORT || 5432,
    user: env.LOCAL_DB_USER || 'postgres',
    password: env.LOCAL_DB_PASSWORD,
    database: env.LOCAL_DB_NAME || 'kapadkart',
    ssl: false
  };
}

const activeConfig = resolveDatabaseConfig();

export const pool = new Pool({
  host: activeConfig.host,
  port: activeConfig.port,
  user: activeConfig.user,
  password: activeConfig.password,
  database: activeConfig.database,
  ssl: false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// Suppress unhandled pool error crashes, log warning
pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle database client:', err.message);
});

/**
 * Return safe active database metadata (host and name only, never credentials).
 */
export function getActiveDatabaseConfig() {
  return {
    source: activeConfig.source,
    host: activeConfig.host,
    database: activeConfig.database,
    ssl: false
  };
}

/**
 * Generic query execution wrapper with parameter support
 */
export async function query(text, params = []) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;

  if (env.LOG_LEVEL === 'debug') {
    console.debug('[DB Query]', { text, duration: `${duration}ms`, rows: res.rowCount });
  }

  return res;
}

/**
 * Acquire a dedicated client from the pool (e.g. for transactions)
 */
export async function getClient() {
  return await pool.connect();
}

/**
 * Live database connectivity probe for health checks
 */
export async function checkDatabaseConnection() {
  const startTime = Date.now();
  try {
    const result = await pool.query(
      'SELECT NOW() as current_time, current_database() as database, version() as version;'
    );
    const latencyMs = Date.now() - startTime;
    const row = result.rows[0];

    return {
      status: 'connected',
      source: activeConfig.source,
      database: row.database,
      host: activeConfig.host,
      latencyMs,
      serverTime: row.current_time,
      version: row.version
    };
  } catch (error) {
    return {
      status: 'disconnected',
      source: activeConfig.source,
      host: activeConfig.host,
      error: error.message
    };
  }
}

/**
 * Clean pool teardown for graceful server shutdown
 */
export async function closeDatabasePool() {
  try {
    await pool.end();
    console.info(`[DB] Database connection pool closed (${activeConfig.source}).`);
  } catch (err) {
    console.error('[DB] Error during pool termination:', err.message);
  }
}
