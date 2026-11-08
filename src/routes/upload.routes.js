import { Router } from 'express';
import { uploadSingleImage, uploadDualProductImages } from '../middleware/upload.middleware.js';
import { storageService } from '../services/storage/index.js';
import { verifyToken, isTokenRevoked } from '../utils/token.js';

const router = Router();

/**
 * Tenant or Admin Auth context resolver for file uploads
 */
async function resolveUploadContext(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (token) {
      let payload;
      try {
        payload = verifyToken(token);
      } catch (err) {
        return res.status(401).json({
          status: 'error',
          message: 'Invalid or expired upload authorization token'
        });
      }

      const revoked = await isTokenRevoked(payload.jti);
      if (revoked) {
        return res.status(401).json({
          status: 'error',
          message: 'Revoked authorization token'
        });
      }

      req.user = payload;
      req.authKey = payload.auth_key;
      req.tenantId = payload.tenant_id;
      req.tenantSlug = payload.tenant_slug;
      req.isAdmin = payload.role === 'platform_admin';
    }

    if (!req.authKey) {
      req.authKey = req.body?.authKey || req.query?.authKey || req.body?.tenantId || req.query?.tenantId || 'common';
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Handle single image upload (used for /image and /:category)
 */
async function handleSingleUpload(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No image file uploaded' });
    }

    const folder = req.params.category || req.body.folder || req.query.folder || 'images';
    const authKey = req.authKey || 'common';

    const result = await storageService.upload({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
      folder,
      authKey
    });

    res.status(200).json({
      status: 'success',
      data: result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/upload/image
 * Generic single image upload (for logos, banners, etc.)
 */
router.post('/image', resolveUploadContext, uploadSingleImage, handleSingleUpload);

/**
 * POST /api/v1/upload/product-images
 * Upload 2 images per product (primary and secondary)
 */
router.post('/product-images', resolveUploadContext, uploadDualProductImages, async (req, res, next) => {
  try {
    const files = req.files || {};
    const authKey = req.authKey || 'common';
    const folder = 'products';

    const response = {
      image: null,
      image2: null
    };

    if (files.image && files.image[0]) {
      const primaryFile = files.image[0];
      response.image = await storageService.upload({
        buffer: primaryFile.buffer,
        mimetype: primaryFile.mimetype,
        originalname: primaryFile.originalname,
        folder,
        authKey
      });
    }

    if (files.image2 && files.image2[0]) {
      const secondaryFile = files.image2[0];
      response.image2 = await storageService.upload({
        buffer: secondaryFile.buffer,
        mimetype: secondaryFile.mimetype,
        originalname: secondaryFile.originalname,
        folder,
        authKey
      });
    }

    if (!response.image && !response.image2) {
      return res.status(400).json({ status: 'error', message: 'At least one product image must be uploaded' });
    }

    res.status(200).json({
      status: 'success',
      data: response
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/upload/:category
 * Support categories like /branding, /products, /templates
 */
router.post('/:category', resolveUploadContext, uploadSingleImage, handleSingleUpload);

export default router;
    