import { env } from '../config/env.js';

export const AUTH_COOKIE_NAME = 'kapadkart_token';

/**
 * Calculate cookie max-age in milliseconds based on role or env configuration
 * @param {string} role 
 * @returns {number} maxAge in ms
 */
function getCookieMaxAge(role) {
  if (role === 'platform_admin') {
    return 8 * 60 * 60 * 1000; // 8 hours
  }
  return 24 * 60 * 60 * 1000; // 24 hours
}

/**
 * Returns cookie options tailored to current environment
 * @param {number} maxAge - Duration in milliseconds
 * @returns {import('express').CookieOptions}
 */
export function getAuthCookieOptions(maxAge) {
  const isProduction = env.NODE_ENV === 'production';
  const sameSite = env.COOKIE_SAME_SITE || (isProduction ? 'none' : 'lax');
  
  return {
    httpOnly: true,
    secure: isProduction, // HTTPS required in production (mandatory when sameSite is 'none')
    sameSite,             // 'none' for cross-site Cloudflare -> AWS fetch, or 'lax' / configured
    path: '/',            // Accessible across the entire app
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    ...(typeof maxAge === 'number' ? { maxAge } : {})
  };
}

/**
 * Sets the cryptographic authentication JWT in an HttpOnly cookie
 * @param {import('express').Response} res 
 * @param {string} token - Signed JWT
 * @param {string} role - User role ('tenant_user' | 'platform_admin')
 */
export function setAuthCookie(res, token, role = 'tenant_user') {
  const maxAge = getCookieMaxAge(role);
  const options = getAuthCookieOptions(maxAge);
  res.cookie(AUTH_COOKIE_NAME, token, options);
}

/**
 * Clears the authentication cookie from client
 * @param {import('express').Response} res 
 */
export function clearAuthCookie(res) {
  const options = getAuthCookieOptions();
  // Clear primary cookie and any legacy variant
  res.clearCookie(AUTH_COOKIE_NAME, options);
  res.clearCookie('token', options);
}
