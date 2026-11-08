import app from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { getActiveDatabaseConfig, closeDatabasePool } from './config/db.js';
import { disconnectPrisma } from './config/prisma.js';

const PORT = env.PORT;
const HOST = '0.0.0.0';
const dbConfig = getActiveDatabaseConfig();

const server = app.listen(PORT, HOST, () => {
  logger.info(`KapadKart backend API server listening`, {
    port: PORT,
    host: HOST,
    environment: env.NODE_ENV,
    url: `http://localhost:${PORT}`,
    database: {
      source: dbConfig.source,
      host: dbConfig.host,
      name: dbConfig.database,
      ssl: dbConfig.ssl
    }
  });
});

// Explicit port conflict error detection
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use. Please stop the conflicting process or update PORT.`, {
      port: PORT,
      code: err.code
    });
    process.exit(1);
  } else {
    logger.error('Server encountered fatal error during startup', { error: err.message });
    process.exit(1);
  }
});

// Graceful shutdown handling
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  // Close database pool and Prisma client
  await Promise.allSettled([
    closeDatabasePool(),
    disconnectPrisma()
  ]);

  server.close((err) => {
    if (err) {
      logger.error('Error occurred while closing HTTP server', { error: err.message });
      process.exit(1);
    }
    logger.info('HTTP server closed cleanly. Exiting process.');
    process.exit(0);
  });

  // Force close after 10s if connections refuse to terminate
  setTimeout(() => {
    logger.error('Forcefully terminating process due to shutdown timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception thrown', {
    error: err.message,
    stack: err.stack
  });
  process.exit(1);
});
