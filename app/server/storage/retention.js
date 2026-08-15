import { promises as fs } from 'fs';
import { STORAGE_SETTINGS_PATH } from '../config.js';
import {
  getCurrentBatchId,
  listBatches,
  readJsonFile,
  resolveBatchDir,
  selectNewestRemainingBatch,
  writeJsonFile,
} from './batches.js';

const DEFAULT_STORAGE_SETTINGS = { retentionDays: null };
const DAY_MS = 24 * 60 * 60 * 1000;
let retentionCleanupQueue = Promise.resolve();

const getStorageSettings = async () => ({
  ...DEFAULT_STORAGE_SETTINGS,
  ...await readJsonFile(STORAGE_SETTINGS_PATH, {}),
});

const applyBatchRetention = ({ now = new Date() } = {}) => {
  const cleanup = async () => {
    const settings = await getStorageSettings();
    const retentionDays = Number(settings.retentionDays);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
    const cutoff = now.getTime() - (retentionDays * DAY_MS);
    const batches = await listBatches();
    const expiredBatchIds = batches
      .filter((batch) => {
        const createdAt = new Date(batch.createdAt).getTime();
        return Number.isFinite(createdAt) && createdAt < cutoff;
      })
      .map((batch) => batch.id);
    if (expiredBatchIds.length === 0) return [];
    await Promise.all(expiredBatchIds.map((id) => (
      fs.rm(resolveBatchDir(id), { recursive: true, force: true })
    )));
    if (expiredBatchIds.includes(await getCurrentBatchId())) await selectNewestRemainingBatch();
    return expiredBatchIds;
  };

  const cleanupPromise = retentionCleanupQueue.then(cleanup, cleanup);
  retentionCleanupQueue = cleanupPromise.catch(() => {});
  return cleanupPromise;
};

const updateStorageSettings = async (settings = {}) => {
  const rawRetentionDays = settings.retentionDays;
  const retentionDays = rawRetentionDays === null || rawRetentionDays === undefined || rawRetentionDays === ''
    ? null
    : Number(rawRetentionDays);
  if (retentionDays !== null && (!Number.isFinite(retentionDays) || retentionDays < 0)) {
    throw new Error('retentionDays must be null, 0, or a positive number.');
  }
  const nextSettings = { retentionDays: retentionDays && retentionDays > 0 ? retentionDays : null };
  await writeJsonFile(STORAGE_SETTINGS_PATH, nextSettings);
  await applyBatchRetention();
  return nextSettings;
};

export { applyBatchRetention, getStorageSettings, updateStorageSettings };
