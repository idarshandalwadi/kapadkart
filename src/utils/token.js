import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';

/**
 * Generate a cryptographically signed HMAC-SHA256 JWT
 * @param {object} payload - Custom claims (sub, role, email, tenant_id, auth_key, etc.)
 * @param {object} options - Options such as expiresIn
 * @returns {string} Signed JWT string
 */
export function generateToken(payload, options = {}) {
  const jti = crypto.randomUUID();
  const expiresIn = options.expiresIn || (payload.role === 'platform_admin' ? env.JWT_ADMIN_EXPIRES_IN : env.JWT_EXPIRES_IN);

  const token = jwt.sign(
    {
      ...payload,
      jti
    },
    env.JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn
    }
  );

  return { token, jti };
}

/**
 * Cryptographically verify an incoming JWT string
 * Enforces algorithm = 'HS256', checks signature and expiration.
 * @param {string} token 
 * @returns {object} Decoded verified payload
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    throw new jwt.JsonWebTokenError('No token provided');
  }

  // Strict verification: only HS256, strictly validating exp and signature
  return jwt.verify(token, env.JWT_SECRET, {
    algorithms: ['HS256']
  });
}

/**
 * Revoke a token server-side (logout or password reset)
 * @param {string} jti - Unique JWT ID
 * @param {string} userId - User or Admin UUID
 * @param {Date|number} expiresAt - Token expiration timestamp
 */
export async function revokeToken(jti, userId, expiresAt) {
  if (!jti) return;
  const expiryDate = expiresAt instanceof Date 
    ? expiresAt 
    : typeof expiresAt === 'number' 
      ? (expiresAt > 1e11 ? new Date(expiresAt) : new Date(expiresAt * 1000)) 
      : new Date(Date.now() + 24 * 60 * 60 * 1000);

  try {
    await prisma.revokedToken.upsert({
      where: { jti },
      update: {},
      create: {
        jti,
        userId,
        expiresAt: expiryDate
      }
    });
  } catch (err) {
    console.warn('[Token] Error recording revoked token:', err.message);
  }
}

/**
 * Check if a token's jti has been revoked
 * @param {string} jti - Unique JWT ID
 * @returns {Promise<boolean>} True if revoked, false otherwise
 */
export async function isTokenRevoked(jti) {
  if (!jti) return false;
  try {
    const count = await prisma.revokedToken.count({
      where: { jti }
    });
    return count > 0;
  } catch (err) {
    console.warn('[Token] Error checking revoked token status:', err.message);
    return false;
  }
}
