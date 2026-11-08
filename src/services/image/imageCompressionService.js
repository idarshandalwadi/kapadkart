import sharp from 'sharp';
import { IMAGE_CONFIG } from '../../config/imageConfig.js';
import { imageProcessingQueue } from './imageProcessingQueue.js';

// Protect 1 GB server RAM by turning off libvips global tile caching and setting single-threaded per task
sharp.cache(false);
sharp.concurrency(1);

/**
 * Sniff file buffer magic bytes to verify legitimate raster image format.
 * Returns the detected format string or null.
 */
export function detectImageFormat(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // JPEG / JPG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }

  // WebP: RIFF .... WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp';
  }

  // GIF: GIF87a or GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return 'gif';
  }

  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'bmp';
  }

  // TIFF: II (49 49 2A 00) or MM (4D 4D 00 2A)
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  ) {
    return 'tiff';
  }

  // AVIF / HEIC / HEIF: ....ftyp (offset 4 is 0x66 0x74 0x79 0x70)
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (brand.includes('avif') || brand.includes('avis')) return 'avif';
    if (brand.includes('heic') || brand.includes('heix') || brand.includes('mif1')) return 'heic';
    return 'heif';
  }

  return null;
}

export class ImageCompressionService {
  /**
   * Resolve maximum allowable dimensions based on folder/category.
   */
  resolveDimensions(folder = 'general') {
    const lower = String(folder || '').toLowerCase();
    if (lower === 'branding' || lower === 'logo' || lower === 'logos') {
      return IMAGE_CONFIG.branding;
    }
    if (lower === 'products' || lower === 'product') {
      return IMAGE_CONFIG.product;
    }
    return IMAGE_CONFIG.defaultDimensions;
  }

  /**
   * Process and convert image to WebP (<= 400 KB).
   * Safe fallback: In case of non-fatal Sharp processing anomaly, returns original buffer.
   */
  async processImage({ buffer, folder = 'general', originalname = 'image' }) {
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty image buffer provided');
    }

    // 1. Verify content magic bytes (Strictly reject SVGs or arbitrary executables)
    const detectedFormat = detectImageFormat(buffer);
    if (!detectedFormat) {
      // Check if it's an SVG (reject with clear security message)
      const head = buffer.subarray(0, 100).toString('utf8').trim().toLowerCase();
      if (head.includes('<svg') || head.includes('<?xml')) {
        throw new Error('SVG format is not accepted for security reasons. Please upload a raster image (JPEG, PNG, WebP).');
      }
      throw new Error('Unsupported or corrupted image file. Valid formats: JPEG, PNG, WebP, GIF, BMP, TIFF, AVIF, HEIC.');
    }

    // 2. Queue execution to protect 1 GB server RAM
    return await imageProcessingQueue.enqueue(async () => {
      try {
        const startTime = Date.now();
        const originalSize = buffer.length;

        // Animated GIF Policy: extract first frame (page: 0) to convert into static high-quality WebP
        const sharpOptions = {
          limitInputPixels: IMAGE_CONFIG.maxPixels,
          page: 0
        };

        const imageInstance = sharp(buffer, sharpOptions);
        const metadata = await imageInstance.metadata();

        if (!metadata.width || !metadata.height) {
          throw new Error('Failed to read image dimensions');
        }

        const { maxWidth, maxHeight } = this.resolveDimensions(folder);

        // Normalize EXIF orientation (rotate without args) and preserve alpha transparency
        let pipeline = imageInstance.rotate();

        // Check if downscale is needed
        let targetWidth = metadata.width;
        let targetHeight = metadata.height;

        if (targetWidth > maxWidth || targetHeight > maxHeight) {
          pipeline = pipeline.resize({
            width: maxWidth,
            height: maxHeight,
            fit: 'inside',
            withoutEnlargement: true
          });
        }

        // Progressive compression loop targeting <= 400 KB
        let currentQuality = IMAGE_CONFIG.initialQuality;
        let outputBuffer = null;
        const qualitySteps = [
          IMAGE_CONFIG.initialQuality, // 82
          72,
          62,
          52,
          IMAGE_CONFIG.minQuality     // 45
        ];

        for (const q of qualitySteps) {
          currentQuality = q;
          outputBuffer = await pipeline
            .clone()
            .webp({
              quality: currentQuality,
              effort: IMAGE_CONFIG.effort,
              alphaQuality: 85
            })
            .toBuffer();

          if (outputBuffer.length <= IMAGE_CONFIG.maxOutputSizeBytes) {
            break;
          }
        }

        // If still > 400 KB after lowest quality (45), progressively downscale dimensions slightly
        if (outputBuffer && outputBuffer.length > IMAGE_CONFIG.maxOutputSizeBytes) {
          const downscaleRatios = [0.85, 0.70, 0.55];
          for (const ratio of downscaleRatios) {
            const nextWidth = Math.round(maxWidth * ratio);
            const nextHeight = Math.round(maxHeight * ratio);

            outputBuffer = await sharp(buffer, sharpOptions)
              .rotate()
              .resize({
                width: nextWidth,
                height: nextHeight,
                fit: 'inside',
                withoutEnlargement: true
              })
              .webp({
                quality: 65,
                effort: IMAGE_CONFIG.effort,
                alphaQuality: 80
              })
              .toBuffer();

            if (outputBuffer.length <= IMAGE_CONFIG.maxOutputSizeBytes) {
              break;
            }
          }
        }

        // Verify final output
        if (!outputBuffer || outputBuffer.length > IMAGE_CONFIG.maxOutputSizeBytes) {
          throw new Error(
            `Unable to compress image below ${Math.round(IMAGE_CONFIG.maxOutputSizeBytes / 1024)} KB without extreme quality loss.`
          );
        }

        const durationMs = Date.now() - startTime;
        return {
          buffer: outputBuffer,
          format: 'webp',
          mimetype: 'image/webp',
          extension: '.webp',
          size: outputBuffer.length,
          originalSize,
          durationMs,
          wasCompressed: true
        };
      } catch (err) {
        // Safe Fallback: if compression failed, but original image is under 400 KB, safely store original
        if (buffer.length <= IMAGE_CONFIG.maxOutputSizeBytes) {
          console.warn(`[ImageCompressionService] WebP conversion fallback triggered: ${err.message}. Retaining original buffer.`);
          return {
            buffer,
            format: detectedFormat,
            mimetype: `image/${detectedFormat === 'jpg' ? 'jpeg' : detectedFormat}`,
            extension: `.${detectedFormat}`,
            size: buffer.length,
            originalSize: buffer.length,
            durationMs: 0,
            wasCompressed: false
          };
        }

        throw err;
      }
    });
  }
}

export const imageCompressionService = new ImageCompressionService();
