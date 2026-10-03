import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import { imageFixture } from './helpers/image-fixtures.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-admission-'));
process.env.SNAPOVERLAN_DATA_DIR = root;
const { createUploadsRouter } = await import('../app/server/routes/uploads.js');
const { ensureStorageDirectories, listBatches } = await import('../app/server/storage.js');
const { uploadLifecycle } = await import('../app/server/upload-lifecycle.js');
const { MIN_UPLOAD_FREE_BYTES, MAX_FILES, MAX_FILE_SIZE, UPLOAD_TEMP_DIR } = await import('../app/server/config.js');
await ensureStorageDirectories();
const app = express();
app.use('/api', createUploadsRouter());
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(root, { recursive: true, force: true });
});
const send = async (sessionId) => {
  const form = new FormData();
  form.append('photos', new Blob([await imageFixture('image/png')], { type: 'image/png' }), 'phone.png');
  return fetch(`http://127.0.0.1:${server.address().port}/api/upload`, { method: 'POST', body: form,
    headers: sessionId ? { 'x-snapoverlan-send-session': sessionId } : {} });
};
const mockSpace = (t, bytes = MIN_UPLOAD_FREE_BYTES) => t.mock.method(fs, 'statfs', async (target, options) => {
  assert.equal(target, UPLOAD_TEMP_DIR);
  assert.deepEqual(options, { bigint: true });
  return { bavail: BigInt(bytes), bsize: 1n };
});
const assertSuccess = async () => {
  const response = await send();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).files.length, 1);
  assert.equal(uploadLifecycle.status.activeUploads, 0);
};

test('first upload holds admission during free-space check; busy request never stages or checks disk', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const check = t.mock.method(fs, 'statfs', async () => {
    entered();
    await gate;
    return { bavail: BigInt(MIN_UPLOAD_FREE_BYTES), bsize: 1n };
  });
  const first = send();
  await started;
  const before = JSON.stringify(uploadLifecycle.status);
  const second = await send();
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { error: 'Another upload is in progress. Try again shortly.' });
  assert.equal(check.mock.callCount(), 1);
  assert.equal(JSON.stringify(uploadLifecycle.status), before);
  assert.deepEqual(await fs.readdir(UPLOAD_TEMP_DIR), []);
  release();
  const response = await first;
  assert.equal(response.status, 200);
  await response.json();
  await assertSuccess();
});

test('below reserve plus maximum batch returns 507 before staging; exact threshold permits retry', async (t) => {
  assert.equal(MIN_UPLOAD_FREE_BYTES, 1024 ** 3 + MAX_FILES * MAX_FILE_SIZE);
  const before = await listBatches();
  const check = mockSpace(t, MIN_UPLOAD_FREE_BYTES - 1);
  const mkdir = t.mock.method(fs, 'mkdir', () => assert.fail('low disk upload entered staging'));
  const response = await send();
  assert.equal(response.status, 507);
  assert.deepEqual(await response.json(), { error: 'The PC needs more free disk space.' });
  assert.equal(uploadLifecycle.status.activeUploads, 0);
  assert.deepEqual(await fs.readdir(UPLOAD_TEMP_DIR), []);
  assert.deepEqual(await listBatches(), before);
  mkdir.mock.restore();
  check.mock.restore();
  mockSpace(t);
  await assertSuccess();
});

for (const code of ['ENOSPC', 'EDQUOT', 'EACCES']) {
  test(`${code} after staging cleans files, releases admission, and preserves error classification`, async (t) => {
    mockSpace(t);
    const before = await listBatches();
    let staged = false;
    const original = fs.rename;
    const rename = t.mock.method(fs, 'rename', async (...args) => {
      if (String(args[0]).endsWith('.upload')) {
        staged = (await fs.stat(args[0])).size > 0;
        throw Object.assign(new Error('simulated filesystem failure'), { code });
      }
      return original(...args);
    });
    const response = await send();
    assert.equal(response.status, code === 'EACCES' ? 400 : 507);
    assert.deepEqual(await response.json(), { error: code === 'EACCES'
      ? 'simulated filesystem failure' : 'The PC needs more free disk space.' });
    assert.equal(staged, true);
    assert.equal(uploadLifecycle.status.activeUploads, 0);
    assert.deepEqual(await fs.readdir(UPLOAD_TEMP_DIR), []);
    assert.deepEqual(await listBatches(), before);
    rename.mock.restore();
    await assertSuccess();
  });
}

for (const fails of [false, true]) {
  test(`session-associated upload ${fails ? 'failure' : 'success'} clears protection after guarded admission`, async (t) => {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const begun = await fetch(`${base}/send-session`, { method: 'POST' });
    const { sessionId } = await begun.json();
    assert.equal(begun.status, 200);
    assert.equal(uploadLifecycle.status.activeSendSessions, 1);
    assert.equal(uploadLifecycle.beginDrain({ onlyIfIdle: true }), null);
    const renewed = await fetch(`${base}/send-session/${sessionId}/renew`, { method: 'POST' });
    assert.equal(renewed.status, 200);
    const check = t.mock.method(fs, 'statfs', async () => {
      assert.equal(uploadLifecycle.status.activeSendSessions, 0);
      assert.equal(uploadLifecycle.status.activeUploads, 1);
      assert.equal(uploadLifecycle.beginDrain({ onlyIfIdle: true }), null);
      return { bavail: BigInt(fails ? 0 : MIN_UPLOAD_FREE_BYTES), bsize: 1n };
    });
    const response = await send(sessionId);
    assert.equal(response.status, fails ? 507 : 200);
    await response.json();
    assert.equal(check.mock.callCount(), 1);
    assert.equal(uploadLifecycle.status.uploadInProgress, false);
    assert.equal(uploadLifecycle.status.activeSendSessions, 0);
    const ended = await fetch(`${base}/send-session/${sessionId}/end`, { method: 'POST' });
    assert.equal(ended.status, 200);
    check.mock.restore();
    const replay = await send(sessionId);
    assert.equal(replay.status, 410);
    assert.equal(uploadLifecycle.status.uploadInProgress, false);
  });
}
