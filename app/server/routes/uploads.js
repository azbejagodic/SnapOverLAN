import path from 'path';
import { Router } from 'express';
import { MAX_FILES } from '../config.js';
import { uploadLifecycle } from '../upload-lifecycle.js';
import {
  finalizeUploadedBatch,
  isAllowedImageMimeType,
  upload,
  uploadErrorHandler,
  validateUploadedFiles,
} from '../storage.js';

const { status: uploadStatus, markUploadStarted } = uploadLifecycle;

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
  const receiveFiles = upload.array('photos', MAX_FILES);

  router.post('/upload', markUploadStarted, (req, res, next) => {
    req.uploadProcessing = (async () => {
      try {
        await new Promise((resolve, reject) => receiveFiles(req, res, (error) => error ? reject(error) : resolve()));
        await validateUploadedFiles(req);
        const files = await finalizeUploadedBatch(req);
        if (req.uploadInterrupted || req.aborted) return;
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
        await uploadErrorHandler(err, req, res, next);
      }
    })();
    req.uploadProcessing.catch(next);
  });

  router.get('/upload-status', (_req, res) => res.json(uploadStatus));
  return router;
};

export { createUploadCompletedEvent, createUploadsRouter };
