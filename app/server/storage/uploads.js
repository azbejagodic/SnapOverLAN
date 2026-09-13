import multer from 'multer';
import path from 'path';
import { promises as fs } from 'fs';
import {
  MAX_FILES,
  MAX_FILE_SIZE,
  UPLOAD_TEMP_DIR,
} from '../config.js';
import {
  createBatchId,
  formatUploadTimestamp,
  resolveBatchDir,
  setCurrentBatchId,
  toUploadedFileRecords,
  writeBatchMetadata,
} from './batches.js';
import { applyBatchRetention } from './retention.js';
import { validateImage } from './image-validation.js';

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const IMAGE_UPLOAD_ERROR = 'Only JPEG, PNG, WebP, HEIC, and HEIF images are allowed.';
const formatMegabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))}MB`;

const isAllowedImageMimeType = (mimeType) => (
  typeof mimeType === 'string' && ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase())
);

const initUploadBatch = (req) => {
  if (req.uploadBatchTimestamp) return;
  const createdAt = new Date();
  req.uploadBatchTimestamp = formatUploadTimestamp(createdAt);
  req.uploadBatchId = createBatchId(req.uploadBatchTimestamp);
  req.uploadBatchDir = path.join(UPLOAD_TEMP_DIR, req.uploadBatchId);
  req.uploadBatchCreatedAt = createdAt.toISOString();
  req.uploadBatchPhotoCount = 0;
};

const removeUploadBatch = async (req) => {
  if (req.uploadBatchDir) await fs.rm(req.uploadBatchDir, { recursive: true, force: true });
};

const finalizeUploadedBatch = async (req) => {
  if (!req.files?.length || !req.uploadBatchId) {
    await applyBatchRetention();
    return [];
  }
  if (req.uploadBatchDir) {
    const batchDir = resolveBatchDir(req.uploadBatchId);
    await fs.rename(req.uploadBatchDir, batchDir);
    for (const file of req.files) file.path = path.join(batchDir, file.filename);
  }
  await writeBatchMetadata(req.uploadBatchId, { createdAt: req.uploadBatchCreatedAt });
  await setCurrentBatchId(req.uploadBatchId);
  await applyBatchRetention();
  return toUploadedFileRecords(req.files);
};

const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    try {
      initUploadBatch(req);
      await fs.mkdir(req.uploadBatchDir, { recursive: true });
      cb(null, req.uploadBatchDir);
    } catch (err) { cb(err); }
  },
  filename: (req, file, cb) => {
    initUploadBatch(req);
    if (!isAllowedImageMimeType(file.mimetype)) {
      cb(new Error(IMAGE_UPLOAD_ERROR));
      return;
    }
    req.uploadBatchPhotoCount += 1;
    const photoNumber = String(req.uploadBatchPhotoCount).padStart(3, '0');
    cb(null, `snapoverlan_${req.uploadBatchTimestamp}_photo-${photoNumber}.upload`);
  },
});

const upload = multer({
  storage,
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE, fields: 0, parts: MAX_FILES + 1 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedImageMimeType(file.mimetype)) { cb(null, true); return; }
    cb(new Error(IMAGE_UPLOAD_ERROR));
  },
});

const validateUploadedFiles = async (req, res, next) => {
  try {
    for (const file of req.files || []) {
      const verified = await validateImage(file.path);
      const filename = `${path.basename(file.filename, '.upload')}${verified.extension}`;
      const filePath = path.join(req.uploadBatchDir, filename);
      await fs.rename(file.path, filePath);
      Object.assign(file, { filename, path: filePath, mimetype: verified.mimeType });
    }
    next();
  } catch (error) { await uploadErrorHandler(error, req, res, next); }
};

const uploadErrorHandler = async (err, req, res, next) => {
  if (!err) { next(); return; }
  try { await removeUploadBatch(req); } catch {}
  if (err instanceof multer.MulterError) {
    let message = err.message;
    if (err.code === 'LIMIT_FILE_COUNT') message = `Maximum ${MAX_FILES} files are allowed.`;
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = `Each image must be <= ${formatMegabytes(MAX_FILE_SIZE)}.`;
    }
    res.status(400).json({ error: message });
    return;
  }
  res.status(400).json({ error: err.message || 'Upload failed.' });
};

export {
  finalizeUploadedBatch,
  isAllowedImageMimeType,
  upload,
  uploadErrorHandler,
  validateUploadedFiles,
};
