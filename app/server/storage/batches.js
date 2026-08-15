import path from 'path';
import { promises as fs } from 'fs';
import {
  BATCHES_DIR,
  CURRENT_BATCH_PATH,
  DATA_DIR,
} from '../config.js';

const BATCH_METADATA_FILE = '.batch.json';
const BATCH_ID_PATTERN = /^batch_[a-zA-Z0-9_-]+$/;

const isValidBatchId = (id) => typeof id === 'string' && BATCH_ID_PATTERN.test(id);

const assertValidBatchId = (id) => {
  if (!isValidBatchId(id)) throw new Error('Invalid batch id.');
};

const resolveBatchDir = (id) => {
  assertValidBatchId(id);
  const resolved = path.resolve(BATCHES_DIR, id);
  const batchesRoot = path.resolve(BATCHES_DIR);
  if (resolved !== path.join(batchesRoot, id) || !resolved.startsWith(`${batchesRoot}${path.sep}`)) {
    throw new Error('Invalid batch path.');
  }
  return resolved;
};

const batchExists = async (id) => {
  try { return (await fs.stat(resolveBatchDir(id))).isDirectory(); }
  catch { return false; }
};

const readJsonFile = async (filePath, fallback) => {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch { return fallback; }
};

const writeJsonFile = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const toFileRecord = ({ name, size }) => ({
  name,
  size,
  url: `/files/${encodeURIComponent(name)}`,
});

const toUploadedFileRecords = (files = []) => files.map((file) => (
  toFileRecord({ name: file.filename, size: file.size })
));

const statBatchFile = async (batchDir, name) => {
  const stats = await fs.stat(path.join(batchDir, name));
  return { name, size: stats.size, mtimeMs: stats.mtimeMs };
};

const listBatchFilesFromDir = async (batchDir) => {
  if (!batchDir) return [];
  const entries = await fs.readdir(batchDir, { withFileTypes: true });
  const filesOnly = await Promise.all(entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => statBatchFile(batchDir, entry.name)));
  filesOnly.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return filesOnly.map(toFileRecord);
};

const getCurrentBatchId = async () => {
  const current = await readJsonFile(CURRENT_BATCH_PATH, {});
  return isValidBatchId(current.currentBatchId) ? current.currentBatchId : '';
};

const setCurrentBatchId = async (id) => {
  if (id) {
    assertValidBatchId(id);
    await writeJsonFile(CURRENT_BATCH_PATH, { currentBatchId: id });
    return;
  }
  await fs.rm(CURRENT_BATCH_PATH, { force: true });
};

const getCurrentBatchDir = async () => {
  const currentBatchId = await getCurrentBatchId();
  if (!currentBatchId || !(await batchExists(currentBatchId))) return null;
  return resolveBatchDir(currentBatchId);
};

const listLatestFiles = async () => listBatchFilesFromDir(await getCurrentBatchDir());

const listBatchFiles = async (id) => {
  if (!(await batchExists(id))) throw new Error('Batch not found.');
  return listBatchFilesFromDir(resolveBatchDir(id));
};

const getBatchFilePath = async (name) => {
  if (!name || name !== path.basename(name) || name.includes('/') || name.includes('\\')) {
    throw new Error('Invalid filename.');
  }
  const currentBatchDir = await getCurrentBatchDir();
  if (!currentBatchDir) throw new Error('No current batch.');
  const resolved = path.resolve(currentBatchDir, name);
  if (!resolved.startsWith(`${path.resolve(currentBatchDir)}${path.sep}`)) {
    throw new Error('Invalid filename.');
  }
  return resolved;
};

const padDatePart = (value) => String(value).padStart(2, '0');

const formatUploadTimestamp = (date) => {
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hours = padDatePart(date.getHours());
  const minutes = padDatePart(date.getMinutes());
  const seconds = padDatePart(date.getSeconds());
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
};

const createBatchId = (timestamp) => (
  `batch_${timestamp}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
);

const writeBatchMetadata = async (id, metadata) => {
  await writeJsonFile(path.join(resolveBatchDir(id), BATCH_METADATA_FILE), { id, ...metadata });
};

const readBatchMetadata = async (id) => (
  readJsonFile(path.join(resolveBatchDir(id), BATCH_METADATA_FILE), {})
);

const getBatchSummary = async (entry, currentBatchId) => {
  const id = entry.name;
  const batchDir = resolveBatchDir(id);
  const [metadata, files] = await Promise.all([
    readBatchMetadata(id),
    listBatchFilesFromDir(batchDir),
  ]);
  const dirStats = await fs.stat(batchDir);
  return {
    id,
    createdAt: metadata.createdAt || dirStats.birthtime.toISOString(),
    fileCount: files.length,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    current: id === currentBatchId,
  };
};

const listBatches = async () => {
  const currentBatchId = await getCurrentBatchId();
  const entries = await fs.readdir(BATCHES_DIR, { withFileTypes: true });
  const batches = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && isValidBatchId(entry.name))
    .map((entry) => getBatchSummary(entry, currentBatchId)));
  batches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return batches;
};

const selectBatch = async (id) => {
  if (!(await batchExists(id))) throw new Error('Batch not found.');
  await setCurrentBatchId(id);
  return listBatchFiles(id);
};

const selectNewestRemainingBatch = async () => {
  const batches = await listBatches();
  await setCurrentBatchId(batches[0]?.id || '');
};

const deleteBatch = async (id) => {
  if (!(await batchExists(id))) throw new Error('Batch not found.');
  await fs.rm(resolveBatchDir(id), { recursive: true, force: true });
  if ((await getCurrentBatchId()) === id) await selectNewestRemainingBatch();
};

const clearAllBatches = async () => {
  const entries = await fs.readdir(BATCHES_DIR, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && isValidBatchId(entry.name))
    .map((entry) => fs.rm(resolveBatchDir(entry.name), { recursive: true, force: true })));
  await setCurrentBatchId('');
};

const migrateLegacyLatestFiles = async () => {
  if (await getCurrentBatchId()) return;
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const legacyFiles = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.'));
  if (legacyFiles.length === 0) return;
  const createdAt = new Date();
  const timestamp = formatUploadTimestamp(createdAt);
  const id = createBatchId(timestamp);
  const batchDir = resolveBatchDir(id);
  await fs.mkdir(batchDir, { recursive: true });
  await Promise.all(legacyFiles.map((entry) => (
    fs.rename(path.join(DATA_DIR, entry.name), path.join(batchDir, entry.name))
  )));
  await writeBatchMetadata(id, { createdAt: createdAt.toISOString(), source: 'legacy-latest' });
  await setCurrentBatchId(id);
};

export {
  clearAllBatches,
  createBatchId,
  deleteBatch,
  formatUploadTimestamp,
  getBatchFilePath,
  getCurrentBatchId,
  listBatches,
  listBatchFiles,
  listLatestFiles,
  migrateLegacyLatestFiles,
  readJsonFile,
  resolveBatchDir,
  selectBatch,
  selectNewestRemainingBatch,
  setCurrentBatchId,
  toUploadedFileRecords,
  writeBatchMetadata,
  writeJsonFile,
};
