import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createDesktopShell, isSafeExternalUrl } from '../app/desktop/shell.js';
import { createRendererServerClient } from '../app/desktop/renderer-server-client.js';

const mainSource = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
const handlersSource = mainSource.slice(mainSource.indexOf('const handleServerControl ='), mainSource.indexOf('const gotLock ='));
const createIpcHarness = () => {
  const handlers = new Map();
  const calls = [];
  const sender = { mainFrame: {} };
  const state = { state: 'online' };
  const response = { files: [] };
  const download = { savedCount: 1 };
  const context = {
    activeBatchExports: new Set(), quitOperation: null, allowQuit: false,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    desktopShell: { isMainWindowSender: (candidate) => candidate === sender },
    getServerStatePayload: () => { calls.push(['state']); return state; },
    rendererServerRequest: async (...args) => { calls.push(['request', ...args]); return response; },
    startServer: async () => { calls.push(['start']); return state; },
    getWindowsNetworkProfile: async (address) => { calls.push(['profile', address]); return 'Public'; },
    openWindowsNetworkSettings: async () => { calls.push(['network-settings']); return true; },
    backgroundMode: false,
    setBackgroundMode: async (enabled) => {
      calls.push(['background', enabled]);
      context.backgroundMode = Boolean(enabled);
      return context.backgroundMode;
    },
    electronApp: { getPath: (name) => { calls.push(['path', name]); return 'downloads'; } },
    downloadBatchToFolder: async (options) => {
      calls.push(['download', options.batchId, options.destinationDir, options.serverOrigin]);
      return download;
    },
    shell: { openPath: async (directory) => { calls.push(['open', directory]); return ''; } },
    SERVER_ORIGIN: 'http://localhost:8787',
    console,
  };
  runInNewContext(handlersSource, context);
  return { handlers, calls, sender, context, state, response, download };
};

const channels = [
  ['server:get-state', [], (harness) => harness.state, [['state']]],
  ['server:request', ['/api/batches', 'GET'], (harness) => harness.response, [['request', '/api/batches', 'GET']]],
  ['server:retry', [], (harness) => harness.state, [['start']]],
  ['network:get-profile', ['192.168.1.20'], () => 'Public', [['profile', '192.168.1.20']]],
  ['network:open-settings', [], () => true, [['network-settings']]],
  ['background:get', [], () => false, []],
  ['background:set', [true], () => true, [['background', true]]],
  ['batch:download', ['batch_test'], (harness) => harness.download,
    [['path', 'downloads'], ['download', 'batch_test', 'downloads', 'http://localhost:8787'], ['open', 'downloads']]],
];

for (const installUpdate of [false, true]) {
  for (const fails of [false, true]) {
    test(`${installUpdate ? 'update' : 'quit'} waits for ${fails ? 'failed' : 'successful'} export cleanup and closes admission`, async () => {
      const harness = createIpcHarness();
      const { context, sender, calls, handlers } = harness;
      let finish;
      const pending = new Promise((resolve, reject) => {
        finish = () => {
          calls.push(['cleanup']);
          if (fails) reject(new Error('export failed')); else resolve(harness.download);
        };
      });
      Object.assign(context, {
        downloadBatchToFolder: () => pending,
        serverManager: { getOperation: () => null, isRunning: () => true },
        stopServer: async () => { calls.push(['stop']); },
        updateManager: { installDownloadedUpdate: () => { calls.push(['install']); return true; } },
        console: { log() {}, error() {} },
      });
      context.desktopShell.destroyTray = () => {};
      context.electronApp.quit = () => calls.push(['quit']);
      const quitSource = mainSource.slice(mainSource.indexOf('async function requestQuit('), mainSource.indexOf('const handleServerControl ='));
      const quit = runInNewContext(`${quitSource}\nrequestQuit`, context);
      const event = { sender, senderFrame: sender.mainFrame };
      const exported = handlers.get('batch:download')(event, 'batch_test');
      const exportResult = fails ? assert.rejects(exported, /export failed/) : exported;
      assert.equal(context.activeBatchExports.size, 1);
      const quitting = quit({ installUpdate });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, [['path', 'downloads']]);
      await assert.rejects(handlers.get('batch:download')(event, 'batch_other'), /is quitting/);
      finish();
      await exportResult;
      assert.equal(await quitting, true);
      assert.equal(context.activeBatchExports.size, 0);
      assert.ok(calls.findIndex(([name]) => name === 'stop') > calls.findIndex(([name]) => name === 'cleanup'));
      assert.deepEqual(calls.at(-1), [installUpdate ? 'install' : 'quit']);
    });
  }
}

test('sender validation tests cover every renderer IPC handler', () => {
  const registered = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(registered.sort(), channels.map(([channel]) => channel).sort());
  assert.equal(createIpcHarness().handlers.size, channels.length);
});

for (const [channel, args, expectedResult, expectedCalls] of channels) {
  test(`${channel} accepts the main window main frame and preserves its result`, async () => {
    const harness = createIpcHarness();
    const event = { sender: harness.sender, senderFrame: harness.sender.mainFrame };
    assert.strictEqual(await harness.handlers.get(channel)(event, ...args), expectedResult(harness));
    assert.deepEqual(harness.calls, expectedCalls);
  });

  for (const source of ['other window', 'subframe']) {
    test(`${channel} rejects ${source} without side effects`, async () => {
      const harness = createIpcHarness();
      const sender = source === 'other window' ? { mainFrame: {} } : harness.sender;
      const event = { sender, senderFrame: source === 'subframe' ? {} : sender.mainFrame };
      const message = channel === 'server:request' ? 'Server request was rejected.'
        : channel === 'batch:download' ? 'Batch download request was rejected.' : 'IPC request was rejected.';
      await assert.rejects(async () => harness.handlers.get(channel)(event, ...args), { message });
      assert.deepEqual(harness.calls, [], 'no server calls, settings writes, downloads, or folder opening');
      assert.equal(harness.context.backgroundMode, false);
    });
  }
}

test('external URL protocol allowlist rejects executable, local-file, and malformed URLs', () => {
  for (const url of ['http://localhost:8787/', 'https://github.com/azbejagodic/SnapOverLAN']) assert.equal(isSafeExternalUrl(url), true);
  for (const url of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'data:text/html,x', 'ms-settings:privacy', 'mailto:someone@example.org', 'garbage']) assert.equal(isSafeExternalUrl(url), false);
});

test('desktop popup and navigation handlers preserve safe local windows and block unsafe schemes', async () => {
  let window;
  const external = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => { this.handler = handler; };
      window = this;
    }
    setMenuBarVisibility() {}
    async loadFile(...args) { this.loadFileArgs = args; }
  }
  const desktop = createDesktopShell({ BrowserWindow: FakeWindow, port: 8787, rendererPath: 'app/renderer/index.html', onStateReady: () => {}, shell: { openExternal: (url) => external.push(url) } });
  await desktop.createWindow();
  assert.deepEqual(window.loadFileArgs, ['app/renderer/index.html'], 'desktop loads without launcher query parameters');
  assert.deepEqual(window.options.webPreferences, { preload: undefined, contextIsolation: true, nodeIntegration: false, sandbox: true });
  assert.equal(window.handler({ url: 'http://localhost:8787/files/photo.jpg' }).action, 'allow');
  assert.equal(window.handler({ url: 'https://example.org/' }).action, 'deny');
  assert.deepEqual(external, ['https://example.org/']);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'custom://localhost:8787/']) {
    assert.equal(window.handler({ url }).action, 'deny');
    for (const eventName of ['will-navigate', 'will-redirect']) {
      let prevented = false;
      window.webContents.emit(eventName, { preventDefault: () => { prevented = true; } }, url);
      assert.equal(prevented, true);
    }
  }
  assert.deepEqual(external, ['https://example.org/']);
  const child = { webContents: new EventEmitter() };
  child.webContents.setWindowOpenHandler = (handler) => { child.handler = handler; };
  window.webContents.emit('did-create-window', child);
  assert.equal(child.handler({ url: 'ms-settings:privacy' }).action, 'deny');
  let prevented = false;
  child.webContents.emit('will-redirect', { preventDefault: () => { prevented = true; } }, 'file:///C:/secret');
  assert.equal(prevented, true);
});

test('native renderer API bridge permits required actions and cannot proxy arbitrary URLs', async () => {
  const requests = [];
  const client = createRendererServerClient({ serverOrigin: 'http://localhost:8787', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  for (const [resource, method] of [['/api/server-status', 'GET'], ['/api/batches', 'GET'], ['/api/batches/batch_test/select', 'POST'], ['/api/batches/batch_test', 'DELETE'], ['/api/batches', 'DELETE']]) {
    assert.deepEqual(await client(resource, method), { ok: true });
  }
  assert.equal(requests.length, 5);
  assert.ok(requests.every(({ url, options }) => url.startsWith('http://localhost:8787/api/') && options.redirect === 'error' && !options.headers));
  for (const resource of ['https://evil.example/', '//evil.example/', '/api/server-shutdown', '/api/batches/../server-control', '/api/batches/batch_test%2f..']) {
    await assert.rejects(client(resource), /rejected/);
  }
  await assert.rejects(client('/api/batches', 'PUT'), /rejected/);
  assert.equal(requests.length, 5);
});
