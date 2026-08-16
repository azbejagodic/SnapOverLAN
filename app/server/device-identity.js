import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { DATA_ROOT, PORT } from './config.js';

const DEVICE_ID_PATTERN = /^[a-f0-9]{8}$/;
const DEVICE_ID_FILENAME = 'device-id';

const getDeviceIdPath = (dataRoot = DATA_ROOT) => path.join(dataRoot, DEVICE_ID_FILENAME);

const readValidDeviceId = async (deviceIdPath, fsApi) => {
  try {
    const deviceId = (await fsApi.readFile(deviceIdPath, 'utf8')).trim();
    return DEVICE_ID_PATTERN.test(deviceId) ? deviceId : '';
  } catch {
    return '';
  }
};

const getOrCreateDeviceId = async ({
  dataRoot = DATA_ROOT,
  fsApi = fs,
  randomBytes = crypto.randomBytes,
} = {}) => {
  const deviceIdPath = getDeviceIdPath(dataRoot);
  const existingDeviceId = await readValidDeviceId(deviceIdPath, fsApi);
  if (existingDeviceId) return existingDeviceId;

  const deviceId = randomBytes(4).toString('hex');
  await fsApi.mkdir(dataRoot, { recursive: true });
  try {
    await fsApi.writeFile(deviceIdPath, `${deviceId}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return deviceId;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const concurrentlyCreatedDeviceId = await readValidDeviceId(deviceIdPath, fsApi);
    if (concurrentlyCreatedDeviceId) return concurrentlyCreatedDeviceId;
    await fsApi.writeFile(deviceIdPath, `${deviceId}\n`, 'utf8');
    return deviceId;
  }
};

const formatDeviceHostname = (deviceId) => {
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('Invalid SnapOverLAN device ID.');
  return `snap-${deviceId}.local`;
};

const formatStableUrl = (deviceId, port = PORT) => (
  `http://${formatDeviceHostname(deviceId)}:${port}`
);

export {
  DEVICE_ID_PATTERN,
  formatDeviceHostname,
  formatStableUrl,
  getDeviceIdPath,
  getOrCreateDeviceId,
};
