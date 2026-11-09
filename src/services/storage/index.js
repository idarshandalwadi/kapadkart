import crypto from 'crypto';
import { env } from '../../config/env.js';
import { LocalStorageProvider } from './localStorage.js';
import { S3StorageProvider } from './s3Storage.js';
import { R2StorageProvider } from './r2Storage.js';
import { imageCompressionService } from '../image/imageCompressionService.js';
import { listAssetRefs, storageKeyFromReference } from './storageKey.js';

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

  storageBucket() {
    return this.provider?.bucket || env.R2_BUCKET_NAME || '';
  }

  /**
   * Safely extract the internal storage key from a full URL, relative path, or direct key.
   * Protects system static assets, default placeholders, and inline base64/blobs.
   * Path-style R2 URLs include the bucket name, which is not part of the object key.
   * @param {string} urlOrKey
   * @returns {string|null} storage key or null if not a manageable/deletable file
   */
  extractKey(urlOrKey) {
    return storageKeyFromReference(urlOrKey, { bucket: this.storageBucket() });
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
   * Delete stored files that were removed from a logo or product image field.
   * Accepts a URL, a JSON array of URLs, or a list of those values.
   * @param {unknown} previousValue
   * @param {unknown} nextValue
   * @returns {Promise<boolean>}
   */
  async deleteRemoved(previousValue, nextValue) {
    const bucket = this.storageBucket();
    const nextKeys = new Set(
      listAssetRefs(nextValue)
        .map((ref) => storageKeyFromReference(ref, { bucket }))
        .filter(Boolean)
    );
    const removedKeys = [...new Set(
      listAssetRefs(previousValue)
        .map((ref) => storageKeyFromReference(ref, { bucket }))
        .filter((key) => key && !nextKeys.has(key))
    )];

    let deleted = false;
    for (const key of removedKeys) {
      try {
        const ok = await this.provider.deleteFile(key);
        deleted = deleted || Boolean(ok);
      } catch (err) {
        console.warn(`[StorageService] Failed to delete removed image ${key}:`, err.message);
      }
    }
    return deleted;
  }

  /**
   * Retrieve full URL for key
   */
  getUrl(key) {
    return this.provider.getUrl(key);
  }
}

export const storageService = new StorageService();
