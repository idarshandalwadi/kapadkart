import crypto from 'crypto';
import { env } from '../../config/env.js';
import { LocalStorageProvider } from './localStorage.js';
import { S3StorageProvider } from './s3Storage.js';
import { R2StorageProvider } from './r2Storage.js';
import { imageCompressionService } from '../image/imageCompressionService.js';

export const MIME_MAP = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif'
};

export const ALLOWED_MIME_TYPES = Object.keys(MIME_MAP);

class StorageService {
  constructor() {
    this.providerName = (env.STORAGE_PROVIDER || 'local').toLowerCase().trim();
    this.provider = this.resolveProvider(this.providerName);
    console.log(`[StorageService] Initialized with active provider: ${this.providerName.toUpperCase()}`);
  }

  resolveProvider(name) {
    switch (name) {
      case 's3':
        return new S3StorageProvider();
      case 'r2':
        return new R2StorageProvider();
      case 'local':
      default:
        return new LocalStorageProvider();
    }
  }

  getActiveProviderName() {
    return this.providerName;
  }

  /**
   * Upload an image buffer with WebP compression, size cap (<=400KB), and security validation
   */
  async upload({ buffer, mimetype, originalname = 'upload', folder = 'general', authKey, tenantId }) {
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty file buffer provided');
    }

    const normalizedMime = mimetype ? mimetype.toLowerCase() : '';
    if (normalizedMime && !ALLOWED_MIME_TYPES.includes(normalizedMime)) {
      throw new Error(`Invalid file type "${mimetype}". Allowed types: JPEG, PNG, WEBP, GIF, BMP, TIFF, AVIF, HEIC`);
    }

    // 1. Process and convert image to WebP (<= 400 KB) with safe fallback
    const processed = await imageCompressionService.processImage({
      buffer,
      folder,
      originalname
    });

    const finalBuffer = processed.buffer;
    const finalMime = processed.mimetype;
    const finalExt = processed.extension || '.webp';

    // 2. Generate secure UUID filename preserving structured portable hierarchy
    const secureFileName = `${crypto.randomUUID()}${finalExt}`;
    const resolvedAuthKey = authKey || tenantId || 'common';

    // 3. Delegate to active storage provider (Local, S3, or R2)
    const stored = await this.provider.uploadFile({
      buffer: finalBuffer,
      fileName: secureFileName,
      folder,
      authKey: resolvedAuthKey,
      tenantId: resolvedAuthKey,
      mimetype: finalMime
    });

    return {
      ...stored,
      originalSize: processed.originalSize || buffer.length,
      compressed: processed.wasCompressed !== false
    };
  }

  /**
   * Safely extract the internal storage key from a full URL, relative path, or direct key.
   * Protects system static assets, default placeholders, and inline base64/blobs.
   * @param {string} urlOrKey
   * @returns {string|null} storage key or null if not a manageable/deletable file
   */
  extractKey(urlOrKey) {
    if (!urlOrKey || typeof urlOrKey !== 'string') return null;
    const str = urlOrKey.trim();
    if (!str) return null;

    // Guard: Never delete inline base64 or blob data
    if (/^(data:|blob:)/i.test(str)) return null;

    // Guard: Never delete system default assets, placeholders, or root branding
    const protectedAssets = [
      'product-placeholder.webp',
      'kapad-kart-logo.svg',
      'kk-favicon.svg',
      'favicon.svg',
      'favicon.ico',
      'manifest.webmanifest'
    ];
    for (const asset of protectedAssets) {
      if (str.includes(asset)) return null;
    }

    // Pattern 1: URL or path containing '/uploads/' (Local storage provider)
    const uploadsMatch = str.match(/\/uploads\/(.+)$/);
    if (uploadsMatch) {
      return uploadsMatch[1].replace(/^\/+/, '');
    }

    // Pattern 2: Full HTTP/HTTPS URL (AWS S3, Cloudflare R2, CDN)
    if (/^https?:\/\//i.test(str)) {
      try {
        const parsed = new URL(str);
        const cleanPath = parsed.pathname.replace(/^\/+/, '');
        // Match known storage folders
        if (/^(products|logos|branding|images|general)\//i.test(cleanPath)) {
          return cleanPath;
        }
        return cleanPath || null;
      } catch {
        return null;
      }
    }

    // Pattern 3: Relative path (e.g. products/usr_123/uuid.webp or /products/...)
    const cleanRelative = str.replace(/^\/?(uploads\/)?/, '');
    if (cleanRelative && /^(products|logos|branding|images|general)\//i.test(cleanRelative)) {
      return cleanRelative;
    }

    return cleanRelative || null;
  }

  /**
   * Delete an image from active storage (Local disk, S3, or R2).
   * Accepts either a storage key or a full public URL.
   * @param {string} keyOrUrl
   * @returns {Promise<boolean>}
   */
  async delete(keyOrUrl) {
    const key = this.extractKey(keyOrUrl);
    if (!key) return false;
    return await this.provider.deleteFile(key);
  }

  /**
   * Retrieve full URL for key
   */
  getUrl(key) {
    return this.provider.getUrl(key);
  }
}

export const storageService = new StorageService();
