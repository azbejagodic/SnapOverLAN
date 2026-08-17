import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
// Legacy PHOTO_GPT_* names are fallbacks for existing developer scripts and installs.
const legacyEnv = (name) => process.env[`PHOTO_GPT_${name}`];
const snapEnv = (name) => process.env[`SNAPOVERLAN_${name}`] || legacyEnv(name);
const configuredPort = Number(snapEnv('PORT'));
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort
  : 8787;
const HOST = '0.0.0.0';
const MAX_FILES = 20;
const MAX_FILE_SIZE = 12 * 1024 * 1024;

const DATA_ROOT = snapEnv('DATA_DIR') || path.join(PROJECT_ROOT, 'data');
const DATA_DIR = path.join(DATA_ROOT, 'latest');
const BATCHES_DIR = path.join(DATA_ROOT, 'batches');
const CURRENT_BATCH_PATH = path.join(DATA_ROOT, 'current-batch.json');
const STORAGE_SETTINGS_PATH = path.join(DATA_ROOT, 'storage-settings.json');
const UPLOAD_TEMP_DIR = path.join(DATA_ROOT, 'upload-tmp');
const PWA_DIR = path.join(PROJECT_ROOT, 'pwa');
const STARTUP_LOG_PATH = snapEnv('LOG_FILE') || '';
const LAUNCH_SOURCE = snapEnv('SERVER_SOURCE') || (snapEnv('PARENT_PID') ? 'electron' : 'standalone');
const IS_PACKAGED_RUNTIME = snapEnv('PACKAGED') === '1';

export {
  BATCHES_DIR,
  CURRENT_BATCH_PATH,
  DATA_DIR,
  DATA_ROOT,
  HOST,
  IS_PACKAGED_RUNTIME,
  LAUNCH_SOURCE,
  MAX_FILES,
  MAX_FILE_SIZE,
  PORT,
  PROJECT_ROOT,
  PWA_DIR,
  STARTUP_LOG_PATH,
  STORAGE_SETTINGS_PATH,
  UPLOAD_TEMP_DIR,
};
