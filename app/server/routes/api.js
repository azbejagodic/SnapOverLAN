import { Router } from 'express';
import { createBatchesRouter } from './batches.js';
import { createSystemRouter } from './system.js';
import {
  createUploadCompletedEvent,
  createUploadsRouter,
} from './uploads.js';

const createApiRouter = (options = {}) => {
  const router = Router();
  router.use(createUploadsRouter(options));
  router.use(createBatchesRouter());
  router.use(createSystemRouter(options));
  return router;
};

export { createApiRouter, createUploadCompletedEvent };
