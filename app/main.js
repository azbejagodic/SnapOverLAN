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
import { createServerManager } from './desktop/server-manager.js';
import { createSettingsStore } from './desktop/settings-store.js';
import { createAutoCopyController } from './desktop/auto-copy-controller.js';
import { downloadBatchToFolder } from './desktop/batch-download.js';
import { createDesktopShell } from './desktop/shell.js';
import { createRendererServerClient } from './desktop/renderer-server-client.js';
import { createUpdateDialogController } from './desktop/update-dialog-controller.js';
import { createElectronUpdateManager } from './desktop/update-manager.js';
import { configurePortableFirewall } from './desktop/portable-firewall.js';
import { getWindowsNetworkProfile, openWindowsNetworkSettings } from './desktop/windows-network-profile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const serverPath = path.join(__dirname, 'server', 'index.js');
const rendererPath = path.join(__dirname, 'renderer', 'index.html');
const preloadPath = path.join(__dirname, 'preload.cjs');
const appIconPath = path.join(projectRoot, 'assets', 'electron', 'app-512.png');
const trayIconPath = path.join(projectRoot, 'assets', 'electron', 'tray-24.png');

const PORT = 8787;
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const SERVER_ORIGIN = `http://localhost:${PORT}`;
const rendererServerRequest = createRendererServerClient({ serverOrigin: SERVER_ORIGIN });
electronApp.setName('SnapOverLAN');

let serverState = 'offline';
let serverError = '';
let backgroundMode = false;
let autoCopyFirstPhoto = false;
let skippedUpdateVersion = '';
let quitOperation = null;
const activeBatchExports = new Set();
let allowQuit = false;
let serverManager = null;
let autoCopyController = null;
let desktopShell = null;
let updateManager = null;
let updateManagerInitialization = null;
let updateCheckTimer = null;
let updaterDisposed = false;
let removeUpdateStateListener = null;
let updateDialogController = null;
const settingsStore = createSettingsStore({
  getSettingsPath: () => path.join(electronApp.getPath('userData'), 'desktop-settings.json'),
});

const getStartupLogPath = () => path.join(electronApp.getPath('userData'), 'startup.log');

const getDesktopSettings = () => ({
  backgroundMode,
  autoCopyFirstPhoto,
  skippedUpdateVersion,
});

const applyDesktopSettings = (settings) => {
  const normalized = normalizeDesktopSettings(settings);
  backgroundMode = normalized.backgroundMode;
  autoCopyFirstPhoto = normalized.autoCopyFirstPhoto;
  skippedUpdateVersion = normalized.skippedUpdateVersion;
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

const initializeUpdateManager = () => {
  if (updateManagerInitialization) return updateManagerInitialization;
  updateManagerInitialization = (async () => {
    updateManager = await createElectronUpdateManager({
      electronApp,
      logger: {
        info: (message) => {
          console.log('SnapOverLAN updater:', message);
        },
        warn: (message) => {
          console.warn('SnapOverLAN updater:', message);
        },
      },
    });
    if (updaterDisposed) {
      updateManager.dispose();
      return;
    }
    updateDialogController = createUpdateDialogController({
      BrowserWindow,
      dialog,
      getMainWindow: () => desktopShell.getMainWindow(),
      getSkippedVersion: () => skippedUpdateVersion,
      saveSkippedVersion: async (version) => {
        const previousVersion = skippedUpdateVersion;
        skippedUpdateVersion = version;
        try { await saveSettings(); }
        catch (error) {
          skippedUpdateVersion = previousVersion;
          throw error;
        }
      },
      logger: {
        warn: (message) => console.warn('SnapOverLAN updater:', message),
      },
      requestInstall: (parent) => (
        updateManager?.isInstallationReady()
          ? requestQuit({ installUpdate: true, warningParent: parent })
          : false
      ),
    });
    removeUpdateStateListener = updateManager.onStateChanged((state) => {
      void updateDialogController.handleState(state);
    });
    void updateDialogController.handleState(updateManager.getState());
    if (updateManager.isEnabled()) {
      // Periodic checks preserve process dismissal state, including in the tray.
      updateCheckTimer = setInterval(() => { void checkForUpdates({ periodic: true }); }, UPDATE_CHECK_INTERVAL_MS);
      updateCheckTimer.unref();
    }
  })().catch(() => {
    console.warn('SnapOverLAN updater: Initialization failed without affecting application startup.');
  });
  return updateManagerInitialization;
};

const checkForUpdates = async ({ userInitiated = false, periodic = false } = {}) => {
  try {
    if (updaterDisposed) return;
    await initializeUpdateManager();
    if (updaterDisposed) return;
    // Inspect readiness before checking: a fresh download uses the state listener,
    // and dismissing it must not trigger a second prompt when the check completes.
    if (userInitiated && updateManager) {
      void updateDialogController?.handleUserOpen(updateManager.getState());
    }
    await updateManager?.checkForUpdates({ checkDownloaded: periodic || userInitiated });
  } catch {
    console.warn('SnapOverLAN updater: An unexpected update check failure was contained.');
  }
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

const showUploadBlockedWarning = async ({ installUpdate = false, parent = desktopShell?.getMainWindow() } = {}) => {
  const options = {
    type: 'warning',
    title: 'Upload in progress',
    message: installUpdate
      ? 'An upload is still in progress. Wait for it to finish before restarting and updating SnapOverLAN.'
      : 'An upload is still in progress. Wait for it to finish before closing SnapOverLAN.',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options);
  else await dialog.showMessageBox(options);
};

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
const stopServer = () => serverManager.stop({ onlyIfIdle: true });

desktopShell = createDesktopShell({
  BrowserWindow,
  Menu,
  Tray,
  appIconPath,
  getBackgroundMode: () => backgroundMode,
  getServerOnline: () => serverState === 'online',
  isQuitAllowed: () => allowQuit,
  onBackgroundToggle: (enabled) => setBackgroundMode(enabled).catch((error) => console.error(error)),
  onQuit: () => requestQuit(),
  onStateReady: sendDesktopState,
  onUserOpen: () => { void checkForUpdates({ userInitiated: true }); },
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

async function requestQuit({ installUpdate = false, warningParent } = {}) {
  if (quitOperation) {
    return quitOperation;
  }
  const operation = (async () => {
    await Promise.allSettled(activeBatchExports);
    if (installUpdate) {
      console.log('SnapOverLAN updater: Update install requested; cleanup starting.');
    }
    const serverOperation = serverManager.getOperation();
    if (serverOperation) {
      await serverOperation.catch(() => {});
    }
    if (serverManager.isRunning()) {
      try {
        const result = await stopServer();
        if (result?.uploadBlocked) {
          await showUploadBlockedWarning({ installUpdate, parent: warningParent });
          return installUpdate ? 'upload-blocked' : false;
        }
      } catch (error) {
        console.error('Could not stop the SnapOverLAN server during quit:', error);
        return false;
      }
    }
    desktopShell.destroyTray();
    allowQuit = true;
    if (installUpdate) {
      console.log('SnapOverLAN updater: Cleanup completed; handing off to quitAndInstall.');
      const installStarted = updateManager?.installDownloadedUpdate() === true;
      if (installStarted) return true;

      allowQuit = false;
      console.error('SnapOverLAN updater: The downloaded update could not start installing.');
      return false;
    }
    electronApp.quit();
    return true;
  })();
  quitOperation = operation;
  const result = await operation;
  if (result !== true && quitOperation === operation) {
    quitOperation = null;
  }
  return result;
}

const handleServerControl = async (operation) => {
  try {
    return await operation();
  } catch {
    return getServerStatePayload();
  }
};

const assertMainWindowFrame = (event, message = 'IPC request was rejected.') => {
  if (!desktopShell.isMainWindowSender(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error(message);
  }
};

let networkSettingsAdapterType = null;

ipcMain.handle('server:get-state', (event) => {
  assertMainWindowFrame(event);
  return getServerStatePayload();
});
ipcMain.handle('server:request', (event, resourcePath, method) => {
  assertMainWindowFrame(event, 'Server request was rejected.');
  return rendererServerRequest(resourcePath, method);
});
ipcMain.handle('server:retry', (event) => {
  assertMainWindowFrame(event);
  return handleServerControl(() => startServer());
});
ipcMain.handle('network:get-profile', async (event, address) => {
  assertMainWindowFrame(event);
  let detectedAdapterType = null;
  const profile = await getWindowsNetworkProfile(address, {
    onAdapterDetected: (adapterType) => { detectedAdapterType = adapterType; },
  });
  networkSettingsAdapterType = detectedAdapterType;
  return profile;
});
ipcMain.handle('network:open-settings', (event) => {
  assertMainWindowFrame(event);
  return openWindowsNetworkSettings({ shell, adapterType: networkSettingsAdapterType });
});
ipcMain.handle('background:get', (event) => {
  assertMainWindowFrame(event);
  return backgroundMode;
});
ipcMain.handle('background:set', (event, enabled) => {
  assertMainWindowFrame(event);
  return setBackgroundMode(enabled);
});
ipcMain.handle('batch:download', async (event, batchId) => {
  assertMainWindowFrame(event, 'Batch download request was rejected.');
  if (quitOperation || allowQuit) throw new Error('SnapOverLAN is quitting. Please try again after reopening it.');
  const destinationDir = electronApp.getPath('downloads');
  const operation = downloadBatchToFolder({
    batchId,
    destinationDir,
    serverOrigin: SERVER_ORIGIN,
  });
  activeBatchExports.add(operation);
  try {
    const result = await operation;
    const openError = await shell.openPath(destinationDir);
    if (openError) console.warn('Could not open the Downloads folder:', openError);
    return result;
  } finally {
    activeBatchExports.delete(operation);
  }
});

const gotLock = electronApp.requestSingleInstanceLock();

if (!gotLock) {
  electronApp.quit();
} else {
  electronApp.on('second-instance', () => {
    electronApp.whenReady()
      .then(() => desktopShell.openMainWindow({ userInitiated: true }))
      .catch((error) => console.error(error));
  });

  electronApp.whenReady().then(async () => {
    await loadSettings();
    const portableFirewall = await configurePortableFirewall({ electronApp });
    if (portableFirewall.reason === 'configuration-failed') {
      console.warn('SnapOverLAN portable firewall configuration was not completed.');
    }
    await startServer().catch((error) => {
      console.error('SnapOverLAN server startup failed:', error);
    });
    await desktopShell.createWindow();
    if (backgroundMode) {
      desktopShell.createTray();
    }
    desktopShell.showMainWindow();
    void checkForUpdates();
  }).catch((error) => {
    dialog.showErrorBox('SnapOverLAN could not start', error.message || String(error));
    allowQuit = true;
    electronApp.quit();
  });

  electronApp.on('activate', () => {
    desktopShell.openMainWindow({ userInitiated: true }).catch((error) => console.error(error));
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

  electronApp.on('will-quit', () => {
    updaterDisposed = true;
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
    removeUpdateStateListener?.();
    removeUpdateStateListener = null;
    updateDialogController?.dispose();
    updateDialogController = null;
    updateManager?.dispose();
  });
}
