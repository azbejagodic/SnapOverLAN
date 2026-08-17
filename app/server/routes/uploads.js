import path from 'path';
import { Router } from 'express';
import { MAX_FILES } from '../config.js';
import {
  finalizeUploadedBatch,
  isAllowedImageMimeType,
  upload,
  uploadErrorHandler,
} from '../storage.js';

const uploadStatus = {
  uploadInProgress: false,
  lastUploadStartedAt: null,
  lastUploadFinishedAt: null,
  uploadVersion: 0,
};

const markUploadStarted = (_req, res, next) => {
  uploadStatus.uploadInProgress = true;
  uploadStatus.lastUploadStartedAt = Date.now();
  uploadStatus.lastUploadFinishedAt = null;
  let didFinish = false;
  const markUploadFinished = () => {
    if (didFinish) return;
    didFinish = true;
    uploadStatus.uploadInProgress = false;
    uploadStatus.lastUploadFinishedAt = Date.now();
    uploadStatus.uploadVersion += 1;
  };
  res.once('finish', markUploadFinished);
  res.once('close', markUploadFinished);
  next();
};

const createUploadCompletedEvent = (req) => {
  const firstImage = (req.files || []).find((file) => (
    isAllowedImageMimeType(file?.mimetype)
  ));
  if (!firstImage || typeof req.uploadBatchId !== 'string' || !req.uploadBatchId
    || typeof firstImage.filename !== 'string' || !firstImage.filename
    || typeof firstImage.path !== 'string' || !path.isAbsolute(firstImage.path)) {
    return null;
  }
  return {
    type: 'snapoverlan:upload-completed',
    batchId: req.uploadBatchId,
    firstImage: {
      name: firstImage.filename,
      path: firstImage.path,
      mimeType: firstImage.mimetype,
    },
  };
};

const createUploadsRouter = ({ onUploadCompleted = () => {} } = {}) => {
  const router = Router();

  router.post('/upload', markUploadStarted, upload.array('photos', MAX_FILES), uploadErrorHandler, async (req, res, next) => {
    try {
      const files = await finalizeUploadedBatch(req);
      console.info('[auto-copy] upload completed', {
        batchId: req.uploadBatchId || '',
        fileCount: Array.isArray(req.files) ? req.files.length : 0,
      });
      const completionEvent = createUploadCompletedEvent(req);
      if (completionEvent) {
        console.info('[auto-copy] event created', {
          batchId: completionEvent.batchId,
          filename: completionEvent.firstImage.name,
          mimeType: completionEvent.firstImage.mimeType,
        });
        try {
          await onUploadCompleted(completionEvent);
        } catch (error) {
          console.warn('[auto-copy] failed: could not deliver upload completion event', error);
        }
      }
      res.json({ files });
    } catch (err) {
      next(err);
    }
  });

  router.get('/upload-status', (_req, res) => res.json(uploadStatus));
  return router;
};

export { createUploadCompletedEvent, createUploadsRouter };
