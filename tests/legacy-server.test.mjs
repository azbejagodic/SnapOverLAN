import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createServerClient } from '../app/desktop/server-client.js';
import { createServerManager } from '../app/desktop/server-manager.js';
import { classifyServerStatus, SERVER_CONTROL_ID } from '../app/server/identity.js';

const legacy = {
  status: 'listening', pid: 123, configuredHost: '0.0.0.0', bindHost: '0.0.0.0',
  port: 8787, lanUrls: [], runtimeDataDir: 'data', latestDir: 'latest', uploadTempDir: 'upload-tmp',
};
const current = { ...legacy, application: 'SnapOverLAN', protocolVersion: 1 };
const token = 'a'.repeat(64);

for (const [name, status, expectedKind] of [
  ['current', current, 'current'],
  ['legacy', legacy, 'legacy'],
  ['unrelated', { ...current, application: 'OtherService' }, 'unrelated'],
  ['unsupported protocol', { ...current, protocolVersion: 2 }, 'unrelated'],
]) {
  test(`${name} control identity is validated before granting a reusable token`, async (t) => {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/server-control') {
        res.end(JSON.stringify({ service: SERVER_CONTROL_ID, shutdownToken: token, server: status }));
      } else if (req.url === '/api/server-status') {
        res.end(JSON.stringify(status));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    assert.equal(classifyServerStatus(status), expectedKind);
    const client = createServerClient({ port });
    const identity = await client.getServerIdentity();
    if (expectedKind === 'current') assert.equal(identity.shutdownToken, token);
    else if (expectedKind === 'legacy') {
      assert.equal(identity.kind, 'legacy');
      assert.equal(identity.shutdownToken, '');
    } else assert.equal(identity, null);

    for (const autoCopyEnabled of expectedKind === 'current' ? [false] : [false, true]) {
      const manager = createServerManager({
        electronApp: { isPackaged: false }, getAutoCopyEnabled: () => autoCopyEnabled,
        getStartupLogPath: () => '', isQuitting: () => false,
        onAutoCopyUnavailable() {}, onMessage: async () => {}, onStateChanged() {},
        port, projectRoot: '.', serverPath: 'must-not-spawn.js',
        serverOrigin: `http://127.0.0.1:${port}`, writeStartupLog: async () => {},
      });
      if (expectedKind === 'current') {
        const state = await manager.start();
        assert.equal(state.state, 'online');
        assert.equal(state.owned, false);
        assert.equal(manager.isRunning(), true);
      } else {
        const error = expectedKind === 'legacy'
          ? /An older SnapOverLAN server is running\. Stop it once and restart the app\./
          : /already in use by another application/;
        await assert.rejects(manager.start(), error);
        assert.equal(manager.getState().state, 'error');
        assert.equal(manager.isRunning(), false);
        await assert.rejects(manager.stop(), expectedKind === 'legacy' ? error : /not a verified SnapOverLAN server/);
      }
    }
    assert.ok(requests.every((url) => ['/api/server-control', '/api/server-status'].includes(url)),
      'rejected servers receive only identity probes, never batch or shutdown requests');
  });
}
