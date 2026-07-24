import { Router } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { MAX_FILES, PORT } from '../config.js';
import { getPhoneUrlRecords } from '../lan.js';
import {
  clearAllBatches,
  deleteBatch,
  finalizeUploadedBatch,
  getBatchFilePath,
  getStorageSettings,
  listBatches,
  listBatchFiles,
  listLatestFiles,
  selectBatch,
  updateStorageSettings,
  upload,
  uploadErrorHandler,
  validateUploadedFiles,
} from '../storage.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
})();

const getCrc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const sendStorageError = (res, err) => {
  const message = err.message || 'Storage request failed.';
  const status = /not found/i.test(message) ? 404 : 400;
  res.status(status).json({ error: message });
};

const createZipBuffer = async (files) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const data = await fs.readFile(await getBatchFilePath(file.name));
    const name = Buffer.from(file.name, 'utf8');
    const crc = getCrc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectorySize, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
};

const padDatePart = (value) => String(value).padStart(2, '0');

const formatBatchZipName = (batchTimestamp) => {
  const date = batchTimestamp ? new Date(batchTimestamp) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safeDate.getFullYear();
  const month = padDatePart(safeDate.getMonth() + 1);
  const day = padDatePart(safeDate.getDate());
  const hours = padDatePart(safeDate.getHours());
  const minutes = padDatePart(safeDate.getMinutes());
  const seconds = padDatePart(safeDate.getSeconds());

  return `snapoverlan_${year}-${month}-${day}_${hours}-${minutes}-${seconds}_batch.zip`;
};

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
    if (didFinish) {
      return;
    }

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
    typeof file?.mimetype === 'string' && file.mimetype.startsWith('image/')
  ));

  if (
    !firstImage
    || typeof req.uploadBatchId !== 'string'
    || !req.uploadBatchId
    || typeof firstImage.filename !== 'string'
    || !firstImage.filename
    || typeof firstImage.path !== 'string'
    || !path.isAbsolute(firstImage.path)
  ) {
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

const createApiRouter = ({ getServerStatus, onUploadCompleted = () => {} }) => {
  const router = Router();

  router.post('/upload', markUploadStarted, upload.array('photos', MAX_FILES), validateUploadedFiles, uploadErrorHandler, async (req, res, next) => {
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

  router.get('/upload-status', (_req, res) => {
    res.json(uploadStatus);
  });

  router.get('/latest', async (_req, res, next) => {
    try {
      const files = await listLatestFiles();
      res.json({ files });
    } catch (err) {
      next(err);
    }
  });

  router.get('/latest/download', async (_req, res, next) => {
    try {
      const files = await listLatestFiles();
      if (files.length === 0) {
        res.status(404).json({ error: 'No pictures available.' });
        return;
      }

      const currentBatch = (await listBatches()).find((batch) => batch.current);
      const zipBuffer = await createZipBuffer(files);
      const zipName = formatBatchZipName(currentBatch?.createdAt);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.send(zipBuffer);
    } catch (err) {
      next(err);
    }
  });

  router.get('/batches', async (_req, res) => {
    try {
      res.json({ batches: await listBatches() });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  router.get('/batches/:id', async (req, res) => {
    try {
      res.json({
        id: req.params.id,
        files: await listBatchFiles(req.params.id),
      });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  router.post('/batches/:id/select', async (req, res) => {
    try {
      res.json({
        id: req.params.id,
        files: await selectBatch(req.params.id),
      });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  router.delete('/batches/:id', async (req, res) => {
    try {
      await deleteBatch(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  router.delete('/batches', async (_req, res) => {
    try {
      await clearAllBatches();
      res.json({ ok: true });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  router.get('/storage-settings', async (_req, res) => {
    try {
      res.json(await getStorageSettings());
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  router.put('/storage-settings', async (req, res) => {
    try {
      res.json(await updateStorageSettings(req.body));
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  router.get('/phone-url', (req, res) => {
    const lanUrls = getPhoneUrlRecords();
    const requestHost = req.get('host') || `localhost:${PORT}`;
    const fallbackUrl = `http://${requestHost}`;
    const urls = lanUrls.length > 0
      ? lanUrls
      : [{ address: requestHost.split(':')[0], private: false, url: fallbackUrl }];

    res.json({
      port: PORT,
      primaryUrl: urls[0].url,
      urls,
    });
  });

  router.get('/server-status', (_req, res) => {
    res.json(getServerStatus());
  });

  return router;
};

export { createApiRouter, createUploadCompletedEvent };
