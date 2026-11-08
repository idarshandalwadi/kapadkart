import { prisma } from '../../config/prisma.js';

/**
 * Lightweight User-Agent parser to extract browser, OS, and device information
 * without heavy external dependencies.
 */
export function parseUserAgent(ua = '') {
  if (!ua) {
    return {
      browserName: null,
      browserVersion: null,
      osName: null,
      osVersion: null,
      deviceType: 'desktop',
      deviceName: null
    };
  }

  let browserName = 'Other';
  let browserVersion = null;
  let osName = 'Other';
  let osVersion = null;
  let deviceType = 'desktop';
  let deviceName = null;

  // OS Detection
  if (/windows phone/i.test(ua)) {
    osName = 'Windows Phone';
    deviceType = 'mobile';
  } else if (/win(dows)?/i.test(ua)) {
    osName = 'Windows';
    const match = ua.match(/Windows NT ([\d.]+)/i);
    if (match) {
      const v = match[1];
      if (v === '10.0') osVersion = '10/11';
      else if (v === '6.3') osVersion = '8.1';
      else if (v === '6.2') osVersion = '8';
      else if (v === '6.1') osVersion = '7';
      else osVersion = v;
    }
  } else if (/ipad/i.test(ua)) {
    osName = 'iOS';
    deviceType = 'tablet';
    deviceName = 'iPad';
    const match = ua.match(/OS ([\d_]+)/i);
    if (match) osVersion = match[1].replace(/_/g, '.');
  } else if (/iphone/i.test(ua)) {
    osName = 'iOS';
    deviceType = 'mobile';
    deviceName = 'iPhone';
    const match = ua.match(/OS ([\d_]+)/i);
    if (match) osVersion = match[1].replace(/_/g, '.');
  } else if (/android/i.test(ua)) {
    osName = 'Android';
    deviceType = /mobile/i.test(ua) ? 'mobile' : 'tablet';
    const match = ua.match(/Android ([\d.]+)/i);
    if (match) osVersion = match[1];
  } else if (/mac(intosh| os x)/i.test(ua)) {
    osName = 'macOS';
    const match = ua.match(/Mac OS X ([\d_]+)/i);
    if (match) osVersion = match[1].replace(/_/g, '.');
  } else if (/linux/i.test(ua)) {
    osName = 'Linux';
  }

  // Browser Detection
  if (/edg/i.test(ua)) {
    browserName = 'Edge';
    const match = ua.match(/Edg\/([\d.]+)/i);
    if (match) browserVersion = match[1];
  } else if (/opr|opera/i.test(ua)) {
    browserName = 'Opera';
    const match = ua.match(/(?:OPR|Opera)\/([\d.]+)/i);
    if (match) browserVersion = match[1];
  } else if (/chrome|crios/i.test(ua)) {
    browserName = 'Chrome';
    const match = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/i);
    if (match) browserVersion = match[1];
  } else if (/firefox|fxios/i.test(ua)) {
    browserName = 'Firefox';
    const match = ua.match(/(?:Firefox|FxiOS)\/([\d.]+)/i);
    if (match) browserVersion = match[1];
  } else if (/safari/i.test(ua) && !/chrome/i.test(ua)) {
    browserName = 'Safari';
    const match = ua.match(/Version\/([\d.]+)/i);
    if (match) browserVersion = match[1];
  } else if (/node/i.test(ua)) {
    browserName = 'Node.js Test';
  }

  return { browserName, browserVersion, osName, osVersion, deviceType, deviceName };
}

/**
 * Record an activity log entry safely and asynchronously.
 */
export async function recordActivity({
  tenantId,
  userId = null,
  userEmail = null,
  userName = null,
  action,
  entityType,
  entityId = null,
  summary,
  changes = null,
  metadata = null,
  req = null
}) {
  if (!tenantId) return null;

  try {
    const ua = req?.headers?.['user-agent'] || '';
    const ip = req?.ip || req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || null;
    const { browserName, browserVersion, osName, osVersion, deviceType, deviceName } = parseUserAgent(ua);

    const log = await prisma.activityLog.create({
      data: {
        tenantId,
        userId: userId || req?.tenantUser?.id || req?.userId || null,
        userEmail: userEmail || req?.tenantUser?.email || req?.user?.email || null,
        userName: userName || req?.tenantUser?.full_name || req?.user?.fullName || null,
        action,
        entityType,
        entityId: entityId ? String(entityId) : null,
        summary: String(summary || ''),
        changes: changes ? JSON.parse(JSON.stringify(changes)) : undefined,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
        ipAddress: ip,
        userAgent: ua ? ua.slice(0, 1000) : null,
        browserName,
        browserVersion,
        osName,
        osVersion,
        deviceType,
        deviceName,
        requestId: req?.headers?.['x-request-id'] || null,
        requestMethod: req?.method || null,
        requestPath: req?.originalUrl || req?.url || null
      }
    });

    return log;
  } catch (err) {
    // Audit logging should never fail the user request
    console.error('[ActivityLogger] Error recording activity:', err.message);
    return null;
  }
}

/**
 * Format an ActivityLog database record for frontend API consumption.
 */
export function formatActivityLog(log) {
  if (!log) return null;
  return {
    id: log.id,
    created_at: log.createdAt,
    user_id: log.userId,
    user_email: log.userEmail,
    user_name: log.userName,
    action: log.action,
    entity_type: log.entityType,
    entity_id: log.entityId,
    summary: log.summary,
    changes: log.changes,
    metadata: log.metadata,
    ip_address: log.ipAddress,
    user_agent: log.userAgent,
    browser_name: log.browserName,
    browser_version: log.browserVersion,
    os_name: log.osName,
    os_version: log.osVersion,
    device_type: log.deviceType,
    device_name: log.deviceName,
    request_id: log.requestId,
    request_method: log.requestMethod,
    request_path: log.requestPath
  };
}
