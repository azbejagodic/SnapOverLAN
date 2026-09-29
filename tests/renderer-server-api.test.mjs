import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJson } from '../app/renderer/server-api.js';

const installRenderer = (t, snapOverLAN) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { snapOverLAN } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  });
  const browserFetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected browser fetch');
  });
  t.after(() => assert.equal(browserFetch.mock.callCount(), 0, 'renderer must never fall back to browser fetch'));
};

test('renderer forwards current caller paths and methods through the preload bridge', async (t) => {
  const requests = [];
  const result = { ok: true };
  const bridge = {
    async serverRequest(...args) {
      assert.equal(this, bridge);
      requests.push(args);
      return result;
    }
  };
  installRenderer(t, bridge);
  for (const [path, options, method] of [
    ['/api/server-status', undefined, 'GET'],
    ['/api/batches', {}, 'GET'],
    ['/api/batches', { method: 'GET' }, 'GET'],
    ['/api/batches/batch_test/select', { method: 'POST' }, 'POST'],
    ['/api/batches/batch_test', { method: 'DELETE' }, 'DELETE'],
    ['/api/batches', { method: 'DELETE' }, 'DELETE']
  ]) {
    assert.equal(await fetchJson(path, options), result);
    assert.deepEqual(requests.at(-1), [path, method]);
  }
  assert.equal(requests.length, 6);
});

for (const [label, bridge] of [
  ['missing bridge', undefined],
  ['null bridge', null],
  ['missing serverRequest', {}],
  ['null serverRequest', { serverRequest: null }],
  ['non-function serverRequest', { serverRequest: true }]
]) {
  test(`renderer fails clearly with ${label} without attempting HTTP`, async (t) => {
    installRenderer(t, bridge);
    await assert.rejects(fetchJson('/api/server-status'), /Desktop preload bridge is unavailable: snapOverLAN\.serverRequest must be a function\./);
  });
}

test('renderer propagates IPC rejection unchanged without attempting HTTP', async (t) => {
  const failure = new Error('Server request was rejected.');
  installRenderer(t, { serverRequest: async () => { throw failure; } });
  await assert.rejects(fetchJson('/api/batches'), (error) => error === failure);
});
