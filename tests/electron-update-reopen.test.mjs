import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { normalizeDesktopSettings, updateDesktopSetting } from '../app/desktop-settings.js';
import { createDesktopShell } from '../app/desktop/shell.js';
import { createUpdateManager } from '../app/desktop/update-manager.js';
import {
  createUpdateDialogController,
  UPDATE_DIALOG_ACTION_CHANNEL,
} from '../app/desktop/update-dialog-controller.js';

const mainModuleUrl = new URL('../app/main.js', import.meta.url).href;
const mainSource = await readFile(new URL(mainModuleUrl), 'utf8');
// Run the real main-process wiring and shell with controlled Electron/IO boundaries.
const executableMain = mainSource
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replaceAll('import.meta.url', 'mainModuleUrl');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const createClock = () => {
  let now = 0;
  const timers = new Set();
  const scheduled = [];
  return {
    timers,
    scheduled,
    setInterval: (callback, interval) => {
      const timer = { callback, interval, due: now + interval, unref() {} };
      timers.add(timer);
      scheduled.push(timer);
      return timer;
    },
    clearInterval: (timer) => { timers.delete(timer); },
    advance: async (milliseconds) => {
      const target = now + milliseconds;
      while (timers.size) {
        const next = [...timers].sort((a, b) => a.due - b.due)[0];
        if (next.due > target) break;
        now = next.due;
        next.due += next.interval;
        next.callback();
        await flush();
      }
      now = target;
    },
  };
};

const createHarness = ({
  initialization = Promise.resolve(), initializationError = null, isPackaged = true,
} = {}) => {
  const ready = deferred();
  const clock = createClock();
  const windows = [];
  const trays = [];
  const errors = [];
  const warnings = [];
  const dialogStates = [];
  const handlers = new Map();
  let initializationCalls = 0;
  let checkCalls = 0;
  let activeChecks = 0;
  let maxActiveChecks = 0;
  let serverOptions;
  let state = { state: 'offline', error: '', owned: true };
  let checkImplementation = async () => ({ isUpdateAvailable: false });

  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {};
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    setMenuBarVisibility() {}
    async loadFile() {
      this.webContents.emit('did-finish-load');
      queueMicrotask(() => this.emit('ready-to-show'));
    }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) this.destroy();
    }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }

  class FakeTray extends EventEmitter {
    constructor() { super(); trays.push(this); }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
  }

  const updater = new EventEmitter();
  updater.quitAndInstall = () => {};
  updater.checkForUpdates = async () => {
    checkCalls += 1;
    activeChecks += 1;
    maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
    try { return await checkImplementation(); }
    finally { activeChecks -= 1; }
  };
  const manager = createUpdateManager({
    isPackaged, platform: 'win32', env: {}, updater,
    logger: { info() {}, warn() {} },
  });
  const electronApp = new EventEmitter();
  Object.assign(electronApp, {
    setName() {},
    getPath: () => '.',
    requestSingleInstanceLock: () => true,
    whenReady: () => ready.promise,
    quit: () => errors.push('unexpected quit'),
  });
  const changeServerState = (next) => {
    state = { ...state, state: next };
    serverOptions.onStateChanged(state);
  };
  const desktop = runInNewContext(`${executableMain}\ndesktopShell`, {
    mainModuleUrl, path, fileURLToPath, process: { platform: 'win32' },
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    console: {
      log() {}, warn: (...args) => warnings.push(args), error: (...args) => errors.push(args),
    },
    electronApp, BrowserWindow: FakeWindow, Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => template },
    clipboard: {}, nativeImage: {}, shell: {},
    dialog: { showErrorBox: (...args) => errors.push(args) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    normalizeDesktopSettings, updateDesktopSetting, createDesktopShell,
    createRendererServerClient: () => async () => ({}),
    createSettingsStore: () => ({
      load: async () => ({ backgroundMode: true }), save: async () => {},
    }),
    createAutoCopyController: () => ({}),
    createServerManager: (options) => {
      serverOptions = options;
      return {
        start: async () => changeServerState('online'),
        getState: () => state,
        getLaunchMode: () => 'owned',
      };
    },
    createElectronUpdateManager: async () => {
      initializationCalls += 1;
      await initialization;
      if (initializationError) throw initializationError;
      return manager;
    },
    createUpdateDialogController: (options) => {
      const controller = createUpdateDialogController(options);
      return {
        ...controller,
        handleState: (next) => {
          dialogStates.push(next);
          return controller.handleState(next);
        },
      };
    },
  });
  return {
    desktop, electronApp, updater, manager, windows, trays, errors, warnings, dialogStates,
    clock,
    get updateWindows() {
      return windows.filter((window) => window.options.title === 'SnapOverLAN Update');
    },
    ready: async () => { ready.resolve(); await flush(); },
    get checkCalls() { return checkCalls; },
    get maxActiveChecks() { return maxActiveChecks; },
    get initializationCalls() { return initializationCalls; },
    setCheck: (implementation) => { checkImplementation = implementation; },
    changeServerState,
    invoke: (name, ...args) => handlers.get(name)({}, ...args),
    rendererRefresh: () => {
      const sender = desktop.getMainWindow().webContents;
      return handlers.get('server:request')(
        { sender, senderFrame: sender.mainFrame }, '/api/server-status', 'GET',
      );
    },
  };
};

test('startup checks once and a second-instance shortcut reopen checks again', async () => {
  const app = createHarness();
  assert.equal(app.clock.timers.size, 0);
  await app.ready();
  assert.equal(app.checkCalls, 1);
  assert.equal(app.initializationCalls, 1);
  assert.equal(app.windows[0].visible, true);

  app.windows[0].close();
  await flush();
  assert.equal(app.windows[0].visible, false);
  assert.equal(app.checkCalls, 1);
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.windows[0].visible, true);
  assert.equal(app.windows.length, 1);
  assert.equal(app.checkCalls, 2);
  assert.equal(app.initializationCalls, 1);
  assert.deepEqual(app.errors, []);
  assert.equal(app.clock.scheduled.length, 1);
});

test('tray menu, tray double-click, activation, and explicit window creation check for updates', async () => {
  const app = createHarness();
  await app.ready();
  const tray = app.trays[0];
  const reopenActions = [
    () => tray.menu.find((item) => item.label === 'Open SnapOverLAN').click(),
    () => tray.emit('double-click'),
    () => app.electronApp.emit('activate'),
  ];
  for (const [index, reopen] of reopenActions.entries()) {
    app.windows[0].close();
    reopen();
    await flush();
    assert.equal(app.windows[0].visible, true);
    assert.equal(app.checkCalls, index + 2);
  }
  app.windows[0].destroy();
  await app.desktop.openMainWindow({ userInitiated: true });
  await flush();
  assert.equal(app.windows.length, 2);
  assert.equal(app.windows[1].visible, true);
  assert.equal(app.checkCalls, 5);
  assert.equal(app.clock.scheduled.length, 1);
  assert.deepEqual(app.errors, []);
});

test('simultaneous reopen requests reuse the update manager in-flight check', async () => {
  const app = createHarness();
  await app.ready();
  const pending = deferred();
  app.setCheck(() => pending.promise);
  app.electronApp.emit('second-instance');
  app.trays[0].emit('double-click');
  app.electronApp.emit('activate');
  await flush();
  assert.equal(app.checkCalls, 2);
  assert.equal(app.maxActiveChecks, 1);
  pending.resolve({ isUpdateAvailable: false });
  await flush();
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.checkCalls, 3);
  assert.equal(app.maxActiveChecks, 1);
});

test('reopens wait for pending updater initialization and share the startup check', async () => {
  const initialization = deferred();
  const app = createHarness({ initialization: initialization.promise });
  await app.ready();
  app.electronApp.emit('second-instance');
  app.trays[0].emit('double-click');
  await flush();
  assert.equal(app.initializationCalls, 1);
  assert.equal(app.checkCalls, 0);
  assert.equal(app.clock.timers.size, 0);
  initialization.resolve();
  await flush();
  assert.equal(app.checkCalls, 1);
  assert.equal(app.maxActiveChecks, 1);
  assert.equal(app.clock.scheduled.length, 1);
  assert.deepEqual(app.errors, []);
});

test('a second instance arriving before Electron readiness safely initializes the updater', async () => {
  const app = createHarness();
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.windows.length, 0);
  assert.equal(app.initializationCalls, 0);
  await app.ready();
  assert.equal(app.initializationCalls, 1);
  assert.ok(app.checkCalls >= 1);
  assert.equal(app.maxActiveChecks, 1);
  assert.deepEqual(app.errors, []);
});

test('renderer loads, server changes, background toggles, and internal tray updates never check', async () => {
  const app = createHarness();
  await app.ready();
  app.updater.emit('update-downloaded', { version: '9.0.0' });
  await flush();
  app.updateWindows[0].webContents.emit('ipc-message', {}, UPDATE_DIALOG_ACTION_CHANNEL, 'later');
  await flush();
  app.windows[0].close();
  app.windows[0].webContents.emit('did-finish-load');
  app.desktop.updateTrayMenu();
  app.desktop.createTray();
  await app.invoke('server:get-state');
  await app.rendererRefresh();
  await app.invoke('server:retry');
  await app.invoke('background:set', false);
  await app.invoke('background:set', true);
  app.windows[0].close();
  app.changeServerState('offline');
  await flush();
  assert.equal(app.windows[0].visible, true);
  assert.equal(app.checkCalls, 1);
  assert.equal(app.updateWindows.length, 1);
  assert.equal(app.updateWindows[0].isDestroyed(), true);
  assert.equal(app.clock.scheduled.length, 1);
  assert.deepEqual(app.errors, []);
});

for (const dismissal of ['later', 'close']) {
  test(`downloaded update dismissed with ${dismissal} reappears through every explicit open path`, async () => {
    const app = createHarness();
    await app.ready();
    app.updater.emit('update-downloaded', { version: '9.0.0' });
    await flush();
    assert.equal(app.updateWindows.length, 1);
    const reopenActions = [
      () => app.electronApp.emit('second-instance'),
      () => app.trays[0].menu.find((item) => item.label === 'Open SnapOverLAN').click(),
      () => app.trays[0].emit('double-click'),
      () => app.electronApp.emit('activate'),
    ];
    for (const [index, reopen] of reopenActions.entries()) {
      const popup = app.updateWindows.at(-1);
      assert.equal(popup.isVisible(), true);
      if (dismissal === 'close') popup.close();
      else popup.webContents.emit('ipc-message', {}, UPDATE_DIALOG_ACTION_CHANNEL, 'later');
      await flush();
      assert.equal(popup.isDestroyed(), true);
      app.updater.emit('update-downloaded', { version: '9.0.0' });
      await flush();
      assert.equal(app.updateWindows.length, index + 1);
      app.desktop.getMainWindow().close();
      assert.equal(app.desktop.getMainWindow().isVisible(), false);
      reopen();
      await flush();
      assert.equal(app.desktop.getMainWindow().isVisible(), true);
      assert.equal(app.updateWindows.length, index + 2);
      assert.equal(app.updateWindows.at(-1).options.parent, app.desktop.getMainWindow());
      assert.equal(app.updateWindows.filter((window) => !window.isDestroyed()).length, 1);
      assert.equal(app.checkCalls, 1);
    }
    app.updateWindows.at(-1).close();
    await flush();
    assert.deepEqual(app.errors, []);
    assert.deepEqual(app.warnings, []);
  });
}

test('simultaneous shortcut, tray, and activation opens share one downloaded-update dialog', async () => {
  const app = createHarness();
  await app.ready();
  app.updater.emit('update-downloaded', { version: '9.0.0' });
  await flush();
  app.updateWindows[0].close();
  await flush();
  app.desktop.getMainWindow().close();
  app.electronApp.emit('second-instance');
  app.trays[0].emit('double-click');
  app.electronApp.emit('activate');
  await flush();
  assert.equal(app.updateWindows.length, 2);
  assert.equal(app.updateWindows.filter((window) => !window.isDestroyed()).length, 1);
  app.updateWindows[1].close();
  await flush();
  assert.equal(app.updateWindows.length, 2);
  assert.equal(app.checkCalls, 1);
  assert.deepEqual(app.errors, []);
});

test('a check finishing after a fresh download was dismissed does not re-prompt', async () => {
  const app = createHarness();
  await app.ready();
  const pending = deferred();
  app.setCheck(() => pending.promise);
  app.electronApp.emit('second-instance');
  await flush();
  app.updater.emit('update-downloaded', { version: '9.0.0' });
  await flush();
  assert.equal(app.updateWindows.length, 1);
  app.updateWindows[0].webContents.emit('ipc-message', {}, UPDATE_DIALOG_ACTION_CHANNEL, 'later');
  await flush();
  pending.resolve({ isUpdateAvailable: true });
  await flush();
  assert.equal(app.updateWindows.length, 1);
  assert.equal(app.updateWindows[0].isDestroyed(), true);
  assert.equal(app.manager.getState().status, 'downloaded');
  assert.deepEqual(app.errors, []);
});

test('updater initialization and check failures do not prevent reopening the window', async () => {
  const failedInit = createHarness({ initializationError: new Error('load failed') });
  await failedInit.ready();
  failedInit.windows[0].close();
  failedInit.electronApp.emit('second-instance');
  await flush();
  assert.equal(failedInit.windows[0].visible, true);
  assert.equal(failedInit.checkCalls, 0);
  assert.equal(failedInit.warnings.length, 1);
  assert.deepEqual(failedInit.errors, []);

  const app = createHarness();
  await app.ready();
  app.setCheck(async () => { throw new Error('offline'); });
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.manager.getState().status, 'error');
  app.setCheck(async () => ({ isUpdateAvailable: false }));
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.checkCalls, 3);
  assert.equal(app.manager.getState().status, 'not-available');
  assert.deepEqual(app.errors, []);
});

test('updates found on reopen retain auto-download and forward readiness to the existing dialog', async () => {
  const app = createHarness();
  await app.ready();
  app.setCheck(async () => ({ isUpdateAvailable: true, updateInfo: { version: '9.0.0' } }));
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.manager.getState().status, 'available');
  assert.equal(app.updater.autoDownload, true);
  app.updater.emit('download-progress', { percent: 50 });
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.checkCalls, 2);
  app.updater.emit('update-downloaded', { version: '9.0.0' });
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.checkCalls, 2);
  assert.equal(app.manager.isInstallationReady(), true);
  assert.equal(app.dialogStates.at(-1).status, 'downloaded');
  assert.equal(app.dialogStates.at(-1).version, '9.0.0');
});

test('periodic checks start at 12 hours and continue at subsequent intervals in background mode', async () => {
  const app = createHarness();
  await app.ready();
  assert.equal(app.checkCalls, 1);
  assert.equal(app.clock.scheduled.length, 1);
  const { interval } = app.clock.scheduled[0];
  assert.equal(interval, 43_200_000);
  app.desktop.getMainWindow().close();
  await app.clock.advance(interval - 1);
  assert.equal(app.checkCalls, 1);
  await app.clock.advance(1);
  assert.equal(app.checkCalls, 2);
  await app.clock.advance(interval);
  assert.equal(app.checkCalls, 3);
  await app.clock.advance(interval);
  assert.equal(app.checkCalls, 4);
  assert.equal(app.desktop.getMainWindow().isVisible(), false);
  assert.equal(app.clock.scheduled.length, 1);
  assert.deepEqual(app.errors, []);
});

test('periodic ticks share pending startup and reopen checks without overlap', async () => {
  const app = createHarness();
  const startup = deferred();
  app.setCheck(() => startup.promise);
  await app.ready();
  const { interval } = app.clock.scheduled[0];
  await app.clock.advance(interval * 2);
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.checkCalls, 1);
  startup.resolve({ isUpdateAvailable: false });
  await flush();

  const periodic = deferred();
  app.setCheck(() => periodic.promise);
  await app.clock.advance(interval);
  app.trays[0].emit('double-click');
  await app.clock.advance(interval);
  assert.equal(app.checkCalls, 2);
  assert.equal(app.maxActiveChecks, 1);
  periodic.resolve({ isUpdateAvailable: false });
  await flush();
  app.setCheck(async () => ({ isUpdateAvailable: false }));
  await app.clock.advance(interval);
  assert.equal(app.checkCalls, 3);
  assert.equal(app.clock.scheduled.length, 1);
});

test('a failed periodic check is contained and later intervals still check', async () => {
  const app = createHarness();
  await app.ready();
  const { interval } = app.clock.scheduled[0];
  app.setCheck(async () => { throw new Error('network unavailable'); });
  await app.clock.advance(interval);
  assert.equal(app.checkCalls, 2);
  assert.equal(app.manager.getState().status, 'error');
  app.setCheck(async () => ({ isUpdateAvailable: false }));
  await app.clock.advance(interval);
  assert.equal(app.checkCalls, 3);
  assert.equal(app.manager.getState().status, 'not-available');
  assert.equal(app.clock.timers.size, 1);
  assert.deepEqual(app.errors, []);
});

test('periodic downloads prompt normally but ticks preserve downloads and Later dismissal', async () => {
  const app = createHarness();
  await app.ready();
  const { interval } = app.clock.scheduled[0];
  app.setCheck(async () => ({ isUpdateAvailable: true, updateInfo: { version: '9.0.0' } }));
  await app.clock.advance(interval);
  assert.equal(app.checkCalls, 2);
  assert.equal(app.updater.autoDownload, true);
  app.updater.emit('download-progress', { percent: 50 });
  const downloading = app.manager.getState();
  await app.clock.advance(interval * 2);
  assert.equal(app.manager.getState(), downloading);
  assert.equal(app.checkCalls, 2);
  assert.equal(app.updateWindows.length, 0);

  app.updater.emit('update-downloaded', { version: '9.0.0' });
  await flush();
  assert.equal(app.updateWindows.length, 1);
  const downloaded = app.manager.getState();
  app.updateWindows[0].webContents.emit('ipc-message', {}, UPDATE_DIALOG_ACTION_CHANNEL, 'later');
  await flush();
  await app.clock.advance(interval * 2);
  assert.equal(app.manager.getState(), downloaded);
  assert.equal(app.checkCalls, 2);
  assert.equal(app.updateWindows.length, 1);
  assert.equal(app.updateWindows[0].isDestroyed(), true);

  app.desktop.getMainWindow().close();
  app.electronApp.emit('second-instance');
  await flush();
  assert.equal(app.updateWindows.length, 2);
  assert.equal(app.updateWindows[1].isVisible(), true);
  app.updateWindows[1].close();
  await flush();
});

test('quitting clears the periodic timer and queued ticks cannot restart checks', async () => {
  const app = createHarness();
  await app.ready();
  const timer = app.clock.scheduled[0];
  // Queue a callback immediately before disposal as well as after it.
  timer.callback();
  app.electronApp.emit('will-quit');
  await flush();
  assert.equal(app.clock.timers.size, 0);
  assert.equal(app.manager.isEnabled(), false);
  timer.callback();
  await app.clock.advance(timer.interval * 2);
  await flush();
  assert.equal(app.checkCalls, 1);
  assert.equal(app.clock.scheduled.length, 1);
});

test('quitting during updater initialization prevents a late timer or startup check', async () => {
  const initialization = deferred();
  const app = createHarness({ initialization: initialization.promise });
  await app.ready();
  app.electronApp.emit('will-quit');
  initialization.resolve();
  await flush();
  assert.equal(app.clock.scheduled.length, 0);
  assert.equal(app.checkCalls, 0);
  assert.equal(app.manager.isEnabled(), false);
});

test('disabled or failed updater initialization does not schedule periodic checks', async () => {
  for (const options of [{ isPackaged: false }, { initializationError: new Error('load failed') }]) {
    const app = createHarness(options);
    await app.ready();
    app.electronApp.emit('second-instance');
    await flush();
    assert.equal(app.clock.scheduled.length, 0);
    assert.equal(app.checkCalls, 0);
  }
});
