import { promises as fs } from 'fs';
import {
  getCurrentBatchId,
  listBatches,
  resolveBatchDir,
  selectNewestRemainingBatch,
} from './batches.js';

const MAX_RETAINED_BATCHES = 50;
let retentionCleanupQueue = Promise.resolve();

const applyBatchRetention = () => {
  const cleanup = async () => {
    const batches = await listBatches();
    const removedBatchIds = batches.slice(MAX_RETAINED_BATCHES).map((batch) => batch.id);
    if (removedBatchIds.length === 0) return [];
    await Promise.all(removedBatchIds.map((id) => (
      fs.rm(resolveBatchDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    )));
    if (removedBatchIds.includes(await getCurrentBatchId())) await selectNewestRemainingBatch();
    return removedBatchIds;
  };

  const cleanupPromise = retentionCleanupQueue.then(cleanup, cleanup);
  retentionCleanupQueue = cleanupPromise.catch(() => {});
  return cleanupPromise;
};

export { applyBatchRetention };
