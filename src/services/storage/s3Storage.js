import path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export class S3StorageProvider {
  constructor() {
    this.name = 's3';
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.bucket = process.env.S3_BUCKET_NAME || '';
    this.publicUrl = process.env.S3_PUBLIC_URL || '';

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!accessKeyId || !secretAccessKey || !this.bucket) {
      console.warn('[S3Storage] Warning: AWS S3 credentials or S3_BUCKET_NAME missing in environment.');
    }

    this.client = new S3Client({
      region: this.region,
      credentials: accessKeyId && secretAccessKey ? {
        accessKeyId,
        secretAccessKey
      } : undefined
    });
  }

  /**
   * Upload buffer to AWS S3
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
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;

    return {
      provider: 's3',
      key,
      url: fileUrl,
      size: buffer.length,
      mimetype
    };
  }

  /**
   * Delete object from AWS S3
   */
  async deleteFile(key) {
    if (!key) return false;
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      });
      await this.client.send(command);
      return true;
    } catch (err) {
      console.warn('[S3Storage] Delete error:', err.message);
      return false;
    }
  }

  getUrl(key) {
    if (!key) return '';
    if (key.startsWith('http://') || key.startsWith('https://')) return key;
    return this.publicUrl
      ? `${this.publicUrl.replace(/\/+$/, '')}/${key}`
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }
}
