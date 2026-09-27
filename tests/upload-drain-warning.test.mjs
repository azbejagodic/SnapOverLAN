import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { createUploadLifecycle, UPLOAD_DRAIN_TIMEOUT_MS } from '../app/server/upload-lifecycle.js';
import { waitForUploadDrain } from '../app/desktop/upload-drain.js';
import { createServerClient } from '../app/desktop/server-client.js';
import { createSystemRouter } from '../app/server/routes/system.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const mainSource = await readFile(new URL('../app/main.js', import.meta.url), 'utf8');
const promptSource = mainSource.slice(mainSource.indexOf('  onUploadDrainTimeout:'), mainSource.indexOf('  onStateChanged: handleServerStateChanged'));
const makePrompt = (showMessageBox) => runInNewContext(`({${promptSource}}).onUploadDrainTimeout`, { dialog: { showMessageBox } });
const beginUpload = (lifecycle) => {
  const res = new EventEmitter();
  lifecycle.markUploadStarted({}, res, () => {});
  return res;
};
const assertAdmissionClosed = (lifecycle) => {
  const before = lifecycle.status.activeUploads;
  let status;
  lifecycle.markUploadStarted({}, {
    status: (code) => { status = code; return { json() {} }; },
  }, () => assert.fail('new upload admitted while draining'));
  assert.equal(status, 503);
  assert.equal(lifecycle.status.activeUploads, before);
  assert.equal(lifecycle.status.draining, true);
};
const monitor = (lifecycle, askToContinue) => waitForUploadDrain({
  subscribe: ({ state }) => lifecycle.subscribeDrain(state),
  start: () => { lifecycle.beginDrain(); },
  decide: (decision) => lifecycle.decideDrain(decision),
  askToContinue,
});

test('native warning uses the requested text and defaults cancellation to Keep waiting', async () => {
  for (const response of [0, 1]) {
    const signal = new AbortController().signal;
    const ask = makePrompt(async (options) => {
      assert.equal(options.type, 'warning');
      assert.equal(options.title, 'Upload is still in progress');
      assert.equal(options.message, 'SnapOverLAN has been waiting 5 minutes for an upload to finish. The connection may have been interrupted.');
      assert.deepEqual(Array.from(options.buttons), ['Keep waiting', 'Continue anyway']);
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      assert.equal(options.signal, signal);
      return { response };
    });
    assert.equal(await ask({ signal }), response === 1 ? 'continue' : 'wait');
  }
});

for (const active of [false, true]) {
  test(`${active ? 'upload finishing before timeout' : 'zero uploads'} shuts down without any warning`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const lifecycle = createUploadLifecycle();
    const upload = active ? beginUpload(lifecycle) : null;
    const ready = monitor(lifecycle, () => assert.fail('unnecessary dialog'));
    await flush();
    if (active) { t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS - 1); upload.emit('finish'); }
    await ready;
    t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS * 2);
    assert.equal(lifecycle.getDrainState().phase, 'ready');
  });
}

test('Keep waiting repeats a single bounded period and finishing during the second wait shuts down', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
  const upload = beginUpload(lifecycle);
  const choice = deferred();
  let dialogs = 0;
  const ready = monitor(lifecycle, () => { dialogs += 1; return choice.promise; });
  await flush();
  t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS);
  await flush();
  assert.equal(dialogs, 1);
  assert.equal(lifecycle.getDrainState().phase, 'decision');
  assertAdmissionClosed(lifecycle);
  const expired = lifecycle.getDrainState();
  t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS * 3);
  await flush();
  assert.equal(dialogs, 1, 'there is no running timer while the warning is open');
  choice.resolve('wait');
  await flush();
  assert.equal(lifecycle.getDrainState().phase, 'waiting');
  assert.equal(lifecycle.decideDrain({ ...expired, decision: 'wait' }), false);
  assertAdmissionClosed(lifecycle);
  t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS - 1);
  upload.emit('finish');
  await ready;
  t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS * 2);
  assert.equal(dialogs, 1);
});

test('repeated Keep waiting cannot overlap timers or restart draining', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
  const upload = beginUpload(lifecycle);
  let dialogs = 0;
  const ready = monitor(lifecycle, async () => { dialogs += 1; return 'wait'; });
  await flush();
  const original = lifecycle.beginDrain();
  for (let period = 1; period <= 3; period += 1) {
    t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS - 1);
    await flush();
    assert.equal(dialogs, period - 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(dialogs, period);
    assert.equal(lifecycle.beginDrain(), original);
    assertAdmissionClosed(lifecycle);
  }
  upload.emit('finish');
  await ready;
});

test('upload finishing with a warning open cancels the dialog and ignores its late answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
  const upload = beginUpload(lifecycle);
  const choice = deferred();
  let signal;
  const ready = monitor(lifecycle, (options) => { signal = options.signal; return choice.promise; });
  await flush();
  t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS);
  await flush();
  assert.equal(signal.aborted, false);
  upload.emit('finish');
  await ready;
  assert.equal(signal.aborted, true);
  choice.resolve('wait');
  await flush();
  assert.equal(lifecycle.getDrainState().phase, 'ready');
});

for (const installUpdate of [false, true]) {
  test(`${installUpdate ? 'Restart & Update' : 'normal Quit'} waits for the native decision through owned IPC cleanup`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
    beginUpload(lifecycle);
    const choice = deferred();
    const events = [];
    const child = new EventEmitter();
    child.exitCode = null;
    child.connected = true;
    child.kill = () => assert.fail('must not force shutdown during drain or dialog');
    lifecycle.subscribeDrain((state) => child.emit('message', { type: 'snapoverlan:drain-state', ...state }));
    child.send = (message) => {
      if (message.type === 'snapoverlan:drain-decision') { lifecycle.decideDrain(message); return; }
      lifecycle.beginDrain().then(() => { child.exitCode = 0; child.emit('exit', 0); });
    };
    let spawned = false;
    const managerSource = (await readFile(new URL('../app/desktop/server-manager.js', import.meta.url), 'utf8'))
      .replace(/^import.*;\r?\n/gm, '').replace(/export \{.*\};/, '');
    const createManager = runInNewContext(`${managerSource}\ncreateServerManager`, {
      path, process, console, setTimeout, clearTimeout, waitForUploadDrain,
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
      onUploadDrainTimeout: makePrompt(() => { events.push('warning'); return choice.promise; }),
    });
    await manager.start();
    const quitSource = mainSource.slice(mainSource.indexOf('async function requestQuit('), mainSource.indexOf("ipcMain.handle('server:get-state'"));
    const quit = runInNewContext(`${quitSource}\nrequestQuit`, {
      console, quitOperation: null, allowQuit: false, serverManager: manager,
      stopServer: () => manager.stop(),
      desktopShell: { destroyTray: () => events.push('tray') },
      electronApp: { quit: () => events.push('quit') },
      updateManager: { installDownloadedUpdate: () => { events.push('install'); return true; } },
    });
    const pending = quit({ installUpdate });
    await flush();
    t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS);
    await flush();
    assert.deepEqual(events, ['warning']);
    t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS * 2);
    assert.deepEqual(events, ['warning']);
    assertAdmissionClosed(lifecycle);
    choice.resolve({ response: 1 });
    assert.equal(await pending, true);
    assert.deepEqual(events, ['warning', 'tray', installUpdate ? 'install' : 'quit']);
    assert.equal(lifecycle.status.activeUploads, 1, 'Continue anyway permits shutdown with an unfinished upload');
  });
}

test('authenticated localhost stream delivers timeout and accepts Keep waiting and Continue anyway', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
  beginUpload(lifecycle);
  const token = 'b'.repeat(64);
  const app = express();
  let stopped = false;
  app.use('/api', express.json(), createSystemRouter({
    getServerStatus: () => ({}), isLoopbackRequest: () => true,
    shutdownToken: token, drainLifecycle: lifecycle,
    onShutdown: () => { lifecycle.beginDrain().then(() => { stopped = true; }); },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const port = server.address().port;
  const client = createServerClient({ port });
  await assert.rejects(client.watchServerShutdown('wrong', {}), /404/);
  await assert.rejects(client.postServerShutdown('wrong'), /404/);
  const prompts = [];
  const choices = [deferred(), deferred()];
  const notices = [deferred(), deferred()];
  const watching = deferred();
  const ready = waitForUploadDrain({
    subscribe: async (observer) => client.watchServerShutdown(token, {
      ...observer, state: (value) => { observer.state(value); if (value.phase === 'waiting') watching.resolve(); },
    }),
    start: () => client.postServerShutdown(token),
    decide: (decision) => client.postServerShutdown(token, decision),
    askToContinue: () => {
      const index = prompts.length;
      prompts.push(true);
      notices[index].resolve();
      return choices[index].promise;
    },
  });
  await watching.promise;
  t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS);
  await notices[0].promise;
  assert.equal(stopped, false);
  assertAdmissionClosed(lifecycle);
  const waitingAgain = deferred();
  const unsubscribe = lifecycle.subscribeDrain((value) => { if (value.phase === 'waiting') waitingAgain.resolve(); });
  choices[0].resolve('wait');
  await waitingAgain.promise;
  unsubscribe();
  t.mock.timers.tick(UPLOAD_DRAIN_TIMEOUT_MS);
  await notices[1].promise;
  assert.equal(stopped, false);
  choices[1].resolve('continue');
  await ready;
  await flush();
  assert.equal(stopped, true);
  assert.equal(prompts.length, 2);
});
