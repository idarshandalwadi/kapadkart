import jwt from 'jsonwebtoken';
import { verifyToken, isTokenRevoked } from '../utils/token.js';
import { AUTH_COOKIE_NAME } from '../utils/cookie.js';
import { prisma } from '../config/prisma.js';

/**
 * Base Authentication Middleware
 * Validates cryptographically signed JWT, algorithm ('HS256'), expiration, and server-side revocation.
 * Supports HttpOnly authentication cookies with backward-compatible Authorization header fallback.
 */
export async function authenticateToken(req, res, next) {
  try {
    // Check HttpOnly cookie first, then fallback to Authorization header
    let token = req.cookies?.[AUTH_COOKIE_NAME] || req.cookies?.token;

    if (!token && req.headers.authorization) {
      token = req.headers.authorization.replace(/^Bearer\s+/i, '').trim();
    }

    if (!token) {
      return res.status(401).json({
        status: 'error',
        message: 'No authorization token provided'
      });
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch (jwtErr) {
      if (jwtErr instanceof jwt.TokenExpiredError) {
        return res.status(401).json({
          status: 'error',
          code: 'TOKEN_EXPIRED',
          message: 'Authentication token has expired. Please sign in again.'
        });
      }
      return res.status(401).json({
        status: 'error',
        code: 'TOKEN_INVALID',
        message: 'Invalid or forged authentication token'
      });
    }

    // Check server-side revocation list
    const revoked = await isTokenRevoked(payload.jti);
    if (revoked) {
      return res.status(401).json({
        status: 'error',
        code: 'TOKEN_REVOKED',
        message: 'Session has been revoked or signed out. Please sign in again.'
      });
    }

    // Attach verified user context to request
    req.user = payload;
    req.token = token;
    req.jti = payload.jti;
    req.userId = payload.sub;
    req.role = payload.role;
    req.authKey = payload.auth_key;
    req.tenantId = payload.tenant_id;
    req.tenantSlug = payload.tenant_slug;
    req.isAdmin = payload.role === 'platform_admin';

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Platform Admin Authorization Middleware
 * Enforces authenticated user has role = 'platform_admin'
 */
export async function requireAdmin(req, res, next) {
  if (req.path.endsWith('/health') || req.path === '/health') {
    return next();
  }

  await authenticateToken(req, res, async () => {
    if (req.user?.role !== 'platform_admin') {
      return res.status(403).json({
        status: 'error',
        message: 'Access denied. Platform Administrator privilege required.'
      });
    }

    // Verify admin existence in database
    const admin = await prisma.platformAdmin.findUnique({
      where: { id: req.user.sub },
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        authKey: true
      }
    });

    if (!admin) {
      return res.status(401).json({
        status: 'error',
        message: 'Admin account not found or removed'
      });
    }

    req.admin = {
      id: admin.id,
      username: admin.username,
      email: admin.email,
      full_name: admin.fullName,
      auth_key: admin.authKey
    };
    next();
  });
}

/**
 * Tenant User Authorization Middleware
 * Enforces role = 'tenant_user', verifies active tenant boundary, and protects against cross-tenant isolation bypass.
 */
export async function requireTenant(req, res, next) {
  await authenticateToken(req, res, async () => {
    if (req.user?.role !== 'tenant_user') {
      return res.status(403).json({
        status: 'error',
        message: 'Access denied. Tenant authorization required.'
      });
    }

    // Tenant boundary check: if X-Tenant-Slug header or route :slug is present, verify match
    const headerSlug = req.headers['x-tenant-slug'];
    const paramSlug = req.params?.slug;
    const expectedSlug = paramSlug || headerSlug;

    if (expectedSlug && expectedSlug.toLowerCase() !== req.user.tenant_slug.toLowerCase()) {
      return res.status(403).json({
        status: 'error',
        message: 'Access denied. Tenant boundary mismatch.'
      });
    }

    // Verify user and tenant existence and status in database
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      include: {
        tenant: true
      }
    });

    if (!user || !user.tenant) {
      return res.status(401).json({
        status: 'error',
        message: 'Tenant user account not found or deactivated'
      });
    }

    if (user.tenant.status !== 'active') {
      return res.status(403).json({
        status: 'error',
        message: 'Tenant shop account is currently suspended or deleted'
      });
    }

    const userData = {
      id: user.id,
      email: user.email,
      full_name: user.fullName,
      auth_key: user.authKey,
      tenant_id: user.tenant.id,
      tenant_slug: user.tenant.slug,
      tenant_name: user.tenant.name,
      business_type: user.tenant.businessType,
      businessType: user.tenant.businessType,
      tenant_status: user.tenant.status,
      maxProducts: user.tenant.maxProducts,
      maxBookings: user.tenant.maxBookings,
      maxSales: user.tenant.maxSales,
      max_products: user.tenant.maxProducts,
      max_bookings: user.tenant.maxBookings,
      max_sales: user.tenant.maxSales
    };

    req.tenantUser = userData;
    req.tenant = user.tenant;
    req.tenantId = userData.tenant_id;
    req.tenantSlug = userData.tenant_slug;
    req.authKey = userData.auth_key;

    next();
  });
}
