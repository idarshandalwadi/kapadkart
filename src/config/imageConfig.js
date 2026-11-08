import path from 'path';

/**
 * Image processing and compression configuration.
 * Configured via environment variables with production-ready defaults.
 */
export const IMAGE_CONFIG = {
  // Upload limits
  maxUploadSizeBytes: (Number(process.env.IMAGE_MAX_UPLOAD_SIZE_MB) || 10) * 1024 * 1024,
  maxOutputSizeBytes: (Number(process.env.IMAGE_MAX_OUTPUT_SIZE_KB) || 400) * 1024,

  // Dimensions per category
  product: {
    maxWidth: Number(process.env.IMAGE_PRODUCT_MAX_WIDTH) || 1600,
    maxHeight: Number(process.env.IMAGE_PRODUCT_MAX_HEIGHT) || 1600,
  },
  branding: {
    maxWidth: Number(process.env.IMAGE_BRANDING_MAX_WIDTH) || 400,
    maxHeight: Number(process.env.IMAGE_BRANDING_MAX_HEIGHT) || 400,
  },
  defaultDimensions: {
    maxWidth: 1600,
    maxHeight: 1600,
  },

  // Input safety against decompression bombs (pixel bombs)
  maxPixels: Number(process.env.IMAGE_MAX_PIXELS) || 50000000, // 50 MP (supports high-res DSLR up to 45-50 MP)

  // WebP compression
  initialQuality: Number(process.env.IMAGE_WEBP_QUALITY) || 82,
  minQuality: Number(process.env.IMAGE_WEBP_MIN_QUALITY) || 45,
  effort: Number(process.env.IMAGE_WEBP_EFFORT) || 4,

  // Concurrency & Queue (1GB RAM protection)
  concurrency: Number(process.env.IMAGE_PROCESSING_CONCURRENCY) || 2,
  queueCapacity: Number(process.env.IMAGE_QUEUE_CAPACITY) || 100,

  // Temporary storage on disk for multipart uploads
  tempDir: path.resolve(process.cwd(), process.env.IMAGE_TEMP_DIR || './tmp/image-uploads')
};
