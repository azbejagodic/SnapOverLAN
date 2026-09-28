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

const serverSource = await source('server/index.js');
const makeShutdownHarness = (lifecycle) => {
  const events = [];
  const fakeProcess = new EventEmitter();
  Object.assign(fakeProcess, {
    env: { SNAPOVERLAN_PARENT_PID: '123' }, connected: false,
    exit: (code) => events.push(`exit:${code}`),
    kill: () => { throw Object.assign(new Error('parent gone'), { code: 'ESRCH' }); },
  });
  const context = {
    uploadLifecycle: lifecycle, shutdownPromise: null, parentWatchTimer: null, console,
    process: fakeProcess, setInterval, clearInterval,
    appendStartupLog: async () => events.push('log'),
    stopServer: async () => events.push('close'),
    startServer: async () => {}, handleAutoCopySettingResponse: () => false,
  };
  const shutdownSource = serverSource.slice(serverSource.indexOf('const watchParentProcess ='),
    serverSource.indexOf('const isDirectRun ='));
  const handlers = serverSource.slice(serverSource.indexOf('if (isDirectRun) {'), serverSource.indexOf('\nexport {'));
  const shutdown = runInNewContext(`${shutdownSource}\nconst isDirectRun = true;\n${handlers}\nshutdownServer`, context);
  return { events, fakeProcess, shutdown };
};

for (const trigger of ['SIGINT', 'SIGTERM', 'disconnect', 'parent-exited', 'server-only']) {
  for (const phase of ['fresh', 'waiting']) {
    test(`${trigger} during ${phase} cannot leave shutdown waiting for a dialog`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
      beginUpload(lifecycle);
      const { events, fakeProcess, shutdown } = makeShutdownHarness(lifecycle);
      if (phase !== 'fresh') shutdown('electron-ipc');
      if (phase === 'waiting') {
        fakeProcess.kill = () => {};
        t.mock.timers.tick(10000);
      }
      if (trigger === 'parent-exited') {
        fakeProcess.kill = () => { throw Object.assign(new Error('parent gone'), { code: 'ESRCH' }); };
        t.mock.timers.tick(2000);
      } else if (trigger === 'server-only') shutdown(trigger);
      else fakeProcess.emit(trigger);
      assert.equal(lifecycle.status.draining, true);
      // A later user-controlled request cannot restore an indefinite decision wait.
      const pending = shutdown('electron-ipc');
      if (phase !== 'decision') {
        const remaining = phase === 'waiting' ? 50000 : 60000;
        t.mock.timers.tick(remaining - (trigger === 'parent-exited' && phase === 'waiting' ? 2000 : 0) - 1);
        await flush();
        assert.deepEqual(events, []);
        t.mock.timers.tick(1);
      }
      await pending;
      assert.deepEqual(events, ['log', 'close', 'exit:0']);
      assert.equal(lifecycle.getDrainState().phase, 'ready');
    });
  }
}

test('server-only shutdown with no uploads exits without advancing time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const lifecycle = createUploadLifecycle();
  const { shutdown, events } = makeShutdownHarness(lifecycle);
  await shutdown('server-only');
  assert.equal(lifecycle.status.draining, true);
  assert.deepEqual(events, ['log', 'close', 'exit:0']);
});

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

test('production emergency timeout is 60 seconds and duplicate requests preserve the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(UPLOAD_DRAIN_TIMEOUT_MS, 60000);
  const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
  beginUpload(lifecycle);
  const pending = lifecycle.beginDrain();
  t.mock.timers.tick(59999);
  assert.equal(lifecycle.getDrainState().phase, 'waiting');
  assert.equal(lifecycle.beginDrain(), pending);
  t.mock.timers.tick(1);
  assert.equal(await pending, 'continue');
  assert.equal(lifecycle.getDrainState().phase, 'ready');
});

test('headless shutdown completes early when the last upload finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const lifecycle = createUploadLifecycle();
  const active = beginUpload(lifecycle);
  const { shutdown, events } = makeShutdownHarness(lifecycle);
  const pending = shutdown('SIGTERM');
  active.emit('finish');
  await pending;
  assert.deepEqual(events, ['log', 'close', 'exit:0']);
});

test('idle-only shutdown atomically rejects active uploads without state changes or timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lifecycle = createUploadLifecycle({ logger: { warn() { assert.fail('timer started'); } } });
  const a = beginUpload(lifecycle);
  const before = JSON.stringify(lifecycle.status);
  assert.equal(lifecycle.beginDrain({ onlyIfIdle: true }), null);
  assert.equal(JSON.stringify(lifecycle.status), before);
  assert.equal(lifecycle.getDrainState().phase, 'idle');
  const b = beginUpload(lifecycle);
  a.emit('finish');
  assert.equal(lifecycle.beginDrain({ onlyIfIdle: true }), null);
  t.mock.timers.tick(120000);
  b.emit('finish');
  assert.equal(await lifecycle.beginDrain({ onlyIfIdle: true }), 'idle');
  let rejected;
  lifecycle.markUploadStarted({}, { status: (code) => { rejected = code; return { json() {} }; } }, () => assert.fail('admitted after shutdown accepted'));
  assert.equal(rejected, 503);
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
      const blocked = new Promise((resolve) => {
        const listener = (message) => {
          if (message.type !== 'snapoverlan:shutdown-blocked') return;
          child.removeListener('message', listener);
          resolve();
        };
        child.on('message', listener);
      });
      child.send({ type: 'snapoverlan:shutdown', onlyIfIdle: true });
      await blocked;
    } else {
      const control = await fetch(`${url}/server-control`).then((res) => res.json());
      const blocked = await fetch(`${url}/server-shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-snapoverlan-shutdown-token': control.shutdownToken },
        body: JSON.stringify({ onlyIfIdle: true }),
      });
      assert.equal(blocked.status, 409);
    }
    assert.equal((await status()).draining, false, 'user shutdown rejection never locks admission');
    assert.equal(child.exitCode, null);
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
