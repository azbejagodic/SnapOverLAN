import {
  app as electronApp,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from 'electron';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  classifyServerStatus,
  SERVER_CONTROL_ID,
} from './server/identity.js';
import { copyFirstUploadedImage } from './auto-copy.js';
import {
  normalizeDesktopSettings,
  updateDesktopSetting,
} from './desktop-settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const serverPath = path.join(__dirname, 'server', 'index.js');
const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const preloadPath = path.join(__dirname, 'preload.cjs');
const appIconPath = path.join(projectRoot, 'assets', 'electron', 'app-512.png');
const trayIconPath = path.join(projectRoot, 'assets', 'electron', 'tray-24.png');

const PORT = 8787;
const SERVER_ORIGIN = `http://localhost:${PORT}`;
const SERVER_STATUS_URL = `http://127.0.0.1:${PORT}/api/server-status`;
const SERVER_CONTROL_URL = `http://127.0.0.1:${PORT}/api/server-control`;
const SERVER_SHUTDOWN_URL = `http://127.0.0.1:${PORT}/api/server-shutdown`;
const SERVER_STOP_TIMEOUT_MS = 1000;
const SERVER_FORCE_STOP_TIMEOUT_MS = 500;
const LEGACY_SERVER_ERROR = 'An older SnapOverLAN server is running. Stop it once and restart the app.';
const AUTO_COPY_UNAVAILABLE_MESSAGE = 'Auto-copy unavailable because another SnapOverLAN server is running.';

electronApp.setName('SnapOverLAN');

let mainWindow = null;
let tray = null;
let ownedServerProcess = null;
let serverLaunchMode = 'offline';
let serverState = 'offline';
let serverError = '';
let serverOperation = null;
let serverOperationType = '';
let verifiedShutdownToken = '';
let backgroundMode = false;
let autoCopyFirstPhoto = false;
let autoCopyUnavailableReason = '';
let quitOperation = null;
let allowQuit = false;
const ownedServerMessageListeners = new WeakMap();

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 400) {
        reject(new Error(`Request failed (${res.statusCode}) for ${url}`));
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });

  req.on('error', reject);
  req.setTimeout(1500, () => {
    req.destroy(new Error(`Timed out requesting ${url}`));
  });
});

const postServerShutdown = (token) => new Promise((resolve, reject) => {
  const req = http.request(SERVER_SHUTDOWN_URL, {
    method: 'POST',
    headers: {
      'x-snapoverlan-shutdown-token': token,
    },
  }, (res) => {
    res.resume();
    if (res.statusCode !== 202) {
      reject(new Error(`Shutdown request failed (${res.statusCode})`));
      return;
    }
    resolve();
  });
  req.on('error', reject);
  req.setTimeout(1500, () => {
    req.destroy(new Error('Timed out requesting server shutdown'));
  });
  req.end();
});

const getServerIdentity = async () => {
  try {
    const control = await getJson(SERVER_CONTROL_URL);
    const kind = classifyServerStatus(control?.server);
    if (control?.service !== SERVER_CONTROL_ID
      || typeof control.shutdownToken !== 'string'
      || !/^[a-f0-9]{64}$/.test(control.shutdownToken)
      || kind === 'unrelated') {
      throw new Error('Invalid SnapOverLAN control response');
    }
    return {
      kind,
      server: control.server,
      shutdownToken: control.shutdownToken,
    };
  } catch (_err) {
    try {
      const status = await getJson(SERVER_STATUS_URL);
      const kind = classifyServerStatus(status);
      if (kind === 'unrelated') {
        return null;
      }
      return {
        kind,
        server: status,
        shutdownToken: '',
      };
    } catch (_statusError) {
      return null;
    }
  }
};

const isPortInUse = () => new Promise((resolve) => {
  const socket = net.createConnection({ host: '127.0.0.1', port: PORT });
  const finish = (inUse) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(inUse);
  };
  socket.setTimeout(500);
  socket.once('connect', () => finish(true));
  socket.once('timeout', () => finish(false));
  socket.once('error', () => finish(false));
});

const getStartupLogPath = () => path.join(electronApp.getPath('userData'), 'startup.log');
const getSettingsPath = () => path.join(electronApp.getPath('userData'), 'desktop-settings.json');
const getDesktopSettings = () => ({
  backgroundMode,
  autoCopyFirstPhoto,
});

const applyDesktopSettings = (settings) => {
  const normalized = normalizeDesktopSettings(settings);
  backgroundMode = normalized.backgroundMode;
  autoCopyFirstPhoto = normalized.autoCopyFirstPhoto;
};

const writeStartupLog = async (event, details = {}) => {
  const logPath = getStartupLogPath();
  const record = {
    time: new Date().toISOString(),
    event,
    serverOrigin: SERVER_ORIGIN,
    rendererPath,
    ...details,
  };

  console.log('SnapOverLAN startup:', record);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`);
};

const loadSettings = async () => {
  try {
    applyDesktopSettings(JSON.parse(await fs.readFile(getSettingsPath(), 'utf8')));
  } catch (error) {
    applyDesktopSettings({});
    if (error.code !== 'ENOENT') {
      console.warn('Could not read SnapOverLAN desktop settings:', error);
    }
  }
};

const saveSettings = async () => {
  const settingsPath = getSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(getDesktopSettings(), null, 2)}\n`, 'utf8');
};

const getServerStatePayload = () => ({
  state: serverState,
  error: serverError,
  owned: Boolean(ownedServerProcess),
});

const sendDesktopState = () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:state-changed', {
      server: getServerStatePayload(),
      backgroundMode,
      autoCopyFirstPhoto,
      autoCopyAvailable: Boolean(ownedServerProcess),
      autoCopyUnavailableReason,
    });
  }
};

const logAutoCopy = (stage, details = {}) => {
  console.info(`[auto-copy] ${stage}`, details);
};

const updateTrayMenu = () => {
  if (!tray || tray.isDestroyed()) {
    return;
  }

  const serverIsRunning = serverState === 'online';
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open SnapOverLAN',
      click: () => openMainWindow(),
    },
    { type: 'separator' },
    {
      label: `Background Mode: ${backgroundMode ? 'On' : 'Off'}`,
      enabled: serverIsRunning,
      click: () => {
        setBackgroundMode(!backgroundMode).catch((error) => console.error(error));
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => requestQuit(),
    },
  ]));
};

const setServerState = (nextState, error = '') => {
  serverState = nextState;
  serverError = error;
  if (serverState !== 'online' && backgroundMode) {
    backgroundMode = false;
    saveSettings().catch((saveError) => {
      console.error('Could not save disabled background mode:', saveError);
    });
    openMainWindow().catch((openError) => console.error(openError));
    destroyTray();
  }
  updateTrayMenu();
  sendDesktopState();
};

const waitForServer = async (serverProcess) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null || ownedServerProcess !== serverProcess) {
      return null;
    }
    const identity = await getServerIdentity();
    if (identity?.shutdownToken) {
      return identity;
    }
    await delay(100);
  }

  return null;
};

const waitForProcessExit = (serverProcess, timeoutMs) => new Promise((resolve) => {
  if (serverProcess.exitCode !== null) {
    resolve(true);
    return;
  }

  const timeout = setTimeout(() => {
    serverProcess.removeListener('exit', handleExit);
    resolve(false);
  }, timeoutMs);
  const handleExit = () => {
    clearTimeout(timeout);
    resolve(true);
  };
  serverProcess.once('exit', handleExit);
});

const waitForPortRelease = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse())) {
      return true;
    }
    await delay(100);
  }
  return !(await isPortInUse());
};

const uploadedFileExists = async (filePath) => {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const sendAutoCopyResult = (result) => {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || (
      !['copied', 'failed'].includes(result?.status)
      && typeof result?.message !== 'string'
    )
  ) {
    return;
  }

  mainWindow.webContents.send('desktop:auto-copy-result', {
    success: result.status === 'copied',
    filename: typeof result.filename === 'string' ? result.filename : '',
    message: typeof result.message === 'string' ? result.message : '',
    reason: typeof result.reason === 'string' ? result.reason : '',
  });
};

const handleOwnedServerMessage = async (serverProcess, message) => {
  if (ownedServerProcess !== serverProcess) {
    return;
  }

  const result = await copyFirstUploadedImage({
    message,
    enabled: autoCopyFirstPhoto,
    fileExists: uploadedFileExists,
    createImageFromPath: (filePath) => nativeImage.createFromPath(filePath),
    createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
    writeImage: (image) => clipboard.writeImage(image),
    readImage: () => clipboard.readImage(),
    onDiagnostic: logAutoCopy,
  });

  if (result.status === 'failed') {
    console.warn(`Could not automatically copy ${result.filename}:`, result.error);
  }
  sendAutoCopyResult(result);
};

const detachOwnedServerMessageListener = (serverProcess) => {
  const listener = ownedServerMessageListeners.get(serverProcess);
  if (!listener) {
    return;
  }
  serverProcess.removeListener('message', listener);
  ownedServerMessageListeners.delete(serverProcess);
};

const attachOwnedServerMessageListener = (serverProcess) => {
  detachOwnedServerMessageListener(serverProcess);
  const listener = (message) => {
    handleOwnedServerMessage(serverProcess, message).catch((error) => {
      console.warn('Could not handle upload completion event:', error);
    });
  };
  ownedServerMessageListeners.set(serverProcess, listener);
  serverProcess.on('message', listener);
};

const stopVerifiedReusedServerForAutoCopy = async (identity) => {
  if (
    identity?.kind !== 'current'
    || typeof identity.shutdownToken !== 'string'
    || !/^[a-f0-9]{64}$/.test(identity.shutdownToken)
  ) {
    return false;
  }

  logAutoCopy('requesting ownership from verified reused server');
  try {
    await postServerShutdown(identity.shutdownToken);
    const released = await waitForPortRelease(
      SERVER_STOP_TIMEOUT_MS + SERVER_FORCE_STOP_TIMEOUT_MS,
    );
    if (!released) {
      throw new Error(`Port ${PORT} was not released.`);
    }
    logAutoCopy('verified reused server stopped');
    return true;
  } catch (error) {
    logAutoCopy('failed', {
      reason: `Could not stop verified reused server: ${error.message}`,
    });
    return false;
  }
};

const startServerInternal = async () => {
  if (serverState === 'online') {
    return getServerStatePayload();
  }

  setServerState('starting');
  let existingIdentity = await getServerIdentity();
  if (existingIdentity?.shutdownToken && autoCopyFirstPhoto) {
    const stoppedForOwnership = await stopVerifiedReusedServerForAutoCopy(existingIdentity);
    if (stoppedForOwnership) {
      existingIdentity = null;
      verifiedShutdownToken = '';
      serverLaunchMode = 'offline';
      autoCopyUnavailableReason = '';
    } else {
      existingIdentity = await getServerIdentity();
      if (existingIdentity?.shutdownToken) {
        autoCopyUnavailableReason = AUTO_COPY_UNAVAILABLE_MESSAGE;
      } else if (!existingIdentity && !(await isPortInUse())) {
        autoCopyUnavailableReason = '';
      }
    }
  }
  if (existingIdentity?.shutdownToken) {
    verifiedShutdownToken = existingIdentity.shutdownToken;
    serverLaunchMode = 'reused';
    await writeStartupLog('server-reused', {
      serverStatus: existingIdentity.server,
      logFile: getStartupLogPath(),
    });
    if (autoCopyFirstPhoto) {
      logAutoCopy('waiting', { reason: autoCopyUnavailableReason });
      sendAutoCopyResult({ status: 'failed', message: autoCopyUnavailableReason });
    }
    setServerState('online');
    return getServerStatePayload();
  }
  if (existingIdentity?.kind === 'legacy') {
    setServerState('error', LEGACY_SERVER_ERROR);
    throw new Error(LEGACY_SERVER_ERROR);
  }
  if (existingIdentity?.kind === 'current') {
    const error = 'SnapOverLAN is running, but its secure local shutdown control is unavailable.';
    setServerState('error', error);
    throw new Error(error);
  }

  if (await isPortInUse()) {
    const error = `Port ${PORT} is already in use by another application.`;
    setServerState('error', error);
    throw new Error(error);
  }

  const isPackaged = electronApp.isPackaged;
  const nodePath = isPackaged ? process.execPath : process.env.npm_node_execpath || process.env.NODE || 'node';
  const runtimeDataRoot = isPackaged ? path.join(electronApp.getPath('userData'), 'data') : '';
  const logPath = getStartupLogPath();
  const childEnv = {
    ...process.env,
    SNAPOVERLAN_PARENT_PID: String(process.pid),
    SNAPOVERLAN_LOG_FILE: logPath,
    SNAPOVERLAN_SERVER_SOURCE: isPackaged ? 'electron-packaged-child' : 'electron-dev-child',
    PHOTO_GPT_PARENT_PID: String(process.pid),
    PHOTO_GPT_LOG_FILE: logPath,
    PHOTO_GPT_SERVER_SOURCE: isPackaged ? 'electron-packaged-child' : 'electron-dev-child',
  };

  if (isPackaged) {
    childEnv.ELECTRON_RUN_AS_NODE = '1';
    childEnv.SNAPOVERLAN_DATA_DIR = runtimeDataRoot;
    childEnv.SNAPOVERLAN_PACKAGED = '1';
    childEnv.PHOTO_GPT_DATA_DIR = runtimeDataRoot;
    childEnv.PHOTO_GPT_PACKAGED = '1';
  }

  await writeStartupLog('server-starting', {
    nodePath,
    serverPath,
    bindHost: '0.0.0.0',
    port: PORT,
    runtimeDataDir: runtimeDataRoot || path.join(projectRoot, 'data'),
    logFile: logPath,
  });

  const serverProcess = spawn(nodePath, [serverPath], {
    cwd: projectRoot,
    env: childEnv,
    stdio: isPackaged
      ? ['ignore', 'ignore', 'ignore', 'ipc']
      : ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  ownedServerProcess = serverProcess;
  autoCopyUnavailableReason = '';
  attachOwnedServerMessageListener(serverProcess);

  serverProcess.once('error', (error) => {
    detachOwnedServerMessageListener(serverProcess);
    if (ownedServerProcess === serverProcess) {
      ownedServerProcess = null;
      if (autoCopyFirstPhoto) {
        autoCopyUnavailableReason = 'Auto-copy is waiting for the local server.';
      }
      verifiedShutdownToken = '';
      setServerState('error', `Could not start the server: ${error.message}`);
    }
  });
  serverProcess.once('exit', (code, signal) => {
    detachOwnedServerMessageListener(serverProcess);
    if (ownedServerProcess !== serverProcess) {
      return;
    }
    ownedServerProcess = null;
    if (autoCopyFirstPhoto) {
      autoCopyUnavailableReason = 'Auto-copy is waiting for the local server.';
    }
    verifiedShutdownToken = '';
    if (serverState !== 'stopping' && !allowQuit) {
      const error = `Server process exited unexpectedly (${signal || code}).`;
      console.error(error);
      setServerState('error', error);
      writeStartupLog('server-exited-early', { code, signal }).catch(() => {});
    }
  });

  const status = await waitForServer(serverProcess);
  if (!status) {
    if (ownedServerProcess === serverProcess) {
      ownedServerProcess = null;
    }
    if (serverProcess.exitCode === null) {
      serverProcess.kill();
      await waitForProcessExit(serverProcess, SERVER_FORCE_STOP_TIMEOUT_MS);
    }
    const portConflict = await isPortInUse();
    const error = portConflict
      ? `Port ${PORT} is already in use; SnapOverLAN did not start a second server.`
      : `The local server did not become ready at ${SERVER_ORIGIN}.`;
    setServerState('error', error);
    throw new Error(error);
  }

  serverLaunchMode = 'started';
  verifiedShutdownToken = status.shutdownToken;
  await writeStartupLog('server-started', {
    serverStatus: status.server,
    logFile: logPath,
  });
  setServerState('online');
  return getServerStatePayload();
};

const startServer = () => {
  if (serverOperation) {
    if (serverOperationType === 'start') {
      return serverOperation;
    }
    return serverOperation.then(() => startServer());
  }
  serverOperationType = 'start';
  const operation = startServerInternal()
    .catch((error) => {
      if (serverState !== 'error') {
        setServerState('error', error.message || 'The server failed to start.');
      }
      throw error;
    })
    .finally(() => {
      if (serverOperation === operation) {
        serverOperation = null;
        serverOperationType = '';
      }
    });
  serverOperation = operation;
  return serverOperation;
};

const stopServerInternal = async () => {
  const serverProcess = ownedServerProcess;
  const identity = serverProcess
    ? null
    : verifiedShutdownToken
      ? {
        kind: 'current',
        shutdownToken: verifiedShutdownToken,
      }
      : await getServerIdentity();
  if (!identity && !serverProcess) {
    if (await isPortInUse()) {
      const error = `Port ${PORT} is in use by an application that is not a verified SnapOverLAN server.`;
      setServerState('error', error);
      throw new Error(error);
    }
    verifiedShutdownToken = '';
    serverLaunchMode = 'offline';
    setServerState('offline');
    return getServerStatePayload();
  }
  if (!serverProcess && identity?.kind === 'legacy') {
    setServerState('error', LEGACY_SERVER_ERROR);
    throw new Error(LEGACY_SERVER_ERROR);
  }
  if (!serverProcess && identity?.kind === 'current' && !identity.shutdownToken) {
    const error = 'SnapOverLAN is running, but its secure local shutdown control is unavailable.';
    setServerState('error', error);
    throw new Error(error);
  }

  setServerState('stopping');
  let exited = false;
  let forced = false;
  if (serverProcess?.connected) {
    try {
      serverProcess.send({ type: 'snapoverlan:shutdown' });
      exited = await waitForProcessExit(serverProcess, SERVER_STOP_TIMEOUT_MS);
    } catch (error) {
      console.warn('IPC server shutdown failed:', error);
    }
  } else if (identity?.shutdownToken) {
    try {
      await postServerShutdown(identity.shutdownToken);
      exited = await waitForPortRelease(SERVER_STOP_TIMEOUT_MS);
    } catch (error) {
      console.warn('Graceful server shutdown failed:', error);
    }
  }

  if (!exited && serverProcess?.exitCode === null) {
    console.warn('Forcing the owned SnapOverLAN server process to stop.');
    forced = true;
    serverProcess.kill();
    exited = await waitForProcessExit(serverProcess, SERVER_FORCE_STOP_TIMEOUT_MS);
  }

  if (ownedServerProcess === serverProcess) {
    ownedServerProcess = null;
  }
  if (!exited && (!serverProcess || serverProcess.exitCode === null)) {
    const error = serverProcess
      ? 'The owned server process did not stop cleanly.'
      : 'The reused SnapOverLAN server did not stop cleanly.';
    setServerState('error', error);
    throw new Error(error);
  }

  verifiedShutdownToken = '';
  serverLaunchMode = 'offline';
  setServerState('offline');
  await writeStartupLog('server-stopped', { forced }).catch(() => {});
  return getServerStatePayload();
};

const stopServer = () => {
  if (serverOperation) {
    if (serverOperationType === 'stop') {
      return serverOperation;
    }
    return serverOperation.then(() => stopServer());
  }
  serverOperationType = 'stop';
  const operation = stopServerInternal().finally(() => {
    if (serverOperation === operation) {
      serverOperation = null;
      serverOperationType = '';
    }
  });
  serverOperation = operation;
  return serverOperation;
};

const isLocalAppUrl = (targetUrl) => {
  try {
    const parsed = new URL(targetUrl);
    return ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === String(PORT);
  } catch (_err) {
    return false;
  }
};

const showMainWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  return true;
};

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    show: false,
    width: 960,
    height: 600,
    minWidth: 860,
    minHeight: 540,
    title: 'SnapOverLAN',
    icon: appIconPath,
    backgroundColor: '#343940',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'SnapOverLAN',
          icon: appIconPath,
          width: 1000,
          height: 760,
          autoHideMenuBar: true,
          backgroundColor: '#111827',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }

    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (allowQuit) {
      return;
    }
    event.preventDefault();
    if (backgroundMode) {
      mainWindow.hide();
      return;
    }
    requestQuit();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', sendDesktopState);
  await mainWindow.loadFile(rendererPath, {
    query: {
      launcher: 'electron',
      server: serverLaunchMode,
    },
  });
};

async function openMainWindow() {
  if (showMainWindow()) {
    return;
  }
  await createWindow();
  showMainWindow();
}

const createTray = () => {
  if (tray && !tray.isDestroyed()) {
    updateTrayMenu();
    return;
  }
  tray = new Tray(trayIconPath);
  tray.setToolTip('SnapOverLAN');
  tray.on('double-click', () => openMainWindow());
  updateTrayMenu();
};

const destroyTray = () => {
  if (!tray || tray.isDestroyed()) {
    tray = null;
    return;
  }
  tray.destroy();
  tray = null;
};

async function setBackgroundMode(enabled) {
  const nextValue = Boolean(enabled);
  if (nextValue && serverState !== 'online') {
    return false;
  }
  if (backgroundMode === nextValue) {
    return backgroundMode;
  }
  const previousSettings = getDesktopSettings();
  applyDesktopSettings(updateDesktopSetting(previousSettings, 'backgroundMode', nextValue));
  try {
    await saveSettings();
  } catch (error) {
    applyDesktopSettings(previousSettings);
    throw error;
  }

  if (backgroundMode) {
    createTray();
  } else {
    await openMainWindow();
    destroyTray();
  }
  updateTrayMenu();
  sendDesktopState();
  return backgroundMode;
}

const acquireOwnedServerForAutoCopy = async () => {
  if (ownedServerProcess) {
    return true;
  }
  if (
    serverLaunchMode !== 'reused'
    || !/^[a-f0-9]{64}$/.test(verifiedShutdownToken)
  ) {
    autoCopyUnavailableReason = AUTO_COPY_UNAVAILABLE_MESSAGE;
    sendDesktopState();
    sendAutoCopyResult({ status: 'failed', message: autoCopyUnavailableReason });
    return false;
  }

  setServerState('starting');
  const stopped = await stopVerifiedReusedServerForAutoCopy({
    kind: 'current',
    shutdownToken: verifiedShutdownToken,
  });
  if (!stopped) {
    const remainingIdentity = await getServerIdentity();
    if (remainingIdentity?.shutdownToken) {
      verifiedShutdownToken = remainingIdentity.shutdownToken;
      serverLaunchMode = 'reused';
      autoCopyUnavailableReason = AUTO_COPY_UNAVAILABLE_MESSAGE;
      setServerState('online');
    } else if (!remainingIdentity && !(await isPortInUse())) {
      verifiedShutdownToken = '';
      serverLaunchMode = 'offline';
      autoCopyUnavailableReason = '';
      setServerState('offline');
      try {
        await startServer();
        return Boolean(ownedServerProcess);
      } catch {
        autoCopyUnavailableReason = 'Auto-copy is waiting for the local server.';
      }
    } else {
      autoCopyUnavailableReason = AUTO_COPY_UNAVAILABLE_MESSAGE;
      setServerState('error', autoCopyUnavailableReason);
    }
    sendAutoCopyResult({ status: 'failed', message: autoCopyUnavailableReason });
    return false;
  }

  verifiedShutdownToken = '';
  serverLaunchMode = 'offline';
  autoCopyUnavailableReason = '';
  setServerState('offline');
  try {
    await startServer();
    return Boolean(ownedServerProcess);
  } catch (error) {
    autoCopyUnavailableReason = 'Auto-copy is waiting for the local server.';
    sendDesktopState();
    sendAutoCopyResult({
      status: 'failed',
      message: AUTO_COPY_UNAVAILABLE_MESSAGE,
    });
    return false;
  }
};

async function setAutoCopyFirstPhoto(enabled) {
  const nextValue = Boolean(enabled);
  if (autoCopyFirstPhoto === nextValue) {
    return autoCopyFirstPhoto;
  }

  const previousSettings = getDesktopSettings();
  applyDesktopSettings(updateDesktopSetting(previousSettings, 'autoCopyFirstPhoto', nextValue));
  try {
    await saveSettings();
  } catch (error) {
    applyDesktopSettings(previousSettings);
    throw error;
  }

  logAutoCopy(`setting ${autoCopyFirstPhoto ? 'enabled' : 'disabled'}`);
  if (!autoCopyFirstPhoto) {
    autoCopyUnavailableReason = '';
  }
  sendDesktopState();
  if (
    autoCopyFirstPhoto
    && serverState === 'online'
    && !ownedServerProcess
  ) {
    await acquireOwnedServerForAutoCopy();
  }
  return autoCopyFirstPhoto;
}

async function requestQuit() {
  if (quitOperation) {
    return quitOperation;
  }
  quitOperation = (async () => {
    if (serverOperation) {
      await serverOperation.catch(() => {});
    }
    if (serverLaunchMode !== 'offline' || ownedServerProcess) {
      try {
        await stopServer();
      } catch (error) {
        console.error('Could not stop the SnapOverLAN server during quit:', error);
      }
    }
    destroyTray();
    allowQuit = true;
    electronApp.quit();
  })();
  return quitOperation;
}

const handleServerControl = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    if (serverState !== 'error') {
      setServerState('error', error.message || 'Could not change the server state.');
    }
    return getServerStatePayload();
  }
};

ipcMain.handle('server:get-state', () => getServerStatePayload());
ipcMain.handle('server:retry', () => handleServerControl(() => startServer()));
ipcMain.handle('background:get', () => backgroundMode);
ipcMain.handle('background:set', (_event, enabled) => setBackgroundMode(enabled));
ipcMain.handle('auto-copy:get', () => autoCopyFirstPhoto);
ipcMain.handle('auto-copy:set', (_event, enabled) => setAutoCopyFirstPhoto(enabled));

const gotLock = electronApp.requestSingleInstanceLock();

if (!gotLock) {
  electronApp.quit();
} else {
  electronApp.on('second-instance', () => {
    openMainWindow().catch((error) => console.error(error));
  });

  electronApp.whenReady().then(async () => {
    await loadSettings();
    await createWindow();
    await startServer().catch((error) => {
      console.error('SnapOverLAN server startup failed:', error);
    });
    if (backgroundMode) {
      createTray();
    }
    showMainWindow();
  }).catch((error) => {
    dialog.showErrorBox('SnapOverLAN could not start', error.message || String(error));
    allowQuit = true;
    electronApp.quit();
  });

  electronApp.on('activate', () => {
    openMainWindow().catch((error) => console.error(error));
  });

  electronApp.on('before-quit', (event) => {
    if (allowQuit) {
      return;
    }
    event.preventDefault();
    requestQuit();
  });

  electronApp.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !backgroundMode && !allowQuit) {
      requestQuit();
    }
  });
}
