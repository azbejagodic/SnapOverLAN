import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { createUploadLifecycle, UPLOAD_DRAIN_TIMEOUT_MS } from '../app/server/upload-lifecycle.js';
import { waitForUploadDrain } from '../app/desktop/upload-drain.js';
import { imageFixture } from './helpers/image-fixtures.mjs';

const source = async (name) => readFile(new URL(`../app/${name}`, import.meta.url), 'utf8');
const managerSource = (await source('desktop/server-manager.js'))
  .replace(/^import.*;\r?\n/gm, '').replace(/export \{.*\};/, '');
const mainSource = await source('main.js');
const quitSource = mainSource.slice(mainSource.indexOf('async function requestQuit('),
  mainSource.indexOf("ipcMain.handle('server:get-state'"));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const beginUpload = (lifecycle) => {
  const res = new EventEmitter();
  let accepted = false;
  lifecycle.markUploadStarted({}, res, () => { accepted = true; });
  assert.equal(accepted, true);
  return res;
};

test('concurrent uploads finish exactly once and draining waits for both', async () => {
  const lifecycle = createUploadLifecycle();
  const a = beginUpload(lifecycle);
  assert.equal(lifecycle.status.activeUploads, 1);
  const b = beginUpload(lifecycle);
  assert.equal(lifecycle.status.activeUploads, 2);
  assert.equal(lifecycle.status.uploadInProgress, true);
  assert.equal(typeof lifecycle.status.lastUploadStartedAt, 'number');
  assert.equal(lifecycle.status.lastUploadFinishedAt, null);
  const drain = lifecycle.beginDrain();
  assert.equal(lifecycle.beginDrain(), drain, 'duplicate shutdown shares one deadline');
  let done = false;
  drain.then(() => { done = true; });
  a.emit('finish');
  a.emit('close');
  await flush();
  assert.equal(done, false);
  assert.equal(lifecycle.status.activeUploads, 1);
  assert.equal(lifecycle.status.uploadInProgress, true);
  assert.equal(lifecycle.status.uploadVersion, 1);
  b.emit('close');
  b.emit('finish');
  assert.equal(await drain, 'idle');
  assert.equal(lifecycle.status.activeUploads, 0);
  assert.equal(lifecycle.status.uploadInProgress, false);
  assert.equal(lifecycle.status.uploadVersion, 2);
  assert.equal(typeof lifecycle.status.lastUploadFinishedAt, 'number');
});

for (const count of [0, 1]) {
  test(`draining with ${count} uploads rejects HTTP uploads before Multer and preserves status`, async (t) => {
    const lifecycle = createUploadLifecycle();
    const active = count ? beginUpload(lifecycle) : null;
    const drain = lifecycle.beginDrain();
    assert.equal(lifecycle.status.draining, true);
    const before = JSON.stringify(lifecycle.status);
    const routeSource = (await source('server/routes/uploads.js'))
      .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/export \{.*\};/, '');
    const unexpected = () => assert.fail('rejected upload reached staging or validation');
    const createRouter = runInNewContext(`${routeSource}\ncreateUploadsRouter`, {
      Router: express.Router, uploadLifecycle: lifecycle,
      MAX_FILES: 10, upload: { array: () => unexpected },
      uploadErrorHandler: unexpected, validateUploadedFiles: unexpected,
      finalizeUploadedBatch: unexpected,
    });
    const app = express();
    app.use('/api', createRouter());
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const form = new FormData();
    form.append('photos', new Blob(['image bytes'], { type: 'image/png' }), 'new.png');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/upload`, { method: 'POST', body: form });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Server is shutting down. Please try again.' });
    assert.equal(JSON.stringify(lifecycle.status), before);
    const status = await fetch(`http://127.0.0.1:${server.address().port}/api/upload-status`).then((res) => res.json());
    assert.equal(status.draining, true);
    assert.equal(status.activeUploads, count);
    active?.emit('finish');
    assert.equal(await drain, 'idle');
  });
}

test('server drain timeout requires a decision and duplicate requests do not restart the five-minute limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings = [];
  const lifecycle = createUploadLifecycle({ logger: { warn: (message) => warnings.push(message) } });
  const active = beginUpload(lifecycle);
  const drain = lifecycle.beginDrain();
  let stopped = false;
  drain.then(() => { stopped = true; });
  t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(lifecycle.beginDrain(), drain);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(lifecycle.getDrainState().phase, 'decision');
  lifecycle.decideDrain({ ...lifecycle.getDrainState(), decision: 'continue' });
  assert.equal(await drain, 'continue');
  assert.equal(stopped, true);
  assert.equal(UPLOAD_DRAIN_TIMEOUT_MS, 300000);
  assert.match(warnings[0], /timed out after 300000 ms/);
  assert.equal(lifecycle.status.draining, true);
  active.emit('finish');
  active.emit('close');
  assert.equal(lifecycle.status.activeUploads, 0);
});

test('the real server shutdown function waits for the drain timeout before closing sockets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
  beginUpload(lifecycle);
  const serverSource = await source('server/index.js');
  const shutdownSource = serverSource.slice(serverSource.indexOf('const shutdownServer ='),
    serverSource.indexOf('const isDirectRun ='));
  const events = [];
  const shutdown = runInNewContext(`${shutdownSource}\nshutdownServer`, {
    uploadLifecycle: lifecycle, shutdownPromise: null, parentWatchTimer: null, console,
    appendStartupLog: async () => events.push('log'),
    stopServer: async () => events.push('close'),
    process: { connected: false, exit: (code) => events.push(`exit:${code}`) },
  });
  const pending = shutdown('electron-ipc');
  assert.equal(lifecycle.status.draining, true);
  assert.equal(shutdown('localhost-control'), pending);
  t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.deepEqual(events, []);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(events, []);
  lifecycle.decideDrain({ ...lifecycle.getDrainState(), decision: 'continue' });
  await pending;
  assert.deepEqual(events, ['log', 'close', 'exit:0']);
});

for (const installUpdate of [false, true]) {
  test(`${installUpdate ? 'Restart & Update' : 'normal quit'} sends owned shutdown then waits on the same cleanup path`, async () => {
    const lifecycle = createUploadLifecycle();
    const active = beginUpload(lifecycle);
    const events = [];
    const waitTimeouts = [];
    const child = new EventEmitter();
    child.exitCode = null;
    child.connected = true;
    child.kill = () => events.push('kill');
    child.send = () => {
      events.push('ipc');
      lifecycle.beginDrain().then(() => { child.exitCode = 0; child.emit('exit', 0); });
    };
    let spawned = false;
    const createManager = runInNewContext(`${managerSource}\ncreateServerManager`, {
      console, path, process, clearTimeout, waitForUploadDrain,
      setTimeout: (callback, ms) => { waitTimeouts.push(ms); return setTimeout(callback, ms); },
      spawn: () => { spawned = true; return child; },
      createServerClient: () => ({
        getServerIdentity: async () => spawned ? { shutdownToken: 'a'.repeat(64) } : null,
        isPortInUse: async () => false,
      }),
    });
    const manager = createManager({
      electronApp: { isPackaged: false }, getAutoCopyEnabled: () => false,
      getStartupLogPath: () => '', isQuitting: () => true,
      onStateChanged() {}, writeStartupLog: async () => {},
      projectRoot: '.', serverPath: 'app/server/index.js',
    });
    await manager.start();
    const context = {
      console, quitOperation: null, allowQuit: false, serverManager: manager,
      stopServer: () => manager.stop(),
      desktopShell: { destroyTray: () => events.push('tray') },
      electronApp: { quit: () => events.push('quit') },
      updateManager: { installDownloadedUpdate: () => { events.push('install'); return true; } },
    };
    const quit = runInNewContext(`${quitSource}\nrequestQuit`, context);
    const pending = quit({ installUpdate });
    await flush();
    assert.equal(lifecycle.status.draining, true);
    assert.deepEqual(events, ['ipc']);
    assert.deepEqual(waitTimeouts, [], 'the desktop must not force a stop while the server is draining');
    assert.equal(context.allowQuit, false);
    active.emit('finish');
    assert.equal(await pending, true);
    assert.deepEqual(events, ['ipc', 'tray', installUpdate ? 'install' : 'quit']);
  });
}

test('verified localhost shutdown is requested before waiting for the single server drain period', async () => {
  const lifecycle = createUploadLifecycle();
  const active = beginUpload(lifecycle);
  const events = [];
  const createManager = runInNewContext(`${managerSource}\ncreateServerManager`, {
    console, waitForUploadDrain,
    createServerClient: () => ({
      getServerIdentity: async () => ({ kind: 'current', shutdownToken: 'a'.repeat(64) }),
      watchServerShutdown: async (_token, observer) => lifecycle.subscribeDrain(observer.state),
      postServerShutdown: async () => { lifecycle.beginDrain(); events.push('request'); },
      waitForPortRelease: async (timeoutMs) => {
        events.push('wait');
        assert.equal(timeoutMs, 1000);
        await lifecycle.beginDrain();
        return true;
      },
    }),
  });
  const manager = createManager({ onStateChanged() {}, writeStartupLog: async () => {} });
  const pending = manager.stop();
  await flush();
  assert.equal(lifecycle.status.draining, true);
  assert.deepEqual(events, ['request']);
  assert.equal(manager.getState().state, 'stopping');
  active.emit('finish');
  await pending;
  assert.equal(manager.getState().state, 'offline');
});

const until = async (check) => {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail('condition did not become true');
};

const heldUpload = async (t, port) => {
  let req;
  const response = new Promise((resolve, reject) => {
    req = request({ host: '127.0.0.1', port, path: '/api/upload', method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=drain-test' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  response.catch(() => {});
  t.after(() => req.destroy());
  req.write('--drain-test\r\nContent-Disposition: form-data; name="photos"; filename="phone.png"\r\nContent-Type: image/png\r\n\r\n');
  req.write(await imageFixture('image/png'));
  return { response, finish: () => req.end('\r\n--drain-test--\r\n') };
};

for (const transport of ['ipc', 'localhost']) {
  test(`${transport} shutdown atomically closes admission and lets both real phone uploads finish`, { timeout: 15000 }, async (t) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const root = await mkdtemp(path.join(os.tmpdir(), 'snapoverlan-drain-'));
    const child = spawn(process.execPath, ['app/server/index.js'], {
      env: { ...process.env, SNAPOVERLAN_PORT: String(port), SNAPOVERLAN_DATA_DIR: root },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null) child.kill();
      await exited;
      assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await rm(root, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${port}/api`;
    await until(async () => {
      try { return (await fetch(`${url}/server-status`).then((res) => res.json())).status === 'listening'; }
      catch { return false; }
    });
    const status = () => fetch(`${url}/upload-status`).then((res) => res.json());
    const a = await heldUpload(t, port);
    const b = await heldUpload(t, port);
    await until(async () => (await status()).activeUploads === 2);
    const denied = await fetch(`${url}/server-shutdown`, { method: 'POST', headers: { 'x-snapoverlan-shutdown-token': 'wrong' } });
    assert.equal(denied.status, 404);
    assert.equal((await status()).draining, false);
    if (transport === 'ipc') {
      const accepted = new Promise((resolve) => child.on('message', (msg) => {
        if (msg.type === 'snapoverlan:shutdown-accepted') resolve();
      }));
      child.send({ type: 'snapoverlan:shutdown' });
      await accepted;
    } else {
      const control = await fetch(`${url}/server-control`).then((res) => res.json());
      const accepted = await fetch(`${url}/server-shutdown`, {
        method: 'POST', headers: { 'x-snapoverlan-shutdown-token': control.shutdownToken },
      });
      assert.equal(accepted.status, 202);
    }
    assert.equal((await status()).draining, true, 'admission is closed before shutdown acknowledgement');
    const staged = await readdir(path.join(root, 'upload-tmp'));
    const form = new FormData();
    form.append('photos', new Blob([await imageFixture('image/png')], { type: 'image/png' }), 'rejected.png');
    const rejected = await fetch(`${url}/upload`, { method: 'POST', body: form });
    assert.equal(rejected.status, 503);
    assert.equal((await status()).activeUploads, 2);
    assert.deepEqual(await readdir(path.join(root, 'upload-tmp')), staged);
    a.finish();
    assert.equal((await a.response).status, 200);
    assert.equal((await status()).activeUploads, 1);
    assert.equal(child.exitCode, null);
    b.finish();
    assert.equal((await b.response).status, 200);
    const [code] = await exited;
    assert.equal(code, 0, errors);
    assert.equal((await readdir(path.join(root, 'batches'))).length, 2);
  });
}
