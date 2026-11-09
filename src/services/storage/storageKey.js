const PROTECTED_ASSETS = [
  'product-placeholder.webp',
  'kapad-kart-logo.svg',
  'kk-favicon.svg',
  'favicon.svg',
  'favicon.ico',
  'manifest.webmanifest'
];

const MANAGED_FOLDER = /^(products|logos|branding|images|general)$/i;

function decodePath(pathname) {
  return String(pathname || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

/**
 * Path-style API hosts put the bucket name in the first path segment:
 * https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
 * Object keys stored by this app never include the bucket name.
 */
function stripApiBucket(path, bucket) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return path;
  const bucketName = String(bucket || '').trim();
  const firstIsBucket = Boolean(bucketName) && parts[0] === bucketName;
  const firstIsFolder = MANAGED_FOLDER.test(parts[0]);
  const secondIsFolder = MANAGED_FOLDER.test(parts[1]);
  if (firstIsBucket || (!firstIsFolder && secondIsFolder)) {
    return parts.slice(1).join('/');
  }
  return parts.join('/');
}

function isPathStyleApiHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host.endsWith('.r2.cloudflarestorage.com')
    || host === 's3.amazonaws.com'
    || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/i.test(host);
}

/**
 * Collect image references from a plain URL, a JSON array string, or a list of those.
 * @param {unknown} value
 * @returns {string[]}
 */
export function listAssetRefs(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap((item) => listAssetRefs(item));

  const raw = String(value).trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return listAssetRefs(parsed);
    } catch {
      // Keep the raw string when it is not a JSON array.
    }
  }

  return [raw];
}

/**
 * Extract the object key for a storage URL, relative path, or key.
 * Returns null for inline data, blobs, and built-in static assets.
 * @param {string} urlOrKey
 * @param {{ bucket?: string }} [options]
 * @returns {string|null}
 */
export function storageKeyFromReference(urlOrKey, { bucket = '' } = {}) {
  if (!urlOrKey || typeof urlOrKey !== 'string') return null;
  const str = urlOrKey.trim();
  if (!str) return null;
  if (/^(data:|blob:)/i.test(str)) return null;

  for (const asset of PROTECTED_ASSETS) {
    if (str.includes(asset)) return null;
  }

  if (/^https?:\/\//i.test(str)) {
    try {
      const parsed = new URL(str);
      let cleanPath = decodePath(parsed.pathname);
      const uploadIdx = cleanPath.indexOf('uploads/');
      if (uploadIdx !== -1) {
        cleanPath = cleanPath.slice(uploadIdx + 'uploads/'.length);
      } else if (isPathStyleApiHost(parsed.hostname)) {
        cleanPath = stripApiBucket(cleanPath, bucket);
      }
      return cleanPath || null;
    } catch {
      return null;
    }
  }

  let cleanRelative = decodePath(str);
  if (cleanRelative.startsWith('uploads/')) {
    cleanRelative = cleanRelative.slice('uploads/'.length);
  }
  return cleanRelative || null;
}
