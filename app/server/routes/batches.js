import { Router } from 'express';
import { sendStoredFile } from './stored-file-response.js';
import {
  clearAllBatches,
  deleteBatch,
  getBatchFilePathById,
  listBatches,
  listBatchFiles,
  listLatestFiles,
  selectBatch,
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
  router.get('/batches', async (_req, res) => {
    try { res.json({ batches: await listBatches() }); } catch (err) { sendStorageError(res, err); }
  });
  router.get('/batches/:id', async (req, res) => {
    try { res.json({ id: req.params.id, files: await listBatchFiles(req.params.id) }); } catch (err) { sendStorageError(res, err); }
  });
  router.get('/batches/:id/files/:name', async (req, res) => {
    try {
      sendStoredFile(res, await getBatchFilePathById(req.params.id, req.params.name));
    } catch (err) { sendStorageError(res, err); }
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
  return router;
};

export { createBatchesRouter };
