import { fileURLToPath } from 'node:url';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const UPDATE_DIALOG_ACTION_CHANNEL = 'snapoverlan:update-dialog-action';
const DEFAULT_PRELOAD_PATH = fileURLToPath(new URL('./update-dialog-preload.cjs', import.meta.url));
const DEFAULT_RENDERER_PATH = fileURLToPath(new URL('../renderer/update-dialog.html', import.meta.url));

const READY_WINDOW_OPTIONS = ({ parent = null, preloadPath = DEFAULT_PRELOAD_PATH } = {}) => {
  const options = {
    show: false,
    width: 412,
    height: 247,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    modal: Boolean(parent),
    title: 'SnapOverLAN Update',
    backgroundColor: '#343940',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#343940',
      symbolColor: '#f5fdff',
      height: 32,
    },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (parent) options.parent = parent;
  return options;
};

const INSTALL_ERROR_DIALOG_OPTIONS = Object.freeze({
  type: 'error',
  title: 'SnapOverLAN Update',
  message: 'The update could not be installed.',
  detail: 'Please restart SnapOverLAN and try again.',
  buttons: ['OK'],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

const createUpdateDialogController = ({
  BrowserWindow,
  dialog,
  getMainWindow = () => null,
  logger = console,
  preloadPath = DEFAULT_PRELOAD_PATH,
  rendererPath = DEFAULT_RENDERER_PATH,
  requestInstall,
  getSkippedVersion = () => '',
  saveSkippedVersion = async () => {},
} = {}) => {
  const promptedVersions = new Set();
  let activePrompt = null;
  let activeWindow = null;
  let installStarted = false;
  let disposed = false;

  const warn = (message) => {
    try {
      logger?.warn?.(message);
    } catch {}
  };

  const getVisibleMainWindow = () => {
    const mainWindow = getMainWindow?.();
    return (
      mainWindow
      && !mainWindow.isDestroyed?.()
      && mainWindow.isVisible?.()
    ) ? mainWindow : null;
  };

  const showMessageBox = (options) => {
    const mainWindow = getVisibleMainWindow();
    return mainWindow
      ? dialog.showMessageBox(mainWindow, options)
      : dialog.showMessageBox(options);
  };

  const showInstallError = async () => {
    try {
      await showMessageBox(INSTALL_ERROR_DIALOG_OPTIONS);
    } catch {
      warn('The update installation error dialog could not be shown.');
    }
  };

  const showReadyWindow = (version) => new Promise((resolve, reject) => {
    const parent = getVisibleMainWindow();
    let updateWindow;
    let settled = false;
    let requestingInstall = false;

    const settle = (response, closeWindow = true) => {
      if (settled) return;
      settled = true;
      if (activeWindow === updateWindow) activeWindow = null;
      resolve({ response });
      if (closeWindow && updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.close();
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (activeWindow === updateWindow) activeWindow = null;
      if (updateWindow && !updateWindow.isDestroyed()) updateWindow.destroy();
      reject(error);
    };

    try {
      updateWindow = new BrowserWindow(READY_WINDOW_OPTIONS({ parent, preloadPath }));
      activeWindow = updateWindow;
      updateWindow.setMenuBarVisibility(false);
      updateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      updateWindow.webContents.on('will-navigate', (event) => event.preventDefault());
      updateWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
      updateWindow.webContents.on('ipc-message', (_event, channel, action) => {
        if (channel !== UPDATE_DIALOG_ACTION_CHANNEL || settled || requestingInstall) return;
        if (action === 'later') settle(0);
        if (action === 'skip') {
          requestingInstall = true;
          void (async () => {
            try {
              await saveSkippedVersion(version);
              requestingInstall = false;
              settle(0);
            } catch {
              warn('The skipped update version could not be saved.');
              await showMessageBox({
                type: 'error', title: 'SnapOverLAN Update',
                message: 'This version could not be skipped.',
                detail: 'Please try again. Later dismisses it for this session.',
                buttons: ['OK'], noLink: true,
              });
            }
          })().catch(() => warn('The update preference error dialog could not be shown.'))
            .finally(() => { requestingInstall = false; });
        }
        if (action === 'restart') {
          requestingInstall = true;
          void (async () => {
            let result;
            try { result = await requestInstall?.(updateWindow); }
            catch { warn('The update installation request failed.'); }
            if (result === 'upload-blocked') return;
            installStarted = result === true;
            requestingInstall = false;
            settle(installStarted ? 1 : 0);
            if (!installStarted) await showInstallError();
          })().finally(() => { requestingInstall = false; });
        }
      });
      updateWindow.once('ready-to-show', () => {
        if (disposed || updateWindow.isDestroyed()) return;
        updateWindow.show();
        updateWindow.focus();
      });
      updateWindow.on('close', (event) => {
        if (requestingInstall) event.preventDefault();
      });
      updateWindow.once('closed', () => settle(0, false));
      Promise.resolve(updateWindow.loadFile(rendererPath, {
        query: { version },
      })).catch(fail);
    } catch (error) {
      fail(error);
    }
  });

  const promptDownloadedUpdate = (state, { userInitiated = false, manualCheck = false } = {}) => {
    const version = typeof state?.version === 'string' && VERSION_PATTERN.test(state.version)
      ? state.version
      : '';
    if (
      disposed
      || installStarted
      || activePrompt
      || state?.status !== 'downloaded'
      || !version
      || (!manualCheck && getSkippedVersion() === version)
      || (!userInitiated && promptedVersions.has(version))
    ) {
      return activePrompt || Promise.resolve(false);
    }

    promptedVersions.add(version);
    const operation = Promise.resolve()
      .then(() => showReadyWindow(version))
      .then((result) => result?.response === 1)
      .catch(() => {
        warn('The update-ready dialog could not be shown.');
        return false;
      })
      .finally(() => {
        if (activePrompt === operation) activePrompt = null;
      });
    activePrompt = operation;
    return operation;
  };

  return Object.freeze({
    dispose: () => {
      disposed = true;
      if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
      activeWindow = null;
    },
    // Tray/window opens are part of the same process session, not manual checks.
    handleState: (state) => promptDownloadedUpdate(state),
    handleUserOpen: (state) => promptDownloadedUpdate(state),
    handleManualCheck: (state) => promptDownloadedUpdate(state, { userInitiated: true, manualCheck: true }),
  });
};

export {
  INSTALL_ERROR_DIALOG_OPTIONS,
  READY_WINDOW_OPTIONS,
  UPDATE_DIALOG_ACTION_CHANNEL,
  createUpdateDialogController,
};
