import { logger } from '../utils/logger.js';

export function requestLogger(req, res, next) {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;

    const meta = {
      method: req.method,
      url: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'] || 'unknown'
    };

    if (res.statusCode >= 500) {
      logger.error('Request failed with server error', meta);
    } else if (res.statusCode >= 400) {
      logger.warn('Request completed with client error', meta);
    } else {
      logger.info('Request completed', meta);
    }
  });

  next();
}
