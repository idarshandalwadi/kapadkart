import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { ALLOWED_MIME_TYPES } from '../services/storage/index.js';
import { IMAGE_CONFIG } from '../config/imageConfig.js';

// Ensure temp directory exists
if (!fs.existsSync(IMAGE_CONFIG.tempDir)) {
  fs.mkdirSync(IMAGE_CONFIG.tempDir, { recursive: true });
}

// Disk-backed temporary storage for uploaded files to conserve RAM
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, IMAGE_CONFIG.tempDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || '';
    cb(null, `upload-${uniqueSuffix}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  const mime = file.mimetype.toLowerCase();
  if (ALLOWED_MIME_TYPES.includes(mime)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type "${file.mimetype}". Supported formats: JPEG, PNG, WEBP, GIF, BMP, TIFF, AVIF, HEIC.`));
  }
}

// Configurable upload size limit (default 10 MB)
const limits = {
  fileSize: IMAGE_CONFIG.maxUploadSizeBytes
};

export const upload = multer({
  storage,
  limits,
  fileFilter
});

/**
 * Helper to wrap multer middleware and read disk files into memory buffer
 * while guaranteeing temporary file deletion upon request completion or abort.
 */
function createUploadHandler(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, async (err) => {
      if (err) return next(err);

      const filesToClean = [];

      try {
        if (req.file) {
          filesToClean.push(req.file.path);
          req.file.buffer = await fs.promises.readFile(req.file.path);
        }

        if (req.files) {
          if (Array.isArray(req.files)) {
            for (const f of req.files) {
              filesToClean.push(f.path);
              f.buffer = await fs.promises.readFile(f.path);
            }
          } else {
            for (const field of Object.keys(req.files)) {
              for (const f of req.files[field]) {
                filesToClean.push(f.path);
                f.buffer = await fs.promises.readFile(f.path);
              }
            }
          }
        }

        // Attach cleanup hook on finish / close
        const cleanup = () => {
          for (const filePath of filesToClean) {
            fs.unlink(filePath, () => {});
          }
        };

        res.on('finish', cleanup);
        res.on('close', cleanup);

        next();
      } catch (readErr) {
        // Cleanup immediately on read error
        for (const filePath of filesToClean) {
          fs.unlink(filePath, () => {});
        }
        next(readErr);
      }
    });
  };
}

export const uploadSingleImage = createUploadHandler(upload.single('file'));
export const uploadDualProductImages = createUploadHandler(
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'image2', maxCount: 1 }
  ])
);
