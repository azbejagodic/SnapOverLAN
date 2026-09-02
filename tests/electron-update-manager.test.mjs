import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  UPDATE_STATUSES,
  createElectronUpdateManager,
  createUpdateManager,
} from '../app/desktop/update-manager.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = true;
    this.checkCalls = 0;
    this.installCalls = 0;
    this.checkImplementation = async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.0' },
    });
    this.installImplementation = () => {};
  }

  checkForUpdates() {
    this.checkCalls += 1;
    return this.checkImplementation();
  }

  quitAndInstall(isSilent, isForceRunAfter) {
    this.installCalls += 1;
    return this.installImplementation(isSilent, isForceRunAfter);
  }
}

const createInstalledManager = (updater = new FakeUpdater(), options = {}) => createUpdateManager({
  isPackaged: true,
  platform: 'win32',
  env: {},
  updater,
  logger: { warn() {} },
  ...options,
});

test('update statuses are constrained to the normalized public states', () => {
  assert.deepEqual(UPDATE_STATUSES, [
    'disabled',
    'checking',
    'available',
    'not-available',
    'downloading',
    'downloaded',
    'error',
  ]);
});

test('development builds are disabled without contacting the updater', async () => {
  const updater = new FakeUpdater();
  const manager = createUpdateManager({
    isPackaged: false,
    platform: 'win32',
    env: {},
    updater,
  });

  assert.deepEqual(manager.getRuntime(), {
    eligible: false,
    kind: 'development',
    reason: 'development',
  });
  assert.equal(manager.getState().status, 'disabled');
  assert.equal(manager.isEnabled(), false);
  await manager.checkForUpdates();
  assert.equal(updater.checkCalls, 0);
});

test('the Electron manager does not load electron-updater during development', async () => {
  let loadCalls = 0;
  const manager = await createElectronUpdateManager({
    electronApp: { isPackaged: false },
    platform: 'win32',
    env: {},
    loadUpdater: async () => {
      loadCalls += 1;
      return { autoUpdater: new FakeUpdater() };
    },
  });

  assert.equal(manager.getRuntime().kind, 'development');
  assert.equal(manager.isEnabled(), false);
  assert.equal(loadCalls, 0);
});

test('electron-builder portable builds are disabled', async () => {
  const updater = new FakeUpdater();
  const manager = createUpdateManager({
    isPackaged: true,
    platform: 'win32',
    env: {
      PORTABLE_EXECUTABLE_DIR: 'C:\\Portable',
      PORTABLE_EXECUTABLE_FILE: 'C:\\Portable\\SnapOverLAN.exe',
    },
    updater,
  });

  assert.equal(manager.getRuntime().kind, 'portable');
  assert.equal(manager.getState().status, 'disabled');
  assert.equal(manager.getState().reason, 'portable');
  await manager.checkForUpdates();
  assert.equal(updater.checkCalls, 0);
});

test('the Electron manager does not load electron-updater in a portable executable', async () => {
  let loadCalls = 0;
  const manager = await createElectronUpdateManager({
    electronApp: { isPackaged: true },
    platform: 'win32',
    env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Portable\\SnapOverLAN.exe' },
    loadUpdater: async () => {
      loadCalls += 1;
      return { autoUpdater: new FakeUpdater() };
    },
  });

  assert.equal(manager.getRuntime().kind, 'portable');
  assert.equal(manager.isEnabled(), false);
  assert.equal(loadCalls, 0);
});

test('a packaged non-portable Windows build enables downloads but disables install on quit', () => {
  const updater = new FakeUpdater();
  const manager = createInstalledManager(updater);

  assert.deepEqual(manager.getRuntime(), {
    eligible: true,
    kind: 'installed-nsis',
    reason: '',
  });
  assert.equal(manager.isEnabled(), true);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(manager.autoUpdater, undefined);
});

test('checking state is published while a check is in flight and duplicate checks are shared', async () => {
  const updater = new FakeUpdater();
  const checkGate = deferred();
  updater.checkImplementation = () => checkGate.promise;
  const manager = createInstalledManager(updater);

  const firstCheck = manager.checkForUpdates();
  const secondCheck = manager.checkForUpdates();
  assert.equal(firstCheck, secondCheck);
  assert.equal(manager.getState().status, 'checking');
  assert.equal(updater.checkCalls, 0);

  await Promise.resolve();
  assert.equal(updater.checkCalls, 1);
  checkGate.resolve({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } });
  await firstCheck;
});

test('update available state includes only a sanitized version', async () => {
  const updater = new FakeUpdater();
  updater.checkImplementation = async () => {
    updater.emit('update-available', {
      version: '2.0.0',
      releaseNotes: '<script>not renderer data</script>',
      files: [{ url: 'https://example.invalid/private.exe' }],
    });
    return { isUpdateAvailable: true, updateInfo: { version: '2.0.0' } };
  };
  const manager = createInstalledManager(updater);

  await manager.checkForUpdates();
  assert.deepEqual(manager.getState(), {
    status: 'available',
    reason: '',
    version: '2.0.0',
    progress: null,
    message: '',
  });
});

test('no update state is normalized', async () => {
  const updater = new FakeUpdater();
  updater.checkImplementation = async () => {
    updater.emit('update-not-available', { version: '1.0.0' });
    return { isUpdateAvailable: false, updateInfo: { version: '1.0.0' } };
  };
  const manager = createInstalledManager(updater);

  await manager.checkForUpdates();
  assert.equal(manager.getState().status, 'not-available');
  assert.equal(manager.getState().version, '1.0.0');
});

test('automatic download progress is normalized', () => {
  const updater = new FakeUpdater();
  const manager = createInstalledManager(updater);
  updater.emit('update-available', { version: '2.0.0' });

  updater.emit('download-progress', {
    percent: 42.25,
    bytesPerSecond: 1024,
    transferred: 4096,
    total: 8192,
    unsafe: 'not forwarded',
  });
  assert.deepEqual(manager.getState().progress, {
    percent: 42.25,
    bytesPerSecond: 1024,
    transferred: 4096,
    total: 8192,
  });
});

test('automatic download completion marks installation ready', () => {
  const updater = new FakeUpdater();
  const manager = createInstalledManager(updater);
  updater.emit('update-available', { version: '2.0.0' });
  updater.emit('update-downloaded', {
    version: '2.0.0',
    downloadedFile: 'C:\\secret\\update.exe',
  });

  assert.deepEqual(manager.getState(), {
    status: 'downloaded',
    reason: '',
    version: '2.0.0',
    progress: null,
    message: '',
  });
  assert.equal(manager.isInstallationReady(), true);
});

test('updater errors are sanitized and non-fatal', async () => {
  const updater = new FakeUpdater();
  const warnings = [];
  updater.checkImplementation = async () => {
    const error = new Error('connect ECONNREFUSED https://example.invalid/latest.yml?token=secret');
    error.code = 'ECONNREFUSED';
    throw error;
  };
  const manager = createInstalledManager(updater, {
    logger: { warn: (message) => warnings.push(message) },
  });

  await assert.doesNotReject(() => manager.checkForUpdates());
  assert.equal(manager.getState().status, 'error');
  assert.equal(manager.getState().message, 'Update information is currently unavailable.');
  assert.doesNotMatch(manager.getState().message, /example|secret|https/i);
  assert.deepEqual(warnings, ['Update information is currently unavailable.']);

  assert.doesNotThrow(() => updater.emit('error', new Error('sha512 mismatch at C:\\secret')));
  assert.equal(manager.getState().message, 'The downloaded update could not be verified.');
});

test('install is refused until an update has downloaded', () => {
  const updater = new FakeUpdater();
  const manager = createInstalledManager(updater);

  assert.equal(manager.installDownloadedUpdate(), false);
  assert.equal(updater.installCalls, 0);
  assert.equal(manager.isInstallationReady(), false);
});

test('a downloaded update invokes quitAndInstall once with automatic quit install disabled', () => {
  const updater = new FakeUpdater();
  const installArguments = [];
  updater.installImplementation = (...args) => installArguments.push(args);
  const manager = createInstalledManager(updater);
  updater.emit('update-available', { version: '2.0.0' });
  updater.emit('update-downloaded', { version: '2.0.0' });

  assert.equal(manager.installDownloadedUpdate(), true);
  assert.equal(manager.installDownloadedUpdate(), true);
  assert.equal(updater.installCalls, 1);
  assert.deepEqual(installArguments, [[false, true]]);
  assert.equal(updater.autoInstallOnAppQuit, false);
});

test('a synchronous quitAndInstall failure is sanitized and non-fatal', () => {
  const updater = new FakeUpdater();
  updater.installImplementation = () => {
    throw new Error('spawn C:\\secret\\update.exe failed');
  };
  const manager = createInstalledManager(updater);
  updater.emit('update-available', { version: '2.0.0' });
  updater.emit('update-downloaded', { version: '2.0.0' });

  assert.doesNotThrow(() => manager.installDownloadedUpdate());
  assert.equal(manager.installDownloadedUpdate(), false);
  assert.equal(updater.installCalls, 1);
  assert.equal(manager.getState().status, 'error');
  assert.equal(manager.getState().message, 'The update could not be completed.');
});
