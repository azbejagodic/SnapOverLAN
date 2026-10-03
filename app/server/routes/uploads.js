import path from 'path';
import { promises as fs } from 'node:fs';
import { Router } from 'express';
import { MAX_FILES, MIN_UPLOAD_FREE_BYTES, UPLOAD_TEMP_DIR, UPLOAD_DISK_SPACE_ERROR } from '../config.js';
import { uploadLifecycle } from '../upload-lifecycle.js';
import {
  finalizeUploadedBatch,
  isAllowedImageMimeType,
  upload,
  uploadErrorHandler,
  validateUploadedFiles,
} from '../storage.js';

const { markUploadStarted } = uploadLifecycle;

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

  const sessionAction = (operation) => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(operation(req.params.sessionId)); }
    catch (error) {
      if (error.statusCode) res.status(error.statusCode).json({ error: error.message });
      else next(error);
    }
  };
  router.post('/send-session', sessionAction(uploadLifecycle.beginSendSession));
  router.post('/send-session/:sessionId/renew', sessionAction(uploadLifecycle.renewSendSession));
  router.post('/send-session/:sessionId/end', sessionAction(uploadLifecycle.endSendSession));

  router.post('/upload', markUploadStarted, (req, res, next) => {
    req.uploadProcessing = (async () => {
      try {
        const space = await fs.statfs(UPLOAD_TEMP_DIR, { bigint: true });
        if (req.uploadInterrupted || req.aborted) return;
        if (space.bavail * space.bsize < BigInt(MIN_UPLOAD_FREE_BYTES)) {
          res.status(507).json({ error: UPLOAD_DISK_SPACE_ERROR });
          return;
        }
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

  return router;
};

export { createUploadsRouter };
