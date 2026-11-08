import { Router } from 'express';
import { env } from '../config/env.js';
import { getActiveDatabaseConfig } from '../config/db.js';
import { checkPrismaConnection } from '../config/prisma.js';

const router = Router();

/**
 * GET /api/v1/health
 * Returns process health status along with live database probe.
 */
router.get('/health', async (req, res) => {
  const dbHealth = await checkPrismaConnection();
  const isHealthy = dbHealth.status === 'connected';

  res.status(200).json({
    status: isHealthy ? 'ok' : 'degraded',
    service: 'kapadkart-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: env.NODE_ENV,
    database: {
      status: dbHealth.status,
      source: dbHealth.source,
      latencyMs: dbHealth.latencyMs || 0
    }
  });
});

/**
 * GET /api/v1/health/db
 * Dedicated database connectivity probe
 */
router.get('/health/db', async (req, res) => {
  const dbHealth = await checkPrismaConnection();
  const statusCode = dbHealth.status === 'connected' ? 200 : 503;

  res.status(statusCode).json({
    service: 'kapadkart-api',
    config: getActiveDatabaseConfig(),
    probe: {
      status: dbHealth.status,
      source: dbHealth.source,
      latencyMs: dbHealth.latencyMs || 0
    }
  });
});

export default router;
