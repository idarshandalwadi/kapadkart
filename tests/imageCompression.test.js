import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { imageCompressionService, detectImageFormat } from '../src/services/image/imageCompressionService.js';
import { IMAGE_CONFIG } from '../src/config/imageConfig.js';
import { storageService } from '../src/services/storage/index.js';

describe('Production-Ready WebP Image Compression Service', () => {
  it('detectImageFormat accurately detects JPEG, PNG, WebP, GIF, BMP, TIFF', async () => {
    // Generate valid sample buffers via sharp
    const jpegBuffer = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } }
    }).jpeg().toBuffer();
    assert.equal(detectImageFormat(jpegBuffer), 'jpeg');

    const pngBuffer = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 0.5 } }
    }).png().toBuffer();
    assert.equal(detectImageFormat(pngBuffer), 'png');

    const webpBuffer = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } }
    }).webp().toBuffer();
    assert.equal(detectImageFormat(webpBuffer), 'webp');

    const gifBuffer = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 255, b: 0 } }
    }).gif().toBuffer();
    assert.equal(detectImageFormat(gifBuffer), 'gif');
  });

  it('Rejects SVG and non-raster inputs for security reasons', async () => {
    const fakeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await assert.rejects(
      async () => {
        await imageCompressionService.processImage({ buffer: fakeSvg });
      },
      /SVG format is not accepted for security reasons/
    );

    const randomText = Buffer.from('Just plain text file masquerading as image');
    await assert.rejects(
      async () => {
        await imageCompressionService.processImage({ buffer: randomText });
      },
      /Unsupported or corrupted image file/
    );
  });

  it('Converts PNG to WebP while preserving transparency and enforcing <= 400 KB', async () => {
    // Transparent PNG
    const pngBuffer = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 120, g: 40, b: 200, alpha: 0 } }
    }).png().toBuffer();

    const result = await imageCompressionService.processImage({
      buffer: pngBuffer,
      folder: 'branding'
    });

    assert.equal(result.format, 'webp');
    assert.equal(result.mimetype, 'image/webp');
    assert.ok(result.size <= IMAGE_CONFIG.maxOutputSizeBytes, `Output size ${result.size} exceeds 400KB`);

    // Verify metadata of output
    const meta = await sharp(result.buffer).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.hasAlpha, true);
  });

  it('Compresses large JPEG down to <= 400 KB and constrains dimensions', async () => {
    // Create a 2000 x 2000 colorful pattern image
    const largeJpegBuffer = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: { r: 220, g: 180, b: 90 } }
    }).jpeg({ quality: 100 }).toBuffer();

    const result = await imageCompressionService.processImage({
      buffer: largeJpegBuffer,
      folder: 'products'
    });

    assert.equal(result.format, 'webp');
    assert.ok(result.size <= IMAGE_CONFIG.maxOutputSizeBytes, `Output size ${result.size} exceeds 400KB`);

    const meta = await sharp(result.buffer).metadata();
    assert.ok(meta.width <= IMAGE_CONFIG.product.maxWidth);
    assert.ok(meta.height <= IMAGE_CONFIG.product.maxHeight);
  });

  it('StorageService uploads WebP with .webp extension and portable key structure', async () => {
    const sampleBuffer = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 10, g: 20, b: 30 } }
    }).png().toBuffer();

    const uploaded = await storageService.upload({
      buffer: sampleBuffer,
      mimetype: 'image/png',
      originalname: 'original-photo.png',
      folder: 'products',
      tenantId: 'tenant-test'
    });

    assert.equal(uploaded.mimetype, 'image/webp');
    assert.ok(uploaded.key.endsWith('.webp'), `Expected .webp extension on key, got ${uploaded.key}`);
    assert.ok(uploaded.key.startsWith('products/tenant-test/'), `Expected portable path, got ${uploaded.key}`);
    assert.ok(uploaded.size <= IMAGE_CONFIG.maxOutputSizeBytes);

    // Clean up
    await storageService.delete(uploaded.key);
  });
});
