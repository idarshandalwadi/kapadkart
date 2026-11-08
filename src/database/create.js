import pg from 'pg';
import { env } from '../config/env.js';

const { Client } = pg;

function assertDatabaseName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `LOCAL_DB_NAME "${name}" is not a safe PostgreSQL identifier. Use letters, numbers, and underscores.`
    );
  }
  return name;
}

async function createDatabase() {
  const database = assertDatabaseName(env.LOCAL_DB_NAME);

  console.log(
    `[Create] Ensuring database "${database}" exists on ${env.LOCAL_DB_HOST}:${env.LOCAL_DB_PORT} as ${env.LOCAL_DB_USER}...`
  );

  const client = new Client({
    host: env.LOCAL_DB_HOST,
    port: env.LOCAL_DB_PORT,
    user: env.LOCAL_DB_USER,
    password: env.LOCAL_DB_PASSWORD,
    database: 'postgres',
    ssl: false,
    connectionTimeoutMillis: 5000
  });

  try {
    await client.connect();

    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);

    if (existing.rowCount > 0) {
      console.log(`[Create] Database "${database}" already exists.`);
      return;
    }

    await client.query(`CREATE DATABASE "${database}"`);
    console.log(`[Create] Database "${database}" created.`);
  } catch (error) {
    console.error('[Create] Failed to create database:', error.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

createDatabase();
