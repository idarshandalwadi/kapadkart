import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

const globalForPrisma = globalThis;

/**
 * PostgreSQL URL for the Prisma client, built from LOCAL_DB_*.
 * The Prisma CLI reads DATABASE_URL from the environment instead.
 */
function resolveDatabaseUrl() {
  const user = encodeURIComponent(env.LOCAL_DB_USER || 'postgres');
  const password = env.LOCAL_DB_PASSWORD ? encodeURIComponent(env.LOCAL_DB_PASSWORD) : '';
  const auth = password ? `${user}:${password}` : user;
  const host = env.LOCAL_DB_HOST || 'localhost';
  const port = env.LOCAL_DB_PORT || 5432;
  const dbName = env.LOCAL_DB_NAME || 'kapadkart';

  return `postgresql://${auth}@${host}:${port}/${dbName}?schema=app`;
}

const activeUrl = resolveDatabaseUrl();

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasources: {
      db: {
        url: activeUrl
      }
    },
    log:
      env.LOG_LEVEL === 'debug'
        ? ['query', 'info', 'warn', 'error']
        : ['warn', 'error']
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Graceful client disconnection on server termination
 */
export async function disconnectPrisma() {
  try {
    await prisma.$disconnect();
  } catch (err) {
    console.error('[Prisma] Error during disconnect:', err.message);
  }
}

/**
 * Standardized Prisma error code mapper for API responses
 */
export function formatPrismaError(error, defaultMessage = 'Database operation failed') {
  if (!error) return { status: 500, message: defaultMessage };

  // P2002: Unique constraint violation
  if (error.code === 'P2002') {
    const target = Array.isArray(error.meta?.target) ? error.meta.target.join(', ') : error.meta?.target || 'field';
    return {
      status: 409,
      code: 'UNIQUE_CONSTRAINT_VIOLATION',
      message: `A record with this ${target} already exists.`
    };
  }

  // P2025: Record not found
  if (error.code === 'P2025') {
    return {
      status: 404,
      code: 'RECORD_NOT_FOUND',
      message: 'The requested record was not found.'
    };
  }

  // P2003: Foreign key constraint failure
  if (error.code === 'P2003') {
    return {
      status: 400,
      code: 'FOREIGN_KEY_VIOLATION',
      message: 'Referenced entity does not exist or cannot be modified.'
    };
  }

  return {
    status: error.status || 500,
    code: error.code || 'DATABASE_ERROR',
    message: error.message || defaultMessage
  };
}

export async function checkPrismaConnection() {
  const startTime = Date.now();
  try {
    const result = await prisma.$queryRaw`SELECT NOW() as current_time, current_database() as database, version() as version;`;
    const latencyMs = Date.now() - startTime;
    const row = result[0] || {};
    return {
      status: 'connected',
      source: 'local',
      database: row.database,
      host: env.LOCAL_DB_HOST || 'localhost',
      latencyMs,
      serverTime: row.current_time,
      version: row.version
    };
  } catch (error) {
    return {
      status: 'disconnected',
      source: 'local',
      host: env.LOCAL_DB_HOST || 'localhost',
      error: error.message
    };
  }
}

