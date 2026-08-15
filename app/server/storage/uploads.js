import multer from 'multer';
import path from 'path';
import { promises as fs } from 'fs';
import {
  MAX_FILES,
  MAX_FILE_SIZE,
  MAX_VIDEO_FILE_SIZE,
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

const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);
const MAX_UPLOAD_FILE_SIZE = Math.max(MAX_FILE_SIZE, MAX_VIDEO_FILE_SIZE);
const formatMegabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))}MB`;

const getUploadMediaType = (file) => {
  if (file.mimetype.startsWith('image/')) return 'photo';
  if (ALLOWED_VIDEO_MIME_TYPES.has(file.mimetype)) return 'video';
  return '';
};

const initUploadBatch = (req) => {
  if (req.uploadBatchTimestamp) return;
  const createdAt = new Date();
  req.uploadBatchTimestamp = formatUploadTimestamp(createdAt);
  req.uploadBatchId = createBatchId(req.uploadBatchTimestamp);
  req.uploadBatchDir = resolveBatchDir(req.uploadBatchId);
  req.uploadBatchCreatedAt = createdAt.toISOString();
  req.uploadBatchCounts = { photo: 0, video: 0 };
};

const removeUploadedFiles = async (files = []) => {
  await Promise.all(files.map((file) => fs.rm(file.path, { force: true })));
};

const removeUploadBatch = async (req) => {
  if (req.uploadBatchDir) await fs.rm(req.uploadBatchDir, { recursive: true, force: true });
};

const finalizeUploadedBatch = async (req) => {
  if (!req.files?.length || !req.uploadBatchId) {
    await applyBatchRetention();
    return [];
  }
  await writeBatchMetadata(req.uploadBatchId, { createdAt: req.uploadBatchCreatedAt });
  await setCurrentBatchId(req.uploadBatchId);
  await applyBatchRetention();
  return toUploadedFileRecords(req.files);
};

const validateUploadedFiles = async (req, _res, next) => {
  try {
    for (const file of req.files || []) {
      const mediaType = getUploadMediaType(file);
      const maxSize = mediaType === 'video' ? MAX_VIDEO_FILE_SIZE : MAX_FILE_SIZE;
      if (file.size > maxSize) {
        await removeUploadedFiles(req.files);
        await removeUploadBatch(req);
        const label = mediaType === 'video' ? 'video' : 'image';
        next(new Error(`Each ${label} must be <= ${formatMegabytes(maxSize)}.`));
        return;
      }
    }
    next();
  } catch (err) { next(err); }
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
    const mediaType = getUploadMediaType(file);
    if (!mediaType) {
      cb(new Error('Only image, MP4, MOV, or WebM files are allowed.'));
      return;
    }
    req.uploadBatchCounts[mediaType] += 1;
    const ext = path.extname(file.originalname).toLowerCase();
    const mediaNumber = String(req.uploadBatchCounts[mediaType]).padStart(3, '0');
    cb(null, `snapoverlan_${req.uploadBatchTimestamp}_${mediaType}-${mediaNumber}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { files: MAX_FILES, fileSize: MAX_UPLOAD_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (getUploadMediaType(file)) { cb(null, true); return; }
    cb(new Error('Only image, MP4, MOV, or WebM files are allowed.'));
  },
});

const uploadErrorHandler = async (err, req, res, next) => {
  if (!err) { next(); return; }
  try { await removeUploadBatch(req); } catch {}
  if (err instanceof multer.MulterError) {
    let message = err.message;
    if (err.code === 'LIMIT_FILE_COUNT') message = `Maximum ${MAX_FILES} files are allowed.`;
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = `Each video must be <= ${formatMegabytes(MAX_VIDEO_FILE_SIZE)}. Images must be <= ${formatMegabytes(MAX_FILE_SIZE)}.`;
    }
    res.status(400).json({ error: message });
    return;
  }
  res.status(400).json({ error: err.message || 'Upload failed.' });
};

export {
  finalizeUploadedBatch,
  upload,
  uploadErrorHandler,
  validateUploadedFiles,
};
