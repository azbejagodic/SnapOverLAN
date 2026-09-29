import { promises as fs } from 'fs';
import { BATCHES_DIR, DATA_DIR } from '../config.js';
import { migrateLegacyLatestFiles } from './batches.js';
import { applyBatchRetention } from './retention.js';
import { cleanUploadTempDirectory } from './upload-temp.js';

const ensureStorageDirectories = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BATCHES_DIR, { recursive: true });
  await cleanUploadTempDirectory();
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
} from './batches.js';
export {
  finalizeUploadedBatch,
  isAllowedImageMimeType,
  upload,
  uploadErrorHandler,
  validateUploadedFiles,
} from './uploads.js';
export { ensureStorageDirectories };
