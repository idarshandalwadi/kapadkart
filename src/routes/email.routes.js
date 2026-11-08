import { Router } from 'express';
import nodemailer from 'nodemailer';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { requireAdmin } from '../middleware/authMiddleware.js';

const router = Router();

router.use(requireAdmin);

function formatEmailLog(log) {
  if (!log) return null;
  return {
    id: log.id,
    provider: log.provider,
    from_address: log.fromAddress,
    to_address: log.toAddress,
    subject: log.subject,
    template_name: log.templateName,
    status: log.status,
    message_id: log.messageId,
    error_message: log.errorMessage,
    metadata: log.metadata,
    sent_at: log.sentAt,
    created_at: log.createdAt,
    tenant_name: log.tenant?.name || null,
    tenant_slug: log.tenant?.slug || null,
    tenant: log.tenant ? { name: log.tenant.name, slug: log.tenant.slug } : null
  };
}

/**
 * GET /logs
 * Retrieve paginated and filtered email audit records
 */
router.get('/logs', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 15));
    const offset = (page - 1) * limit;

    const { status, search, templateName, tenantId, fromDate, toDate } = req.query;

    const where = {};

    if (status && status !== 'all') {
      where.status = status;
    }

    if (templateName && templateName !== 'all') {
      where.templateName = templateName;
    }

    if (tenantId) {
      where.tenantId = tenantId;
    }

    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) where.createdAt.gte = new Date(fromDate);
      if (toDate) where.createdAt.lte = new Date(toDate);
    }

    if (search && search.trim()) {
      const term = search.trim();
      where.OR = [
        { toAddress: { contains: term, mode: 'insensitive' } },
        { subject: { contains: term, mode: 'insensitive' } },
        { tenant: { name: { contains: term, mode: 'insensitive' } } }
      ];
    }

    const [total, logs] = await Promise.all([
      prisma.emailLog.count({ where }),
      prisma.emailLog.findMany({
        where,
        include: {
          tenant: {
            select: { name: true, slug: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit
      })
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.status(200).json({
      status: 'success',
      data: {
        items: logs.map(formatEmailLog),
        total,
        page,
        limit,
        totalPages
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /logs/:id
 * Retrieve single email audit record
 */
router.get('/logs/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const log = await prisma.emailLog.findUnique({
      where: { id },
      include: {
        tenant: {
          select: { name: true, slug: true }
        }
      }
    });

    if (!log) {
      return res.status(404).json({ status: 'error', message: 'Email log not found' });
    }

    res.status(200).json({
      status: 'success',
      data: formatEmailLog(log)
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /stats
 * Aggregate email statistics
 */
router.get('/stats', async (req, res, next) => {
  try {
    const { tenantId, fromDate } = req.query;
    const whereClause = {};

    if (tenantId) {
      whereClause.tenantId = tenantId;
    }
    if (fromDate) {
      whereClause.createdAt = { gte: new Date(fromDate) };
    }

    const [total, sent, failed, pending, simulated] = await Promise.all([
      prisma.emailLog.count({ where: whereClause }),
      prisma.emailLog.count({ where: { ...whereClause, status: 'sent' } }),
      prisma.emailLog.count({ where: { ...whereClause, status: 'failed' } }),
      prisma.emailLog.count({ where: { ...whereClause, status: 'pending' } }),
      prisma.emailLog.count({ where: { ...whereClause, status: 'simulated' } })
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        total,
        sent,
        failed,
        pending,
        simulated
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /provider
 * Current active email transport metadata
 */
router.get('/provider', (req, res) => {
  const isConfigured = Boolean(env.SMTP_USER && env.SMTP_PASS);
  res.status(200).json({
    status: 'success',
    data: {
      provider: 'smtp',
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER ? env.SMTP_USER.replace(/(?<=.{3}).(?=.*@)/g, '*') : '(not configured)',
      from: env.SMTP_FROM,
      configured: isConfigured,
      mode: isConfigured ? 'live_smtp' : 'simulation'
    }
  });
});

/**
 * POST /test-connection
 * Validates SMTP transport credentials
 */
router.post('/test-connection', async (req, res) => {
  const customConfig = req.body?.smtpConfig;
  const host = customConfig?.host || env.SMTP_HOST;
  const port = customConfig?.port || env.SMTP_PORT;
  const secure = customConfig?.secure ?? env.SMTP_SECURE;
  const user = customConfig?.user || env.SMTP_USER;
  const pass = customConfig?.pass || env.SMTP_PASS;

  if (!user || !pass) {
    return res.status(400).json({
      status: 'error',
      message: 'SMTP credentials (user & password) are not configured. Please supply them in .env or settings.'
    });
  }

  try {
    const testTransporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass }
    });

    await testTransporter.verify();
    return res.status(200).json({
      status: 'success',
      message: `SMTP connection to ${host}:${port} verified successfully!`
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: `SMTP verification failed: ${err.message}`
    });
  }
});

export default router;
