import { Router } from 'express';
import { createZipBuffer, formatBatchZipName } from '../archive.js';
import {
  clearAllBatches,
  deleteBatch,
  getStorageSettings,
  listBatches,
  listBatchFiles,
  listLatestFiles,
  selectBatch,
  updateStorageSettings,
} from '../storage.js';

const sendStorageError = (res, err) => {
  const message = err.message || 'Storage request failed.';
  res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
};

const createBatchesRouter = () => {
  const router = Router();
  router.get('/latest', async (_req, res, next) => {
    try { res.json({ files: await listLatestFiles() }); } catch (err) { next(err); }
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
    } catch (err) { next(err); }
  });
  router.get('/batches', async (_req, res) => {
    try { res.json({ batches: await listBatches() }); } catch (err) { sendStorageError(res, err); }
  });
  router.get('/batches/:id', async (req, res) => {
    try { res.json({ id: req.params.id, files: await listBatchFiles(req.params.id) }); } catch (err) { sendStorageError(res, err); }
  });
  router.post('/batches/:id/select', async (req, res) => {
    try { res.json({ id: req.params.id, files: await selectBatch(req.params.id) }); } catch (err) { sendStorageError(res, err); }
  });
  router.delete('/batches/:id', async (req, res) => {
    try { await deleteBatch(req.params.id); res.json({ ok: true }); } catch (err) { sendStorageError(res, err); }
  });
  router.delete('/batches', async (_req, res) => {
    try { await clearAllBatches(); res.json({ ok: true }); } catch (err) { sendStorageError(res, err); }
  });
  router.get('/storage-settings', async (_req, res) => {
    try { res.json(await getStorageSettings()); } catch (err) { sendStorageError(res, err); }
  });
  router.put('/storage-settings', async (req, res) => {
    try { res.json(await updateStorageSettings(req.body)); } catch (err) { sendStorageError(res, err); }
  });
  return router;
};

export { createBatchesRouter };
