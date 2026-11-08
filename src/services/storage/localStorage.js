import fs from 'fs';
import path from 'path';

export class LocalStorageProvider {
  constructor() {
    this.name = 'local';
    this.uploadDir = path.resolve(process.cwd(), process.env.LOCAL_UPLOAD_DIR || 'uploads');
    this.baseUrl = (process.env.BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
  }

  /**
   * Upload / write buffer to local disk
   */
  async uploadFile({ buffer, fileName, folder = 'general', authKey, tenantId, mimetype }) {
    // Sanitize path components to prevent path traversal
    const safeFolder = (folder || 'general').toString().replace(/[^a-zA-Z0-9_-]/g, '') || 'general';
    const safeAuthKey = (authKey || tenantId || 'common').toString().replace(/[^a-zA-Z0-9_-]/g, '') || 'common';
    const safeFileName = path.basename(fileName);

    const targetDir = path.join(this.uploadDir, safeFolder, safeAuthKey);
    await fs.promises.mkdir(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, safeFileName);
    await fs.promises.writeFile(targetPath, buffer);

    const relativeKey = `${safeFolder}/${safeAuthKey}/${safeFileName}`;
    const publicUrl = `${this.baseUrl}/uploads/${relativeKey}`;

    return {
      provider: 'local',
      key: relativeKey,
      url: publicUrl,
      size: buffer.length,
      mimetype
    };
  }

  /**
   * Delete file from local disk
   */
  async deleteFile(key) {
    if (!key) return false;
    const safeKey = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(this.uploadDir, safeKey);

    // Guard against path traversal outside uploadDir
    if (!filePath.startsWith(this.uploadDir)) {
      throw new Error('Access denied: invalid file key path');
    }

    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[LocalStorage] Delete error:', err.message);
      return false;
    }
  }

  /**
   * Resolve public URL from storage key
   */
  getUrl(key) {
    if (!key) return '';
    if (key.startsWith('http://') || key.startsWith('https://')) return key;
    const safeKey = key.replace(/^\/+/, '');
    return `${this.baseUrl}/uploads/${safeKey}`;
  }
}
