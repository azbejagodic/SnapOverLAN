import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
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
  PWA_DIR,
  STARTUP_LOG_PATH,
  UPLOAD_TEMP_DIR,
} from './config.js';
import { getPhoneUrlRecords } from './lan.js';
import { ensureStorageDirectories } from './storage.js';
import { createApiRouter } from './routes/api.js';
import { createFilesRouter } from './routes/files.js';
import {
  SERVER_APPLICATION,
  SERVER_CONTROL_ID,
  SERVER_PROTOCOL_VERSION,
} from './identity.js';

const app = express();
const shutdownToken = crypto.randomBytes(32).toString('hex');
const activeSockets = new Set();
const pendingAutoCopyRequests = new Map();
let serverInstance = null;
let shutdownPromise = null;
let parentWatchTimer = null;
let nextAutoCopyRequestId = 0;
const AUTO_COPY_REQUEST_TIMEOUT_MS = 1500;

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

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

const sendUploadCompletedToParent = (event, targetProcess = process) => {
  if (!targetProcess?.connected || typeof targetProcess.send !== 'function') {
    console.info('[auto-copy] IPC unavailable; standalone upload remains successful');
    return false;
  }

  try {
    targetProcess.send(event, (error) => {
      if (error) {
        console.warn('[auto-copy] failed: IPC event delivery', error);
        return;
      }
      console.info('[auto-copy] IPC event sent', {
        batchId: event?.batchId || '',
        filename: event?.firstImage?.name || '',
      });
    });
    return true;
  } catch (error) {
    console.warn('[auto-copy] failed: IPC event send', error);
    return false;
  }
};

const requestAutoCopySettingFromParent = (
  operation,
  enabled,
  targetProcess = process,
) => new Promise((resolve, reject) => {
  if (!targetProcess?.connected || typeof targetProcess.send !== 'function') {
    reject(new Error('Auto-copy control requires the SnapOverLAN desktop app.'));
    return;
  }

  const requestId = `${process.pid}-${Date.now()}-${nextAutoCopyRequestId += 1}`;
  const timeout = setTimeout(() => {
    pendingAutoCopyRequests.delete(requestId);
    reject(new Error('Timed out waiting for the desktop app.'));
  }, AUTO_COPY_REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  pendingAutoCopyRequests.set(requestId, {
    resolve: (value) => {
      clearTimeout(timeout);
      resolve(value);
    },
    reject: (error) => {
      clearTimeout(timeout);
      reject(error);
    },
  });

  const message = {
    type: 'snapoverlan:auto-copy-request',
    requestId,
    operation,
  };
  if (operation === 'set') {
    message.enabled = enabled;
  }

  try {
    targetProcess.send(message, (error) => {
      if (!error) {
        return;
      }
      const pending = pendingAutoCopyRequests.get(requestId);
      pendingAutoCopyRequests.delete(requestId);
      pending?.reject(new Error('Could not contact the desktop app.'));
    });
  } catch {
    const pending = pendingAutoCopyRequests.get(requestId);
    pendingAutoCopyRequests.delete(requestId);
    pending?.reject(new Error('Could not contact the desktop app.'));
  }
});

const handleAutoCopySettingResponse = (message) => {
  if (
    message?.type !== 'snapoverlan:auto-copy-response'
    || typeof message.requestId !== 'string'
  ) {
    return false;
  }

  const pending = pendingAutoCopyRequests.get(message.requestId);
  if (!pending) {
    return false;
  }
  pendingAutoCopyRequests.delete(message.requestId);
  if (typeof message.error === 'string' && message.error) {
    pending.reject(new Error(message.error));
  } else if (typeof message.enabled !== 'boolean') {
    pending.reject(new Error('Invalid auto-copy response from the desktop app.'));
  } else {
    pending.resolve(message.enabled);
  }
  return true;
};

app.get('/api/server-control', (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.sendStatus(404);
    return;
  }
  res.json({
    service: SERVER_CONTROL_ID,
    application: SERVER_APPLICATION,
    protocolVersion: SERVER_PROTOCOL_VERSION,
    shutdownToken,
    server: getServerStatus(),
  });
});

app.post('/api/server-shutdown', (req, res) => {
  const suppliedToken = req.get('x-snapoverlan-shutdown-token') || '';
  const suppliedTokenBuffer = Buffer.from(suppliedToken);
  const shutdownTokenBuffer = Buffer.from(shutdownToken);
  const validToken = suppliedTokenBuffer.length === shutdownTokenBuffer.length
    && crypto.timingSafeEqual(suppliedTokenBuffer, shutdownTokenBuffer);
  if (!isLoopbackRequest(req) || !validToken) {
    res.sendStatus(404);
    return;
  }
  res.status(202).json({ stopping: true });
  setImmediate(() => shutdownServer('localhost-control'));
});

app.use('/api', express.json({ limit: '32kb' }), createApiRouter({
  getAutoCopySetting: () => requestAutoCopySettingFromParent('get'),
  getServerStatus,
  isLoopbackRequest,
  onUploadCompleted: sendUploadCompletedToParent,
  setAutoCopySetting: (enabled) => requestAutoCopySettingFromParent('set', enabled),
}));
app.use('/files', createFilesRouter());
app.use('/', express.static(PWA_DIR));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
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
