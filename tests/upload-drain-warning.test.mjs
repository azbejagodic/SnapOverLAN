import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { createUploadLifecycle } from '../app/server/upload-lifecycle.js';
import { waitForUploadDrain } from '../app/desktop/upload-drain.js';
import { createServerClient } from '../app/desktop/server-client.js';
import { createSystemRouter } from '../app/server/routes/system.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const mainSource = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
const promptSource = mainSource.slice(mainSource.indexOf('const showUploadBlockedWarning ='), mainSource.indexOf('serverManager = createServerManager({'));
const quitSource = mainSource.slice(mainSource.indexOf('async function requestQuit('), mainSource.indexOf("ipcMain.handle('server:get-state'"));
const managerSource = (await readFile(new URL('../app/desktop/server-manager.js', import.meta.url), 'utf8'))
  .replace(/^import.*;\r?\n/gm, '').replace(/export \{.*\};/, '');
const beginUpload = (lifecycle) => {
  const res = new EventEmitter();
  lifecycle.markUploadStarted({}, res, () => {});
  return res;
};

for (const installUpdate of [false, true]) {
  for (const transport of ['ipc', 'localhost']) {
    for (const phase of ['upload', 'preparation']) {
    test(`${installUpdate ? 'Restart & Update' : 'Quit'} via ${transport} blocks during ${phase}, admits uploads, and retries current state`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const lifecycle = createUploadLifecycle({ logger: { warn() { assert.fail('unexpected drain timer'); } } });
      let preparingSessionId;
      const beginActivity = () => {
        if (phase === 'upload') return beginUpload(lifecycle);
        preparingSessionId = lifecycle.beginSendSession().sessionId;
        const activity = new EventEmitter();
        activity.once('finish', () => lifecycle.endSendSession(preparingSessionId));
        return activity;
      };
      let upload = beginActivity();
      const events = [];
      const child = new EventEmitter();
      child.exitCode = null;
      child.connected = true;
      child.kill = () => assert.fail('must not kill an active upload');
      lifecycle.subscribeDrain((state) => child.emit('message', { type: 'snapoverlan:drain-state', ...state }));
      const startShutdown = ({ onlyIfIdle }) => {
        assert.equal(onlyIfIdle, true);
        const pending = lifecycle.beginDrain({ onlyIfIdle });
        if (!pending) return false;
        pending.then(() => { child.exitCode = 0; child.emit('exit', 0); });
        return true;
      };
      child.send = (message) => {
        assert.equal(message.type, 'snapoverlan:shutdown');
        if (!startShutdown(message)) child.emit('message', { type: 'snapoverlan:shutdown-blocked' });
      };
      let spawned = false;
      const token = 'a'.repeat(64);
      const client = {
        getServerIdentity: async () => (spawned || transport === 'localhost') ? { kind: 'current', shutdownToken: token } : null,
        isPortInUse: async () => false,
        watchServerShutdown: async (_token, observer) => lifecycle.subscribeDrain(observer.state),
        postServerShutdown: async (_token, options) => startShutdown(options),
        waitForPortRelease: async () => true,
      };
      const createManager = runInNewContext(`${managerSource}\ncreateServerManager`, {
        path, process, console, setTimeout, clearTimeout, waitForUploadDrain,
        spawn: () => { spawned = true; return child; }, createServerClient: () => client,
      });
      const manager = createManager({
        electronApp: { isPackaged: false }, getAutoCopyEnabled: () => false,
        getStartupLogPath: () => '', isQuitting: () => true, onMessage: async () => {},
        onStateChanged() {}, writeStartupLog: async () => {}, projectRoot: '.', serverPath: 'app/server/index.js',
      });
      await manager.start();
      const parent = { isDestroyed: () => false };
      let dismiss;
      const context = {
        console, quitOperation: null, activeBatchExports: new Set(), allowQuit: false, serverManager: manager,
        stopServer: () => manager.stop({ onlyIfIdle: true }),
        desktopShell: { destroyTray: () => events.push('tray'), getMainWindow: () => parent },
        electronApp: { quit: () => events.push('quit') },
        updateManager: { installDownloadedUpdate: () => { events.push('install'); return true; } },
        dialog: { showMessageBox: (owner, options) => {
          assert.equal(owner, parent);
          assert.equal(options.title, 'Upload in progress');
          assert.equal(options.message, installUpdate
            ? 'An upload is still in progress. Wait for it to finish before restarting and updating SnapOverLAN.'
            : 'An upload is still in progress. Wait for it to finish before closing SnapOverLAN.');
          assert.deepEqual(Array.from(options.buttons), ['OK']);
          events.push('warning');
          return new Promise((resolve) => { dismiss = () => resolve({ response: 0 }); });
        } },
      };
      const quit = runInNewContext(`${promptSource}\n${quitSource}\nrequestQuit`, context);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const pending = quit({ installUpdate, warningParent: parent });
        await flush();
        assert.equal(events.filter((event) => event === 'warning').length, attempt + 1);
        assert.equal(lifecycle.status.draining, false);
        assert.equal(lifecycle.getDrainState().phase, 'idle');
        assert.equal(manager.getState().state, 'online');
        assert.equal(context.allowQuit, false);
        upload.emit('finish');
        upload = beginActivity();
        for (let i = 0; i < 12; i += 1) {
          t.mock.timers.tick(10000);
          if (phase === 'preparation') lifecycle.renewSendSession(preparingSessionId);
        }
        dismiss();
        assert.equal(await pending, installUpdate ? 'upload-blocked' : false);
        assert.equal(context.quitOperation, null);
      }
      upload.emit('finish');
      await flush();
      assert.deepEqual(events, ['warning', 'warning'], 'completion never auto-quits or installs');
      assert.equal(await quit({ installUpdate }), true);
      assert.deepEqual(events, ['warning', 'warning', 'tray', installUpdate ? 'install' : 'quit']);
      assert.equal(lifecycle.status.draining, true);
    });
    }
  }
}

test('authenticated localhost shutdown rejects an active upload atomically and accepts an idle retry', async (t) => {
  const lifecycle = createUploadLifecycle();
  const upload = beginUpload(lifecycle);
  const token = 'b'.repeat(64);
  const app = express();
  let stops = 0;
  app.use('/api', express.json(), createSystemRouter({
    getServerStatus: () => ({}), isLoopbackRequest: () => true,
    shutdownToken: token, drainLifecycle: lifecycle,
    onShutdown: (_reason, options) => {
      const pending = lifecycle.beginDrain(options);
      if (!pending) return false;
      pending.then(() => { stops += 1; });
      return pending;
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const client = createServerClient({ port: server.address().port });
  await assert.rejects(client.postServerShutdown('wrong', { onlyIfIdle: true }), /404/);
  assert.equal(await client.postServerShutdown(token, { onlyIfIdle: true }), false);
  assert.equal(stops, 0);
  assert.equal(lifecycle.status.draining, false);
  upload.emit('finish');
  await client.postServerShutdown(token, { onlyIfIdle: true });
  assert.equal(stops, 1);
  assert.equal(lifecycle.status.draining, true);
});

test('emergency localhost drain remains bounded after its controller stream disconnects', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
  beginUpload(lifecycle);
  const token = 'c'.repeat(64);
  const app = express();
  let pending;
  app.use('/api', express.json(), createSystemRouter({
    getServerStatus: () => ({}), isLoopbackRequest: () => true,
    shutdownToken: token, drainLifecycle: lifecycle,
    onShutdown: (_reason, options) => { pending = lifecycle.beginDrain(options); return pending; },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const client = createServerClient({ port: server.address().port });
  const close = await client.watchServerShutdown(token, { state() {}, closed() {}, error: (error) => assert.fail(error) });
  await client.postServerShutdown(token);
  close();
  await flush();
  t.mock.timers.tick(59999);
  assert.equal(lifecycle.status.draining, true);
  assert.equal(lifecycle.getDrainState().phase, 'waiting');
  t.mock.timers.tick(1);
  assert.equal(await pending, 'continue');
  assert.equal(lifecycle.getDrainState().phase, 'ready');
});
