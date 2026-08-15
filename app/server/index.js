import path from 'path';
import { promises as fs } from 'fs';
import { pathToFileURL } from 'url';
import {
  DATA_DIR,
  DATA_ROOT,
  HOST,
  IS_PACKAGED_RUNTIME,
  LAUNCH_SOURCE,
  PORT,
  STARTUP_LOG_PATH,
  UPLOAD_TEMP_DIR,
} from './config.js';
import { getPhoneUrlRecords } from './lan.js';
import { ensureStorageDirectories } from './storage.js';
import { createServerApp } from './app.js';
import { createParentBridge } from './parent-bridge.js';
import {
  SERVER_APPLICATION,
  SERVER_PROTOCOL_VERSION,
} from './identity.js';

const activeSockets = new Set();
let serverInstance = null;
let shutdownPromise = null;
let parentWatchTimer = null;

const getServerStatus = () => {
  const address = serverInstance?.address?.();
  const boundAddress = address && typeof address === 'object' ? address.address : HOST;
  const boundPort = address && typeof address === 'object' ? address.port : PORT;
  const lanUrls = getPhoneUrlRecords();

  return {
    status: serverInstance?.listening ? 'listening' : 'starting',
    application: SERVER_APPLICATION,
    protocolVersion: SERVER_PROTOCOL_VERSION,
    configuredHost: HOST,
    bindHost: boundAddress || HOST,
    port: boundPort || PORT,
    lanUrls,
    primaryLanUrl: lanUrls[0]?.url || '',
    launchSource: LAUNCH_SOURCE,
    packaged: IS_PACKAGED_RUNTIME,
    runtimeDataDir: DATA_ROOT,
    latestDir: DATA_DIR,
    uploadTempDir: UPLOAD_TEMP_DIR,
    pid: process.pid,
  };
};

const appendStartupLog = async (event, details = {}) => {
  if (!STARTUP_LOG_PATH) {
    return;
  }

  await fs.mkdir(path.dirname(STARTUP_LOG_PATH), { recursive: true });
  await fs.appendFile(STARTUP_LOG_PATH, `${JSON.stringify({
    time: new Date().toISOString(),
    event,
    ...details,
  })}\n`);
};

const isLoopbackRequest = (req) => {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
};

const parentBridge = createParentBridge();
const sendUploadCompletedToParent = parentBridge.sendUploadCompleted;
const requestAutoCopySettingFromParent = parentBridge.requestAutoCopySetting;
const handleAutoCopySettingResponse = parentBridge.handleAutoCopySettingResponse;

const app = createServerApp({
  getAutoCopySetting: () => requestAutoCopySettingFromParent('get'),
  getServerStatus,
  isLoopbackRequest,
  onShutdown: (reason) => shutdownServer(reason),
  onUploadCompleted: sendUploadCompletedToParent,
  setAutoCopySetting: (enabled) => requestAutoCopySettingFromParent('set', enabled),
});

const startServer = async ({ host = HOST, port = PORT, log = true } = {}) => {
  if (serverInstance?.listening) {
    return serverInstance;
  }

  await ensureStorageDirectories();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      serverInstance = server;
      const status = getServerStatus();
      if (log) {
        console.log(`SnapOverLAN listening on http://${host}:${port}`);
        console.log(`SnapOverLAN runtime data: ${DATA_ROOT}`);
        console.log(`SnapOverLAN LAN URLs: ${status.lanUrls.map((item) => item.url).join(', ') || 'none detected'}`);
      }
      appendStartupLog('server-listening', status).catch((err) => {
        console.warn('Could not write startup diagnostics:', err);
      });
      resolve(server);
    });

    server.on('connection', (socket) => {
      activeSockets.add(socket);
      socket.once('close', () => activeSockets.delete(socket));
    });
    server.once('error', reject);
  });
};

const stopServer = async () => {
  if (!serverInstance) {
    return;
  }

  const server = serverInstance;
  serverInstance = null;
  await new Promise((resolve, reject) => {
    const socketCleanupTimer = setTimeout(() => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
    }, 500);
    socketCleanupTimer.unref();

    server.close((err) => {
      clearTimeout(socketCleanupTimer);
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
    server.closeIdleConnections?.();
  });
};

const watchParentProcess = () => {
  // PHOTO_GPT_PARENT_PID is a legacy fallback for pre-rename Electron launches.
  const parentPid = Number(process.env.SNAPOVERLAN_PARENT_PID || process.env.PHOTO_GPT_PARENT_PID);
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return;
  }

  parentWatchTimer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') {
        shutdownServer('parent-exited');
      }
    }
  }, 2000);
  parentWatchTimer.unref();
};

const shutdownServer = (reason) => {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    try {
      if (parentWatchTimer) {
        clearInterval(parentWatchTimer);
        parentWatchTimer = null;
      }
      await appendStartupLog('server-stopping', { reason });
      await stopServer();
      if (process.connected) {
        process.send?.({ type: 'snapoverlan:stopped' });
      }
      process.exit(0);
    } catch (error) {
      console.error('Could not stop SnapOverLAN cleanly:', error);
      process.exit(1);
    }
  })();

  return shutdownPromise;
};

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  watchParentProcess();
  process.once('SIGINT', () => shutdownServer('SIGINT'));
  process.once('SIGTERM', () => shutdownServer('SIGTERM'));
  process.on('message', (message) => {
    if (handleAutoCopySettingResponse(message)) {
      return;
    }
    if (message?.type === 'snapoverlan:shutdown') {
      process.send?.({ type: 'snapoverlan:shutdown-accepted' });
      shutdownServer('electron-ipc');
    }
  });
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export {
  app,
  HOST,
  PORT,
  handleAutoCopySettingResponse,
  isLoopbackRequest,
  requestAutoCopySettingFromParent,
  sendUploadCompletedToParent,
  startServer,
  stopServer,
};
