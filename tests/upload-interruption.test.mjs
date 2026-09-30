import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import { imageFixture } from './helpers/image-fixtures.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'snapoverlan-interrupted-'));
process.env.SNAPOVERLAN_DATA_DIR = root;
const { createUploadsRouter } = await import('../app/server/routes/uploads.js');
const { ensureStorageDirectories, listBatches } = await import('../app/server/storage.js');
const { uploadLifecycle } = await import('../app/server/upload-lifecycle.js');
await ensureStorageDirectories();
const events = [];
const requests = [];
const app = express();
app.use((req, _res, next) => { if (req.method === 'POST') requests.push(req); next(); });
app.use('/api', createUploadsRouter({ onUploadCompleted: (event) => events.push(event) }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(root, { recursive: true, force: true });
});
const until = async (condition) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition did not become true');
};
const send = async (bytes, type = 'image/png') => {
  const form = new FormData();
  form.append('photos', new Blob([bytes], { type }), 'phone.png');
  return fetch(`http://127.0.0.1:${port}/api/upload`, { method: 'POST', body: form });
};

test('successful upload completes normally, retains its batch, and emits exactly one auto-copy event', async () => {
  const response = await send(await imageFixture('image/png'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).files.length, 1);
  await until(() => uploadLifecycle.status.activeUploads === 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'snapoverlan:upload-completed');
  assert.equal(requests.at(-1).uploadInterrupted, undefined);
  assert.equal((await listBatches()).length, 1);
  assert.deepEqual(await readdir(path.join(root, 'upload-tmp')), []);
});

test('disconnect during multipart removes partial staging, returns idle, and never finalizes or emits an event', async (t) => {
  const batchesBefore = await listBatches();
  const eventsBefore = events.length;
  const versionBefore = uploadLifecycle.status.uploadVersion;
  const req = request({ host: '127.0.0.1', port, path: '/api/upload', method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=phone-test' } });
  req.on('error', () => {});
  t.after(() => req.destroy());
  req.write('--phone-test\r\nContent-Disposition: form-data; name="photos"; filename="phone.png"\r\nContent-Type: image/png\r\n\r\n');
  req.write(Buffer.alloc(65536, 1));
  // Synchronize on a real partial file, rather than aborting after an arbitrary delay.
  await until(async () => {
    const dirs = await readdir(path.join(root, 'upload-tmp'));
    if (!dirs.length) return false;
    const dir = path.join(root, 'upload-tmp', dirs[0]);
    const files = await readdir(dir);
    return files.length > 0 && (await stat(path.join(dir, files[0]))).size > 0;
  });
  const serverReq = requests.at(-1);
  assert.equal(uploadLifecycle.status.activeUploads, 1);
  const aborted = once(serverReq, 'aborted');
  req.destroy();
  await aborted;
  await until(() => uploadLifecycle.status.activeUploads === 0);
  await serverReq.uploadProcessing;
  assert.equal(serverReq.aborted, true);
  assert.equal(serverReq.complete, false);
  assert.equal(serverReq.uploadInterrupted, true);
  assert.equal(uploadLifecycle.status.uploadInProgress, false);
  assert.equal(uploadLifecycle.status.uploadVersion, versionBefore + 1);
  assert.deepEqual(await readdir(path.join(root, 'upload-tmp')), []);
  assert.deepEqual(await listBatches(), batchesBefore);
  assert.equal(events.length, eventsBefore);
});

for (const [name, bytes, type] of [
  ['invalid image', Buffer.from('invalid image bytes'), 'image/png'],
  ['unsupported MIME', Buffer.from('text'), 'text/plain'],
]) {
  test(`${name} still returns a validation error and cleans staging`, async () => {
    const before = await listBatches();
    const eventsBefore = events.length;
    const response = await send(bytes, type);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
    await until(() => uploadLifecycle.status.activeUploads === 0);
    assert.equal(requests.at(-1).uploadInterrupted, undefined);
    assert.deepEqual(await readdir(path.join(root, 'upload-tmp')), []);
    assert.deepEqual(await listBatches(), before);
    assert.equal(events.length, eventsBefore);
  });
}

for (const phase of ['destination creation', 'image validation']) {
  test(`disconnect during ${phase} waits for pending disk work before cleanup and idle`, async (t) => {
    const before = await listBatches();
    const eventsBefore = events.length;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const method = phase === 'destination creation' ? 'mkdir' : 'rename';
    const original = fs[method];
    t.mock.method(fs, method, async (...args) => {
      if (String(args[0]).startsWith(path.join(root, 'upload-tmp'))) {
        entered();
        await gate;
      }
      return original(...args);
    });
    const req = request({ host: '127.0.0.1', port, path: '/api/upload', method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=phone-test' } });
    req.on('error', () => {});
    t.after(() => req.destroy());
    req.write('--phone-test\r\nContent-Disposition: form-data; name="photos"; filename="phone.png"\r\nContent-Type: image/png\r\n\r\n');
    req.write(await imageFixture('image/png'));
    if (phase === 'image validation') req.end('\r\n--phone-test--\r\n');
    await started;
    const serverReq = requests.at(-1);
    req.destroy();
    await until(() => serverReq.uploadInterrupted === true);
    assert.equal(uploadLifecycle.status.activeUploads, 1, 'cleanup must settle before reporting idle');
    const stagedBefore = await readdir(path.join(root, 'upload-tmp'));
    const busy = await send(await imageFixture('image/png'));
    assert.equal(busy.status, 429);
    assert.deepEqual(await busy.json(), { error: 'Another upload is in progress. Try again shortly.' });
    assert.deepEqual(await readdir(path.join(root, 'upload-tmp')), stagedBefore);
    assert.equal(uploadLifecycle.status.activeUploads, 1);
    if (phase === 'image validation') {
      assert.equal(serverReq.complete, true, 'a complete HTTP body can disconnect before validation finishes');
      assert.equal(serverReq.aborted, false);
    }
    release();
    await serverReq.uploadProcessing;
    await until(() => uploadLifecycle.status.activeUploads === 0);
    assert.deepEqual(await readdir(path.join(root, 'upload-tmp')), []);
    assert.deepEqual(await listBatches(), before);
    assert.equal(events.length, eventsBefore);
    const retry = await send(await imageFixture('image/png'));
    assert.equal(retry.status, 200);
    await retry.json();
    await until(() => uploadLifecycle.status.activeUploads === 0);
  });
}
