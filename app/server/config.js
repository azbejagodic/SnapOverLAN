import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const configuredPort = Number(process.env.SNAPOVERLAN_PORT);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort
  : 8787;
const HOST = process.env.SNAPOVERLAN_HOST === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
const LAN_EXPOSURE = process.env.SNAPOVERLAN_LAN_EXPOSURE !== '0';
const MAX_FILES = 10;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 1;
const MIN_UPLOAD_FREE_BYTES = 1024 ** 3 + MAX_FILES * MAX_FILE_SIZE;
const UPLOAD_BUSY_ERROR = 'Another upload is in progress. Try again shortly.';
const UPLOAD_DISK_SPACE_ERROR = 'The PC needs more free disk space.';

const DATA_ROOT = process.env.SNAPOVERLAN_DATA_DIR || path.join(PROJECT_ROOT, 'data');
const DATA_DIR = path.join(DATA_ROOT, 'latest');
const BATCHES_DIR = path.join(DATA_ROOT, 'batches');
const CURRENT_BATCH_PATH = path.join(DATA_ROOT, 'current-batch.json');
const UPLOAD_TEMP_DIR = path.join(DATA_ROOT, 'upload-tmp');
const PWA_DIR = path.join(PROJECT_ROOT, 'pwa');
const STARTUP_LOG_PATH = process.env.SNAPOVERLAN_LOG_FILE || '';
const LAUNCH_SOURCE = process.env.SNAPOVERLAN_SERVER_SOURCE || (process.env.SNAPOVERLAN_PARENT_PID ? 'electron' : 'standalone');
const IS_PACKAGED_RUNTIME = process.env.SNAPOVERLAN_PACKAGED === '1';
// Match the desktop's packaged Windows / portable runtime distinction for help copy.
const FIREWALL_GUIDANCE_MODE = process.platform !== 'win32' ? 'other'
  : !IS_PACKAGED_RUNTIME ? 'development'
    : process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR
      ? 'portable' : 'setup';

export {
  BATCHES_DIR,
  CURRENT_BATCH_PATH,
  DATA_DIR,
  DATA_ROOT,
  FIREWALL_GUIDANCE_MODE,
  HOST,
  LAN_EXPOSURE,
  IS_PACKAGED_RUNTIME,
  LAUNCH_SOURCE,
  MAX_FILES,
  MAX_FILE_SIZE,
  MAX_ACTIVE_UPLOADS,
  MIN_UPLOAD_FREE_BYTES,
  UPLOAD_BUSY_ERROR,
  UPLOAD_DISK_SPACE_ERROR,
  PORT,
  PWA_DIR,
  STARTUP_LOG_PATH,
  UPLOAD_TEMP_DIR,
};
