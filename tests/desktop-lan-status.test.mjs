import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isPrivateLanUrl } from '../app/lan-address.js';

const source = (await readFile(new URL('../app/renderer/app.js', import.meta.url), 'utf8'))
  .replace(/^import.*;\r?\n/gm, '');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const lanUrl = 'http://192.168.1.20:8787';
const stableUrl = 'http://snap-test.local:8787';
const status = (urls = [lanUrl]) => ({
  status: 'listening', application: 'SnapOverLAN', protocolVersion: 1,
  lanUrls: urls.map((url) => ({ url, private: true })),
  primaryLanUrl: urls[0] || '', stableUrl,
});

class Element {
  textContent = '';
  title = '';
  hidden = true;
  disabled = false;
  className = '';
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
  const elements = Object.fromEntries([
    'refreshBtn', 'qrBtn', 'connectionPill', 'backgroundToggleBtn', 'retryServerBtn',
    'phoneUrl', 'phoneQr', 'qrFallback', 'batchMessage', 'batchesList',
    'downloadCurrentBatchBtn', 'clearBatchesBtn', 'qrModal', 'closeQrBtn',
  ].map((id) => [id, new Element()]));
  const navigator = {};
  Object.defineProperty(navigator, 'onLine', {
    get() { assert.fail('internet/browser connectivity must not determine LAN availability'); },
  });
  const renderer = runInNewContext(`${source}\n({ getState: () => desktopServerState })`, {
    URL, URLSearchParams, console, navigator, isPrivateLanUrl,
    fetch: () => assert.fail('renderer must not probe external connectivity'),
    document: {
      hidden: false,
      getElementById: (id) => elements[id] || null,
      addEventListener() {},
    },
    window: {
      location: { search: '' }, addEventListener() {},
      setInterval: (callback, ms) => { assert.equal(ms, 5000); interval = callback; return 1; },
      clearInterval() {},
      snapOverLAN: {
        getServerState: async () => ({ state: 'online' }),
        getBackgroundMode: async () => false,
        onDesktopStateChanged: (listener) => { stateListener = listener; },
      },
    },
    drawQrCode: (_canvas, url) => qrValues.push(url),
    createBatchHistory: () => ({ bind() {}, load: async () => {} }),
    fetchJson: async (resource) => {
      requests.push(resource);
      assert.equal(resource, '/api/server-status', 'health and LAN URLs use the same local snapshot');
      if (response instanceof Error) throw response;
      return response;
    },
  });
  await flush();
  return {
    elements, qrValues, requests, renderer,
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
  assert.deepEqual(h.requests, ['/api/server-status', '/api/server-status']);
});
