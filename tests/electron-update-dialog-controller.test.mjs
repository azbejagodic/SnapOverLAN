import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INSTALL_ERROR_DIALOG_OPTIONS,
  UPDATE_DIALOG_ACTION_CHANNEL,
  createUpdateDialogController,
} from '../app/desktop/update-dialog-controller.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererPath = path.join(projectRoot, 'app', 'renderer', 'update-dialog.html');
const preloadPath = path.join(projectRoot, 'app', 'desktop', 'update-dialog-preload.cjs');

const downloadedState = (version = '2.0.1') => ({
  status: 'downloaded',
  version,
});

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.focused = false;
    this.loadCalls = [];
    this.menuBarVisible = true;
    this.shown = false;
    FakeBrowserWindow.instances.push(this);
  }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }

  destroy() {
    this.close();
  }

  focus() {
    this.focused = true;
  }

  isDestroyed() {
    return this.destroyed;
  }

  loadFile(...args) {
    this.loadCalls.push(args);
    queueMicrotask(() => this.emit('ready-to-show'));
    return Promise.resolve();
  }

  setMenuBarVisibility(visible) {
    this.menuBarVisible = visible;
  }

  show() {
    this.shown = true;
  }
}

class FakeDialog {
  constructor(responses = [0]) {
    this.calls = [];
    this.responses = [...responses];
  }

  showMessageBox(...args) {
    this.calls.push(args);
    return Promise.resolve({ response: this.responses.shift() ?? 0 });
  }
}

const createController = ({
  dialog = new FakeDialog(),
  getMainWindow = () => null,
  logger = { warn() {} },
  requestInstall = async () => true,
} = {}) => {
  FakeBrowserWindow.instances = [];
  return {
    controller: createUpdateDialogController({
      BrowserWindow: FakeBrowserWindow,
      dialog,
      getMainWindow,
      logger,
      preloadPath,
      rendererPath,
      requestInstall,
    }),
    dialog,
  };
};

const waitForWindow = async (index = 0) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (FakeBrowserWindow.instances[index]) return FakeBrowserWindow.instances[index];
    await Promise.resolve();
  }
  throw new Error('The update window was not created.');
};

const choose = (window, action) => {
  window.webContents.emit('ipc-message', {}, UPDATE_DIALOG_ACTION_CHANNEL, action);
};

test('a downloaded update shows a secure SnapOverLAN-styled modal owned by a visible window', async () => {
  const owner = {
    isDestroyed: () => false,
    isVisible: () => true,
  };
  const { controller } = createController({ getMainWindow: () => owner });

  const prompt = controller.handleState(downloadedState());
  const window = await waitForWindow();
  await Promise.resolve();

  assert.equal(window.options.parent, owner);
  assert.equal(window.options.modal, true);
  assert.equal(window.options.title, 'SnapOverLAN Update');
  assert.equal(window.options.width, 412);
  assert.equal(window.options.height, 247);
  assert.equal(window.options.backgroundColor, '#343940');
  assert.equal(window.options.resizable, false);
  assert.equal(window.options.titleBarStyle, 'hidden');
  assert.equal(window.options.titleBarOverlay.color, '#343940');
  assert.deepEqual(window.options.webPreferences, {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
  assert.deepEqual(window.loadCalls, [[rendererPath, { query: { version: '2.0.1' } }]]);
  assert.equal(window.menuBarVisible, false);
  assert.equal(window.webContents.windowOpenHandler().action, 'deny');
  assert.equal(window.shown, true);
  assert.equal(window.focused, true);

  choose(window, 'later');
  assert.equal(await prompt, false);
});

test('a hidden main window uses a non-modal update window without showing the app window', async () => {
  const owner = {
    isDestroyed: () => false,
    isVisible: () => false,
  };
  const { controller } = createController({ getMainWindow: () => owner });

  const prompt = controller.handleState(downloadedState());
  const window = await waitForWindow();

  assert.equal(window.options.parent, undefined);
  assert.equal(window.options.modal, false);
  choose(window, 'later');
  await prompt;
});

test('duplicate downloaded states share one prompt and one session decision', async () => {
  let installCalls = 0;
  const { controller } = createController({
    requestInstall: async () => { installCalls += 1; return true; },
  });

  const firstPrompt = controller.handleState(downloadedState());
  const duplicatePrompt = controller.handleState(downloadedState());
  assert.equal(firstPrompt, duplicatePrompt);

  const window = await waitForWindow();
  assert.equal(FakeBrowserWindow.instances.length, 1);
  choose(window, 'later');
  await firstPrompt;
  await controller.handleState(downloadedState());

  assert.equal(FakeBrowserWindow.instances.length, 1);
  assert.equal(installCalls, 0);
});

test('Later and closing the window do not request installation', async () => {
  let installCalls = 0;
  const { controller } = createController({
    requestInstall: async () => { installCalls += 1; return true; },
  });

  const laterPrompt = controller.handleState(downloadedState('2.0.1'));
  choose(await waitForWindow(), 'later');
  assert.equal(await laterPrompt, false);

  const closedPrompt = controller.handleState(downloadedState('2.0.2'));
  (await waitForWindow(1)).close();
  assert.equal(await closedPrompt, false);
  assert.equal(installCalls, 0);
});

test('Restart & Update requests the existing installation path only once', async () => {
  let installCalls = 0;
  const { controller } = createController({
    requestInstall: async () => { installCalls += 1; return true; },
  });

  const prompt = controller.handleState(downloadedState());
  const window = await waitForWindow();
  choose(window, 'restart');

  assert.equal(await prompt, true);
  choose(window, 'restart');
  await controller.handleState(downloadedState());
  assert.equal(installCalls, 1);
  assert.equal(FakeBrowserWindow.instances.length, 1);
});

test('an explicit installation failure keeps the sanitized native error fallback', async () => {
  const dialog = new FakeDialog([0]);
  const { controller } = createController({
    dialog,
    requestInstall: async () => false,
  });

  const prompt = controller.handleState(downloadedState());
  choose(await waitForWindow(), 'restart');

  assert.equal(await prompt, false);
  assert.equal(dialog.calls.length, 1);
  assert.deepEqual(dialog.calls[0], [INSTALL_ERROR_DIALOG_OPTIONS]);
  assert.equal(dialog.calls[0][0].message, 'The update could not be installed.');
  assert.equal(dialog.calls[0][0].detail, 'Please restart SnapOverLAN and try again.');
});

test('ordinary checking, updater errors, and unsafe versions never create a window', async () => {
  const { controller } = createController();

  await controller.handleState({ status: 'checking', version: '' });
  await controller.handleState({
    status: 'error',
    version: '',
    message: 'Could not reach the update service.',
  });
  await controller.handleState(downloadedState('<script>'));

  assert.equal(FakeBrowserWindow.instances.length, 0);
});

test('the popup renderer matches existing UI tokens and exposes only a narrow action bridge', async () => {
  const [html, css, renderer, preload, controller] = await Promise.all([
    readFile(rendererPath, 'utf8'),
    readFile(path.join(projectRoot, 'app', 'renderer', 'update-dialog.css'), 'utf8'),
    readFile(path.join(projectRoot, 'app', 'renderer', 'update-dialog.js'), 'utf8'),
    readFile(preloadPath, 'utf8'),
    readFile(path.join(projectRoot, 'app', 'desktop', 'update-dialog-controller.js'), 'utf8'),
  ]);

  assert.match(html, /<h1 id="updateTitle">Update ready!<\/h1>/);
  assert.match(html, /A new version of SnapOverLAN is ready to install\./);
  assert.match(html, />Later<\/button>/);
  assert.match(html, />Restart &amp; Update<\/button>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(css, /--bg: #343940/);
  assert.match(css, /--radius-lg: 22px/);
  assert.match(css, /\.titlebar-drag-region\s*\{[^}]*background: var\(--bg\)/s);
  assert.match(css, /body\s*\{[^}]*background: var\(--bg\)/s);
  assert.doesNotMatch(css, /--bg-deep/);
  assert.match(css, /inter-latin-variable\.woff2/);
  assert.match(css, /linear-gradient\(145deg, #c7f7ff, #91e4f2\)/);
  assert.match(renderer, /Restart now to update to version \$\{normalizedVersion\}\./);
  assert.match(renderer, /chooseAction\('later'\)/);
  assert.match(renderer, /chooseAction\('restart'\)/);
  assert.match(renderer, /restartButton\.focus\(\)/);
  assert.doesNotMatch(renderer, /laterButton\.focus\(\)/);
  assert.match(preload, /ALLOWED_ACTIONS = new Set\(\['later', 'restart'\]\)/);
  assert.match(preload, /ipcRenderer\.send\(UPDATE_DIALOG_ACTION_CHANNEL, action\)/);
  assert.doesNotMatch(preload, /autoUpdater|checkForUpdates|quitAndInstall|update-manager/);
  assert.doesNotMatch(controller, /ipcMain|contextBridge|ipcRenderer/);
});
