export const LOCAL_SHOP_APP_URL = 'http://localhost:5173';
export const PRODUCTION_SHOP_APP_URL = 'https://kapadkart.pages.dev';

function hostnameOf(value) {
  const raw = String(value || '').split(',')[0].trim();
  if (!raw) return '';

  try {
    const withProtocol = raw.includes('://') ? raw : `http://${raw}`;
    return new URL(withProtocol).hostname.toLowerCase();
  } catch {
    return raw.replace(/:\d+$/, '').toLowerCase();
  }
}

export function isLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost')
  );
}

/**
 * Public origin of the shop app, used for links inside emails.
 * An explicit SHOP_APP_URL always wins. Otherwise a localhost API request
 * stays on the local shop app, and any public request uses the live site.
 */
export function resolveShopAppUrl({
  nodeEnv = 'development',
  configured = '',
  requestHost = ''
} = {}) {
  const explicit = String(configured || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;

  const hosts = String(requestHost || '')
    .split(',')
    .map((part) => hostnameOf(part))
    .filter(Boolean);
  const hasPublicHost = hosts.some((host) => !isLocalHostname(host));
  const hasLocalHost = hosts.some((host) => isLocalHostname(host));

  if (hasPublicHost) return PRODUCTION_SHOP_APP_URL;
  if (hasLocalHost) return LOCAL_SHOP_APP_URL;
  if (nodeEnv === 'production') return PRODUCTION_SHOP_APP_URL;
  return LOCAL_SHOP_APP_URL;
}

export function shopEmailLinks(base) {
  const origin = String(base || LOCAL_SHOP_APP_URL).replace(/\/+$/, '');
  return {
    loginUrl: `${origin}/login`,
    supportUrl: `${origin}/contact`
  };
}
