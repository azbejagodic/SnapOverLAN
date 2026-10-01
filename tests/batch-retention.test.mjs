import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { once } from 'node:events';
import express from 'express';
import { imageFixture } from './helpers/image-fixtures.mjs';

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-retention-'));
process.env.SNAPOVERLAN_DATA_DIR = dataRoot;

const {
  clearAllBatches,
  deleteBatch,
  ensureStorageDirectories,
  finalizeUploadedBatch,
  listBatches,
  listLatestFiles,
  selectBatch,
} = await import('../app/server/storage.js');

const batchesDir = path.join(dataRoot, 'batches');
const { createUploadsRouter } = await import('../app/server/routes/uploads.js');
const requests = [];
const events = [];
const app = express();
app.use((req, _res, next) => { requests.push(req); next(); });
app.use('/api', createUploadsRouter({ onUploadCompleted: (event) => events.push(event) }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  requests.length = 0;
  events.length = 0;
  await ensureStorageDirectories();
  await clearAllBatches();
});

async function createBatch(id, createdAt) {
  const batchDir = path.join(batchesDir, id);
  await fs.mkdir(batchDir, { recursive: true });
  await fs.writeFile(path.join(batchDir, '.batch.json'), `${JSON.stringify({ id, createdAt })}\n`);
  await fs.writeFile(path.join(batchDir, 'photo.jpg'), 'photo');
  return batchDir;
}

async function uploadPhoto() {
  const form = new FormData();
  form.append('photos', new Blob([await imageFixture('image/png')], { type: 'image/png' }), 'photo.png');
  return fetch(`http://127.0.0.1:${server.address().port}/api/upload`, { method: 'POST', body: form });
}

test('post-commit retention failure returns success and preserves the current upload', async (t) => {
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    createBatch(`batch_existing_${i}`, new Date(2000, 0, i + 1).toISOString())));
  const oldest = path.join(batchesDir, 'batch_existing_0');
  const failure = Object.assign(new Error('Old batch is locked'), { code: 'EPERM' });
  const originalRm = fs.rm;
  const rm = t.mock.method(fs, 'rm', async (target, options) => {
    if (target === oldest) throw failure;
    return originalRm(target, options);
  });
  const warn = t.mock.method(console, 'warn', () => {});
  const response = await uploadPhoto();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.files.length, 1);
  const req = requests.at(-1);
  assert.equal(req.uploadCommitted, true);
  const batches = await listBatches();
  assert.equal(batches.length, 51);
  assert.equal(batches.find((batch) => batch.current)?.id, req.uploadBatchId);
  assert.deepEqual(await fs.readFile(path.join(batchesDir, req.uploadBatchId, body.files[0].name)), await imageFixture('image/png'));
  assert.deepEqual(await listLatestFiles(), body.files);
  assert.equal(events.length, 1);
  assert.equal(events[0].batchId, req.uploadBatchId);
  assert.equal(warn.mock.calls.length, 1);
  assert.match(warn.mock.calls[0].arguments[0], /retention after committing upload/);
  assert.equal(warn.mock.calls[0].arguments[1], failure);
  assert.deepEqual(rm.mock.calls.find((call) => call.arguments[0] === oldest).arguments[1],
    { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  rm.mock.restore();
  await ensureStorageDirectories();
  assert.equal((await listBatches()).length, 50);
  assert.equal((await listBatches()).find((batch) => batch.current)?.id, req.uploadBatchId);
  await assert.rejects(fs.stat(oldest), { code: 'ENOENT' });
});

for (const stage of ['rename', 'metadata', 'current-batch']) {
  test(`pre-commit ${stage} failure still fails the upload`, async (t) => {
    await createBatch('batch_previous', '2000-01-01T00:00:00.000Z');
    await selectBatch('batch_previous');
    const method = 'rename';
    const original = fs[method];
    t.mock.method(fs, method, async (...args) => {
      const target = String(args[0]);
      if ((stage === 'rename' && path.dirname(target) === path.join(dataRoot, 'upload-tmp'))
        || (stage === 'metadata' && path.basename(String(args[1])) === '.batch.json')
        || (stage === 'current-batch' && args[1] === path.join(dataRoot, 'current-batch.json'))) {
        throw new Error(`Injected ${stage} failure`);
      }
      return original(...args);
    });
    const response = await uploadPhoto();
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, `Injected ${stage} failure`);
    assert.notEqual(requests.at(-1).uploadCommitted, true);
    assert.equal(events.length, 0);
    const batches = await listBatches();
    assert.deepEqual(batches.map((batch) => batch.id), ['batch_previous']);
    assert.equal(batches[0].current, true);
    assert.deepEqual(await fs.readdir(path.join(dataRoot, 'upload-tmp')), []);
  });
}

test('obsolete saved settings are ignored and preserved while old batches survive startup and uploads', async () => {
  const settingsPath = path.join(dataRoot, 'storage-settings.json');
  const savedSettings = '{"retentionDays":30}\n';
  await fs.writeFile(settingsPath, savedSettings);
  const oldAt = '2000-01-01T00:00:00.000Z';
  await createBatch('batch_old_at_startup', oldAt);
  await selectBatch('batch_old_at_startup');
  await ensureStorageDirectories();
  assert.equal((await listBatches()).find((batch) => batch.id === 'batch_old_at_startup')?.current, true);

  await createBatch('batch_old_before_upload', oldAt);
  const uploadId = 'batch_new_upload';
  const uploadDir = path.join(batchesDir, uploadId);
  await fs.mkdir(uploadDir, { recursive: true });
  const uploadPath = path.join(uploadDir, 'new-photo.jpg');
  await fs.writeFile(uploadPath, 'new photo');
  await finalizeUploadedBatch({
    files: [{ filename: 'new-photo.jpg', size: 9, path: uploadPath }],
    uploadBatchId: uploadId,
    uploadBatchCreatedAt: new Date().toISOString(),
  });

  const remainingIds = (await listBatches()).map((batch) => batch.id);
  assert.deepEqual(remainingIds.sort(), [uploadId, 'batch_old_at_startup', 'batch_old_before_upload'].sort());
  assert.equal(await fs.readFile(settingsPath, 'utf8'), savedSettings);
});

test('manual deletion preserves or reselects the current batch and clearing removes all batches', async () => {
  await createBatch('batch_old', '2000-01-01T00:00:00.000Z');
  await createBatch('batch_middle', '2010-01-01T00:00:00.000Z');
  await createBatch('batch_newest', '2020-01-01T00:00:00.000Z');
  await selectBatch('batch_middle');

  await deleteBatch('batch_old');
  assert.equal((await listBatches()).find((batch) => batch.current)?.id, 'batch_middle');
  await assert.rejects(fs.stat(path.join(batchesDir, 'batch_old')), { code: 'ENOENT' });

  await deleteBatch('batch_middle');
  assert.equal((await listBatches()).find((batch) => batch.current)?.id, 'batch_newest');
  await deleteBatch('batch_newest');
  assert.deepEqual(await listBatches(), []);
  assert.deepEqual(await listLatestFiles(), []);

  await createBatch('batch_clear', '2000-01-01T00:00:00.000Z');
  await selectBatch('batch_clear');
  await clearAllBatches();
  assert.deepEqual(await listBatches(), []);
  assert.deepEqual(await listLatestFiles(), []);
});

test('count retention leaves 50 saved batches unchanged', async () => {
  const now = Date.now();
  await Promise.all(Array.from({ length: 50 }, (_, index) => (
    createBatch(
      `batch_saved_${index + 1}`,
      new Date(now + (index * 1000)).toISOString(),
    )
  )));

  await ensureStorageDirectories();

  assert.equal((await listBatches()).length, 50);
});

test('startup retains only the newest 50 batches and reselects a removed current batch', async () => {
  const now = Date.now() - 60000;
  await Promise.all(Array.from({ length: 53 }, (_, index) => (
    createBatch(
      `batch_startup_${index + 1}`,
      new Date(now + (index * 1000)).toISOString(),
    )
  )));
  await selectBatch('batch_startup_1');

  await ensureStorageDirectories();

  const batches = await listBatches();
  assert.deepEqual(batches.map((batch) => batch.id),
    Array.from({ length: 50 }, (_, index) => `batch_startup_${53 - index}`));
  assert.equal(batches[0].current, true);
});

test('saving a 51st batch removes the oldest and keeps the 50 newest', async () => {
  const now = Date.now() - 60000;
  await Promise.all(Array.from({ length: 50 }, (_, index) => (
    createBatch(
      `batch_existing_${index + 1}`,
      new Date(now + (index * 1000)).toISOString(),
    )
  )));
  const uploadId = 'batch_newest_upload';
  const uploadDir = path.join(batchesDir, uploadId);
  await fs.mkdir(uploadDir, { recursive: true });
  const uploadPath = path.join(uploadDir, 'newest-photo.jpg');
  await fs.writeFile(uploadPath, 'newest photo');

  await finalizeUploadedBatch({
    files: [{ filename: 'newest-photo.jpg', size: 12, path: uploadPath }],
    uploadBatchId: uploadId,
    uploadBatchCreatedAt: new Date().toISOString(),
  });

  const remainingIds = (await listBatches()).map((batch) => batch.id);
  assert.deepEqual(remainingIds, [
    uploadId,
    ...Array.from({ length: 49 }, (_, index) => `batch_existing_${50 - index}`),
  ]);
});

test('count retention preserves the newest upload as the current batch', async () => {
  const now = Date.now() - 60000;
  await Promise.all(Array.from({ length: 50 }, (_, index) => (
    createBatch(
      `batch_current_test_${index + 1}`,
      new Date(now + (index * 1000)).toISOString(),
    )
  )));
  await selectBatch('batch_current_test_1');
  const uploadId = 'batch_current_newest';
  const uploadDir = path.join(batchesDir, uploadId);
  await fs.mkdir(uploadDir, { recursive: true });
  const uploadPath = path.join(uploadDir, 'current-photo.jpg');
  await fs.writeFile(uploadPath, 'current photo');

  await finalizeUploadedBatch({
    files: [{ filename: 'current-photo.jpg', size: 13, path: uploadPath }],
    uploadBatchId: uploadId,
    uploadBatchCreatedAt: new Date().toISOString(),
  });

  const batches = await listBatches();
  assert.equal(batches.length, 50);
  assert.equal(batches[0].id, uploadId);
  assert.equal(batches[0].current, true);
  assert.deepEqual((await listLatestFiles()).map((file) => file.name), ['current-photo.jpg']);
});
