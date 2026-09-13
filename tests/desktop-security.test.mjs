import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDesktopShell, isSafeExternalUrl } from '../app/desktop/shell.js';
import { createRendererServerClient } from '../app/desktop/renderer-server-client.js';

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
    async loadFile() {}
  }
  const desktop = createDesktopShell({ BrowserWindow: FakeWindow, port: 8787, getServerLaunchMode: () => 'owned', onStateReady: () => {}, shell: { openExternal: (url) => external.push(url) } });
  await desktop.createWindow();
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
  for (const [resource, method] of [['/api/phone-url', 'GET'], ['/api/server-status', 'GET'], ['/api/batches', 'GET'], ['/api/batches/batch_test/select', 'POST'], ['/api/batches/batch_test', 'DELETE'], ['/api/batches', 'DELETE']]) {
    assert.deepEqual(await client(resource, method), { ok: true });
  }
  assert.equal(requests.length, 6);
  assert.ok(requests.every(({ url, options }) => url.startsWith('http://localhost:8787/api/') && options.redirect === 'error' && !options.headers));
  for (const resource of ['https://evil.example/', '//evil.example/', '/api/server-shutdown', '/api/batches/../server-control', '/api/batches/batch_test%2f..']) {
    await assert.rejects(client(resource), /rejected/);
  }
  await assert.rejects(client('/api/batches', 'PUT'), /rejected/);
  assert.equal(requests.length, 6);
});
