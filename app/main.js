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
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeDesktopSettings,
  updateDesktopSetting,
} from './desktop-settings.js';
import { copyImageBytesToClipboard } from './manual-copy.js';
import { createServerManager } from './desktop/server-manager.js';
import { createSettingsStore } from './desktop/settings-store.js';
import { createAutoCopyController } from './desktop/auto-copy-controller.js';
import { downloadBatchToFolder } from './desktop/batch-download.js';
import { createDesktopShell } from './desktop/shell.js';

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
electronApp.setName('SnapOverLAN');

let serverState = 'offline';
let serverError = '';
let backgroundMode = false;
let autoCopyFirstPhoto = false;
let quitOperation = null;
let allowQuit = false;
let serverManager = null;
let autoCopyController = null;
let desktopShell = null;
const settingsStore = createSettingsStore({
  getSettingsPath: () => path.join(electronApp.getPath('userData'), 'desktop-settings.json'),
});

const getStartupLogPath = () => path.join(electronApp.getPath('userData'), 'startup.log');
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
  applyDesktopSettings(await settingsStore.load());
};

const saveSettings = async () => settingsStore.save(getDesktopSettings());

const getServerStatePayload = () => serverManager?.getState() || ({
  state: serverState,
  error: serverError,
  owned: false,
});

const sendDesktopState = () => {
  desktopShell?.send('desktop:state-changed', {
    server: getServerStatePayload(),
    backgroundMode,
  });
};

const handleServerStateChanged = (server) => {
  serverState = server.state;
  serverError = server.error;
  if (serverState !== 'online' && backgroundMode) {
    backgroundMode = false;
    saveSettings().catch((saveError) => {
      console.error('Could not save disabled background mode:', saveError);
    });
    desktopShell.openMainWindow().catch((openError) => console.error(openError));
    desktopShell.destroyTray();
  }
  desktopShell?.updateTrayMenu();
  sendDesktopState();
};

const sendAutoCopyResult = (result) => {
  if (!['copied', 'failed'].includes(result?.status)
    && typeof result?.message !== 'string') {
    return;
  }
  desktopShell?.send('desktop:auto-copy-result', {
    success: result.status === 'copied',
    filename: typeof result.filename === 'string' ? result.filename : '',
    message: typeof result.message === 'string' ? result.message : '',
    reason: typeof result.reason === 'string' ? result.reason : '',
  });
};

autoCopyController = createAutoCopyController({
  clipboard,
  getEnabled: () => autoCopyFirstPhoto,
  isOwnedServerProcess: (serverProcess) => serverManager?.isOwnedProcess(serverProcess),
  nativeImage,
  sendResult: sendAutoCopyResult,
  setEnabled: (enabled) => setAutoCopyFirstPhoto(enabled),
});

serverManager = createServerManager({
  electronApp,
  getAutoCopyEnabled: () => autoCopyFirstPhoto,
  getStartupLogPath,
  isQuitting: () => allowQuit,
  onAutoCopyUnavailable: (message) => sendAutoCopyResult({ status: 'failed', message }),
  onMessage: (serverProcess, message) => autoCopyController.handleServerMessage(serverProcess, message),
  onStateChanged: handleServerStateChanged,
  port: PORT,
  projectRoot,
  serverOrigin: SERVER_ORIGIN,
  serverPath,
  writeStartupLog,
});

const startServer = () => serverManager.start();
const stopServer = () => serverManager.stop();

desktopShell = createDesktopShell({
  BrowserWindow,
  Menu,
  Tray,
  appIconPath,
  getBackgroundMode: () => backgroundMode,
  getServerLaunchMode: () => serverManager.getLaunchMode(),
  getServerOnline: () => serverState === 'online',
  isQuitAllowed: () => allowQuit,
  onBackgroundToggle: (enabled) => setBackgroundMode(enabled).catch((error) => console.error(error)),
  onQuit: () => requestQuit(),
  onStateReady: sendDesktopState,
  port: PORT,
  preloadPath,
  rendererPath,
  shell,
  trayIconPath,
});

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
    desktopShell.createTray();
  } else {
    await desktopShell.openMainWindow();
    desktopShell.destroyTray();
  }
  desktopShell.updateTrayMenu();
  sendDesktopState();
  return backgroundMode;
}


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

  autoCopyController.log(`setting ${autoCopyFirstPhoto ? 'enabled' : 'disabled'}`);
  if (!autoCopyFirstPhoto) {
    serverManager.clearAutoCopyUnavailable();
  }
  sendDesktopState();
  if (
    autoCopyFirstPhoto
    && serverState === 'online'
    && !serverManager.getState().owned
  ) {
    await serverManager.ensureOwnedForAutoCopy();
  }
  return autoCopyFirstPhoto;
}

async function requestQuit() {
  if (quitOperation) {
    return quitOperation;
  }
  quitOperation = (async () => {
    const serverOperation = serverManager.getOperation();
    if (serverOperation) {
      await serverOperation.catch(() => {});
    }
    if (serverManager.isRunning()) {
      try {
        await stopServer();
      } catch (error) {
        console.error('Could not stop the SnapOverLAN server during quit:', error);
      }
    }
    desktopShell.destroyTray();
    allowQuit = true;
    electronApp.quit();
  })();
  return quitOperation;
}

const handleServerControl = async (operation) => {
  try {
    return await operation();
  } catch {
    return getServerStatePayload();
  }
};

ipcMain.handle('server:get-state', () => getServerStatePayload());
ipcMain.handle('server:retry', () => handleServerControl(() => startServer()));
ipcMain.handle('background:get', () => backgroundMode);
ipcMain.handle('background:set', (_event, enabled) => setBackgroundMode(enabled));
ipcMain.handle('batch:download', async (event, batchId) => {
  if (!desktopShell.isMainWindowSender(event.sender)) {
    throw new Error('Batch download request was rejected.');
  }
  const destinationDir = electronApp.getPath('downloads');
  const result = await downloadBatchToFolder({
    batchId,
    destinationDir,
    serverOrigin: SERVER_ORIGIN,
  });
  const openError = await shell.openPath(destinationDir);
  if (openError) console.warn('Could not open the Downloads folder:', openError);
  return result;
});
ipcMain.handle('image:copy', (event, imageBytes) => {
  if (!desktopShell.isMainWindowSender(event.sender)) {
    throw new Error('Image copy request was rejected.');
  }

  return copyImageBytesToClipboard({
    imageBytes,
    createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
    writeImage: (image) => clipboard.writeImage(image),
  });
});

const gotLock = electronApp.requestSingleInstanceLock();

if (!gotLock) {
  electronApp.quit();
} else {
  electronApp.on('second-instance', () => {
    desktopShell.openMainWindow().catch((error) => console.error(error));
  });

  electronApp.whenReady().then(async () => {
    await loadSettings();
    await desktopShell.createWindow();
    await startServer().catch((error) => {
      console.error('SnapOverLAN server startup failed:', error);
    });
    if (backgroundMode) {
      desktopShell.createTray();
    }
    desktopShell.showMainWindow();
  }).catch((error) => {
    dialog.showErrorBox('SnapOverLAN could not start', error.message || String(error));
    allowQuit = true;
    electronApp.quit();
  });

  electronApp.on('activate', () => {
    desktopShell.openMainWindow().catch((error) => console.error(error));
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
