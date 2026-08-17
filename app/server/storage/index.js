import { promises as fs } from 'fs';
import { BATCHES_DIR, DATA_DIR, UPLOAD_TEMP_DIR } from '../config.js';
import { migrateLegacyLatestFiles } from './batches.js';
import { applyBatchRetention } from './retention.js';

const ensureStorageDirectories = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BATCHES_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_TEMP_DIR, { recursive: true });
  await migrateLegacyLatestFiles();
  await applyBatchRetention();
};

export {
  clearAllBatches,
  deleteBatch,
  getBatchFilePath,
  getBatchFilePathById,
  listBatches,
  listBatchFiles,
  listLatestFiles,
  selectBatch,
  toUploadedFileRecords,
} from './batches.js';
export { getStorageSettings, updateStorageSettings } from './retention.js';
export {
  finalizeUploadedBatch,
  isAllowedImageMimeType,
  upload,
  uploadErrorHandler,
} from './uploads.js';
export { ensureStorageDirectories };
