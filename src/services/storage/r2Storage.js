import path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';

export class R2StorageProvider {
  constructor() {
    this.name = 'r2';
    this.accountId = env.R2_ACCOUNT_ID || '';
    this.bucket = env.R2_BUCKET_NAME || '';
    this.publicUrl = env.R2_PUBLIC_URL || '';

    const accessKeyId = env.R2_ACCESS_KEY_ID;
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY;

    if (!this.accountId || !accessKeyId || !secretAccessKey || !this.bucket) {
      console.warn('[R2Storage] Warning: Cloudflare R2 credentials, R2_ACCOUNT_ID, or R2_BUCKET_NAME missing in environment.');
    }

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
      credentials: accessKeyId && secretAccessKey ? {
        accessKeyId,
        secretAccessKey
      } : undefined
    });
  }

  /**
   * Upload buffer to Cloudflare R2
   */
  async uploadFile({ buffer, fileName, folder = 'general', authKey, tenantId, mimetype }) {
    const safeFolder = (folder || 'general').toString().replace(/[^a-zA-Z0-9_-]/g, '') || 'general';
    const safeAuthKey = (authKey || tenantId || 'common').toString().replace(/[^a-zA-Z0-9_-]/g, '') || 'common';
    const safeFileName = path.basename(fileName);
    const key = `${safeFolder}/${safeAuthKey}/${safeFileName}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimetype
    });

    await this.client.send(command);

    const fileUrl = this.publicUrl
      ? `${this.publicUrl.replace(/\/+$/, '')}/${key}`
      : `https://${this.bucket}.${this.accountId}.r2.cloudflarestorage.com/${key}`;

    return {
      provider: 'r2',
      key,
      url: fileUrl,
      size: buffer.length,
      mimetype
    };
  }

  /**
   * Object keys do not include the bucket. Path-style URLs sometimes do.
   */
  objectKey(key) {
    let value = String(key || '').trim().replace(/^\/+/, '');
    if (this.bucket && value.startsWith(`${this.bucket}/`)) {
      value = value.slice(this.bucket.length + 1);
    }
    return value;
  }

  async deleteFile(key) {
    const objectKey = this.objectKey(key);
    if (!objectKey) return false;
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey
      });
      await this.client.send(command);
      return true;
    } catch (err) {
      console.warn('[R2Storage] Delete error:', err.message);
      return false;
    }
  }

  getUrl(key) {
    if (!key) return '';
    if (key.startsWith('http://') || key.startsWith('https://')) return key;
    return this.publicUrl
      ? `${this.publicUrl.replace(/\/+$/, '')}/${key}`
      : `https://${this.bucket}.${this.accountId}.r2.cloudflarestorage.com/${key}`;
  }
}
