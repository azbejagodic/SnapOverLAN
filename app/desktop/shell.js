const createDesktopShell = ({
  BrowserWindow,
  Menu,
  Tray,
  appIconPath,
  getBackgroundMode,
  getServerLaunchMode,
  getServerOnline,
  isQuitAllowed,
  onBackgroundToggle,
  onQuit,
  onStateReady,
  port,
  preloadPath,
  rendererPath,
  shell,
  trayIconPath,
}) => {
  let mainWindow = null;
  let tray = null;

  const isLocalAppUrl = (targetUrl) => {
    try {
      const parsed = new URL(targetUrl);
      return ['127.0.0.1', 'localhost'].includes(parsed.hostname)
        && parsed.port === String(port);
    } catch {
      return false;
    }
  };

  const send = (channel, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.webContents.send(channel, payload);
    return true;
  };

  const isMainWindowSender = (sender) => Boolean(
    mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents,
  );

  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return true;
  };

  const updateTrayMenu = () => {
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open SnapOverLAN', click: () => openMainWindow() },
      { type: 'separator' },
      {
        label: `Background Mode: ${getBackgroundMode() ? 'On' : 'Off'}`,
        enabled: getServerOnline(),
        click: () => onBackgroundToggle(!getBackgroundMode()),
      },
      { type: 'separator' },
      { label: 'Quit', click: onQuit },
    ]));
  };

  const createWindow = async () => {
    mainWindow = new BrowserWindow({
      show: false,
      width: 500,
      height: 580,
      minWidth: 460,
      minHeight: 540,
      resizable: true,
      title: 'SnapOverLAN',
      icon: appIconPath,
      backgroundColor: '#343940',
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#343940',
        symbolColor: '#f5fdff',
        height: 32,
      },
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
      if (isQuitAllowed()) return;
      event.preventDefault();
      if (getBackgroundMode()) {
        mainWindow.hide();
        return;
      }
      onQuit();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.on('did-finish-load', onStateReady);
    await mainWindow.loadFile(rendererPath, {
      query: { launcher: 'electron', server: getServerLaunchMode() },
    });
  };

  async function openMainWindow() {
    if (showMainWindow()) return;
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
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };

  return {
    createTray,
    createWindow,
    destroyTray,
    isMainWindowSender,
    openMainWindow,
    send,
    showMainWindow,
    updateTrayMenu,
  };
};

export { createDesktopShell };
