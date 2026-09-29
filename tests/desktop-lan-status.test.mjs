import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isPrivateLanUrl } from '../app/lan-address.js';

const source = (await readFile(new URL('../app/renderer/app.js', import.meta.url), 'utf8'))
  .replace(/^import.*;\r?\n/gm, '');
const batchSource = (await readFile(new URL('../app/renderer/batch-history.js', import.meta.url), 'utf8'))
  .replace(/^export.*;\r?\n/gm, '');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const lanUrl = 'http://192.168.1.20:8787';
const stableUrl = 'http://snap-test.local:8787';
const status = (urls = [lanUrl]) => ({
  status: 'listening', application: 'SnapOverLAN', protocolVersion: 1,
  lanUrls: urls.map((url) => ({ url, private: true })),
  primaryLanUrl: urls[0] || '', stableUrl,
});

class Element {
  _textContent = '';
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = value; this.children = []; }
  title = '';
  hidden = true;
  disabled = false;
  className = '';
  open = false;
  children = [];
  set innerHTML(value) { assert.equal(value, ''); this.children = []; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  listeners = new Map();
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute() {}
  querySelector() { return null; }
  focus() {}
  click() { return this.listeners.get('click')?.({ target: this }); }
}

const createHarness = async (initialStatus = status()) => {
  let response = initialStatus;
  let stateListener;
  let interval;
  const requests = [];
  const qrValues = [];
  const downloads = [];
  const elements = Object.fromEntries([
    'refreshBtn', 'qrBtn', 'connectionPill', 'backgroundToggleBtn', 'retryServerBtn',
    'phoneUrl', 'phoneQr', 'qrFallback', 'batchMessage', 'batchesList',
    'downloadCurrentBatchBtn', 'clearBatchesBtn', 'qrModal', 'closeQrBtn',
    'diagnosticsSummary', 'diagnosticsList', 'diagnosticsWarning', 'diagnosticsUrls', 'diagnosticsPanel',
  ].map((id) => [id, new Element()]));
  const navigator = {};
  Object.defineProperty(navigator, 'onLine', {
    get() { assert.fail('internet/browser connectivity must not determine LAN availability'); },
  });
  const renderer = runInNewContext(`${batchSource}\n${source}\n({ getState: () => desktopServerState })`, {
    URL, console, navigator, isPrivateLanUrl,
    fetch: () => assert.fail('renderer must not probe external connectivity'),
    document: {
      hidden: false,
      getElementById: (id) => elements[id] || null,
      createElement: () => new Element(),
      createDocumentFragment: () => new Element(),
      addEventListener() {},
    },
    window: {
      confirm: () => true,
      get location() { assert.fail('diagnostics must not read renderer query parameters'); },
      addEventListener() {},
      setInterval: (callback, ms) => { assert.equal(ms, 5000); interval = callback; return 1; },
      clearInterval() {},
      snapOverLAN: {
        getServerState: async () => ({ state: 'online' }),
        getBackgroundMode: async () => false,
        onDesktopStateChanged: (listener) => { stateListener = listener; },
        downloadBatch: async (id) => { downloads.push(id); },
      },
    },
    drawQrCode: (_canvas, url) => qrValues.push(url),
    fetchJson: async (resource) => {
      requests.push(resource);
      if (resource.startsWith('/api/batches')) return { batches: [{
        id: 'batch_test', current: true, fileCount: 1, totalSize: 10, createdAt: '2026-01-01',
      }] };
      assert.equal(resource, '/api/server-status', 'health and LAN URLs use the same local snapshot');
      if (response instanceof Error) throw response;
      return response;
    },
  });
  await flush();
  return {
    elements, qrValues, requests, downloads, renderer,
    setResponse: (value) => { response = value; },
    refresh: () => interval(),
    emitServerState: (state) => stateListener({ server: { state }, backgroundMode: false }),
  };
};

for (const address of ['192.168.1.20', '10.0.0.50', '172.16.1.2', '172.31.1.2']) {
test(`${address} shows green Server online with the stable phone QR`, async () => {
  const h = await createHarness(status([`http://${address}:8787`]));
  assert.equal(h.elements.connectionPill.textContent, 'Server online');
  assert.equal(h.elements.connectionPill.className, 'server-line online');
  assert.equal(h.renderer.getState(), 'online');
  assert.equal(h.elements.phoneUrl.textContent, stableUrl);
  assert.equal(h.elements.phoneQr.hidden, false);
  assert.equal(h.elements.qrBtn.disabled, false);
  assert.equal(h.qrValues.at(-1), stableUrl);
});
}

test('healthy server without LAN stays online, ignores a retained mDNS name, and disables QR', async () => {
  const h = await createHarness(status([]));
  assert.equal(h.elements.connectionPill.textContent, 'Server unavailable');
  assert.equal(h.elements.connectionPill.className, 'server-line offline');
  assert.equal(h.renderer.getState(), 'online');
  assert.equal(h.elements.backgroundToggleBtn.disabled, false);
  assert.equal(h.elements.phoneUrl.textContent, '');
  assert.equal(h.elements.phoneQr.hidden, true);
  assert.equal(h.elements.qrBtn.disabled, true);
  h.elements.qrBtn.click();
  assert.equal(h.elements.qrModal.hidden, true);
  h.emitServerState('online');
  assert.equal(h.elements.connectionPill.textContent, 'Server unavailable');
});

for (const url of [
  'http://localhost:8787', 'http://127.0.0.1:8787', 'http://127.0.0.2:8787',
  'http://[::1]:8787', 'http://[::ffff:127.0.0.1]:8787', 'http://0.0.0.0:8787',
  'http://26.10.20.30:8787', 'http://169.254.1.2:8787',
  'http://172.15.1.2:8787', 'http://172.32.1.2:8787', 'http://8.8.8.8:8787',
]) {
  test(`${url} alone does not count as usable LAN`, async () => {
    const h = await createHarness(status([url]));
    assert.equal(h.elements.connectionPill.textContent, 'Server unavailable');
    assert.equal(h.elements.connectionPill.className, 'server-line offline');
    assert.equal(h.elements.phoneUrl.textContent, '');
    assert.equal(h.elements.qrBtn.disabled, true);
  });
}

test('automatic refresh clears stale URLs on LAN loss and restores the new phone URL when LAN returns', async () => {
  const initial = { ...status(), stableUrl: '' };
  const h = await createHarness(initial);
  h.elements.qrBtn.click();
  assert.equal(h.elements.qrModal.hidden, false);
  h.setResponse(status([]));
  await h.refresh();
  assert.equal(h.elements.connectionPill.textContent, 'Server unavailable');
  assert.equal(h.elements.connectionPill.className, 'server-line offline');
  assert.equal(h.elements.phoneUrl.textContent, '');
  assert.equal(h.elements.phoneUrl.title, '');
  assert.equal(h.elements.phoneQr.hidden, true);
  assert.equal(h.elements.qrModal.hidden, true);
  assert.equal(h.renderer.getState(), 'online');
  const returnedUrl = 'http://10.0.0.50:8787';
  h.setResponse({ ...status([returnedUrl]), stableUrl: '' });
  await h.refresh();
  assert.equal(h.elements.connectionPill.textContent, 'Server online');
  assert.equal(h.elements.connectionPill.className, 'server-line online');
  assert.equal(h.elements.phoneUrl.textContent, returnedUrl);
  assert.equal(h.elements.phoneUrl.title, returnedUrl);
  assert.equal(h.elements.phoneQr.hidden, false);
  assert.equal(h.elements.qrBtn.disabled, false);
  assert.equal(h.qrValues.at(-1), returnedUrl);
});

test('actual local server request failure shows red Server unavailable and clears the phone URL', async () => {
  const h = await createHarness();
  h.setResponse(new Error('ECONNREFUSED'));
  await h.refresh();
  assert.equal(h.elements.connectionPill.textContent, 'Server unavailable');
  assert.equal(h.elements.connectionPill.className, 'server-line offline');
  assert.equal(h.renderer.getState(), 'offline');
  assert.equal(h.elements.phoneUrl.textContent, '');
  assert.equal(h.elements.phoneQr.hidden, true);
  assert.equal(h.elements.qrBtn.disabled, true);
});

for (const state of ['offline', 'error']) {
  test(`desktop process ${state} event immediately clears phone setup and shows red Server unavailable`, async () => {
    const h = await createHarness();
    h.emitServerState(state);
    assert.equal(h.elements.connectionPill.textContent, 'Server unavailable');
    assert.equal(h.elements.connectionPill.className, 'server-line offline');
    assert.equal(h.elements.phoneUrl.textContent, '');
    assert.equal(h.elements.phoneQr.hidden, true);
    assert.equal(h.elements.qrBtn.disabled, true);
  });
}

test('LAN availability requires no internet connectivity API or external request', async () => {
  const h = await createHarness({ ...status(), stableUrl: '' });
  await h.refresh();
  assert.equal(h.elements.connectionPill.textContent, 'Server online');
  assert.deepEqual(h.requests, ['/api/server-status', '/api/batches', '/api/server-status', '/api/batches']);
});

const legacyStatus = () => {
  const { application, protocolVersion, ...legacy } = status();
  return { ...legacy, pid: 123, configuredHost: '0.0.0.0', bindHost: '0.0.0.0', port: 8787,
    runtimeDataDir: 'data', latestDir: 'latest', uploadTempDir: 'upload-tmp' };
};

for (const [name, rejectedStatus] of [
  ['legacy', legacyStatus()],
  ['unrelated', { ...status(), application: 'OtherService' }],
  ['wrong protocol', { ...status(), protocolVersion: 2 }],
  ['not listening', { ...status(), status: 'starting' }],
]) {
  test(`${name} status cannot enable renderer, QR, or batch requests`, async () => {
    const h = await createHarness(rejectedStatus);
    h.emitServerState('online');
    await h.elements.clearBatchesBtn.click();
    await h.elements.downloadCurrentBatchBtn.click();
    assert.equal(h.renderer.getState(), 'offline');
    assert.equal(h.elements.backgroundToggleBtn.disabled, true);
    assert.equal(h.elements.qrBtn.disabled, true);
    assert.equal(h.elements.phoneUrl.textContent, '');
    assert.equal(h.elements.clearBatchesBtn.disabled, true);
    assert.equal(h.elements.downloadCurrentBatchBtn.disabled, true);
    assert.equal(h.elements.batchesList.children.length, 0);
    assert.deepEqual(h.requests, ['/api/server-status']);
    assert.deepEqual(h.downloads, []);
  });
}

test('current server batch controls are revoked on legacy replacement and recover only after validation', async () => {
  const h = await createHarness();
  const buttons = h.elements.batchesList.children[0].children[0].children[1].children;
  assert.equal(h.elements.clearBatchesBtn.disabled, false);
  assert.equal(h.elements.downloadCurrentBatchBtn.disabled, false);
  await h.elements.downloadCurrentBatchBtn.click();
  assert.deepEqual(h.downloads, ['batch_test']);
  h.setResponse(legacyStatus());
  await h.refresh();
  const before = h.requests.slice();
  for (const button of buttons) await button.click();
  await h.elements.clearBatchesBtn.click();
  await h.elements.downloadCurrentBatchBtn.click();
  assert.deepEqual(h.requests, before);
  assert.deepEqual(h.downloads, ['batch_test']);
  assert.equal(h.elements.batchesList.children.length, 0);
  h.setResponse(status());
  await h.refresh();
  assert.equal(h.renderer.getState(), 'online');
  assert.equal(h.elements.clearBatchesBtn.disabled, false);
  assert.deepEqual(h.requests.slice(-2), ['/api/server-status', '/api/batches']);
});

test('diagnostics uses live server source and preserves the user expansion choice', async () => {
  const h = await createHarness({ ...status(), launchSource: 'electron-dev-child' });
  const rows = () => Object.fromEntries(h.elements.diagnosticsList.children
    .reduce((pairs, element, index, children) => {
      if (index % 2 === 0) pairs.push([element.textContent, children[index + 1].textContent]);
      return pairs;
    }, []));
  assert.equal(h.elements.diagnosticsPanel.open, false);
  assert.equal(rows()['Server source'], 'electron-dev-child');
  assert.equal(rows()['Stable phone URL'], stableUrl);
  assert.match(h.elements.diagnosticsWarning.textContent, /Phone checklist/);
  h.elements.diagnosticsPanel.open = true;
  h.setResponse({ ...status(), launchSource: 'standalone' });
  await h.refresh();
  assert.equal(rows()['Server source'], 'standalone');
  assert.equal(h.elements.diagnosticsPanel.open, true);
  h.elements.diagnosticsPanel.open = false;
  h.setResponse(status([]));
  await h.refresh();
  assert.equal(h.elements.diagnosticsPanel.open, false);
  assert.match(h.elements.diagnosticsWarning.textContent, /No private LAN IPv4/);
});

test('diagnostics clears stale links on failure and restores current links after recovery', async () => {
  const h = await createHarness();
  const links = () => h.elements.diagnosticsUrls.children[1]?.children.map((item) => item.children[0].href) || [];
  assert.deepEqual(links(), [lanUrl]);
  h.setResponse(new Error('ECONNREFUSED'));
  await h.refresh();
  assert.equal(h.elements.diagnosticsSummary.textContent, 'Server unavailable');
  assert.equal(h.elements.diagnosticsWarning.textContent, 'ECONNREFUSED');
  assert.equal(h.elements.diagnosticsWarning.hidden, false);
  assert.equal(h.elements.diagnosticsList.children.length, 0);
  assert.equal(h.elements.diagnosticsUrls.hidden, true);
  assert.deepEqual(links(), []);
  assert.equal(h.elements.diagnosticsPanel.open, false);
  const newUrl = 'http://10.0.0.5:8787';
  h.setResponse(status([newUrl]));
  await h.refresh();
  assert.equal(h.elements.diagnosticsSummary.textContent, 'Server online');
  assert.equal(h.elements.diagnosticsUrls.hidden, false);
  assert.deepEqual(links(), [newUrl]);
});
