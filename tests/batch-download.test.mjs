import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { downloadBatchToFolder } from '../app/desktop/batch-download.js';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-download-'));
const serverDataRoot = path.join(testRoot, 'server-data');
process.env.SNAPOVERLAN_DATA_DIR = serverDataRoot;
const [{ createServerApp }, { ensureStorageDirectories, listBatches, selectBatch }] = await Promise.all([
  import('../app/server/app.js'),
  import('../app/server/storage.js'),
]);
after(() => fs.rm(testRoot, { recursive: true, force: true }));

const arrayBufferFrom = (value) => {
  const buffer = Buffer.from(value);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

const createBatchFetch = ({ batchId, files }) => async (url) => {
  const parsed = new URL(url);
  const batchPath = `/api/batches/${encodeURIComponent(batchId)}`;
  if (parsed.pathname === batchPath) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: batchId,
        files: files.map(({ name, bytes }) => ({ name, size: Buffer.byteLength(bytes) })),
      }),
    };
  }
  const filePrefix = `${batchPath}/files/`;
  if (parsed.pathname.startsWith(filePrefix)) {
    const name = decodeURIComponent(parsed.pathname.slice(filePrefix.length));
    const file = files.find((candidate) => candidate.name === name);
    if (file) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => arrayBufferFrom(file.bytes),
      };
    }
  }
  return { ok: false, status: 404 };
};

test('desktop batch download preserves every original filename, format, and byte', async () => {
  const batchId = 'batch_original_files';
  const destinationDir = path.join(testRoot, 'originals');
  await fs.mkdir(destinationDir);
  const files = [
    { name: 'holiday photo.webp', bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]) },
    { name: 'clip.MOV', bytes: Buffer.from([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70]) },
    { name: 'camera-original.jpg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
  ];

  const result = await downloadBatchToFolder({
    batchId,
    destinationDir,
    fetchImpl: createBatchFetch({ batchId, files }),
    serverOrigin: 'http://localhost:8787',
  });

  assert.equal(result.savedCount, 3);
  assert.deepEqual(result.filenames, files.map((file) => file.name));
  for (const file of files) {
    assert.deepEqual(await fs.readFile(path.join(destinationDir, file.name)), file.bytes);
  }
});

test('desktop batch download adds numeric suffixes instead of overwriting files', async () => {
  const batchId = 'batch_duplicate_names';
  const destinationDir = path.join(testRoot, 'duplicates');
  await fs.mkdir(destinationDir);
  await fs.writeFile(path.join(destinationDir, 'photo.jpg'), 'existing file');
  await fs.writeFile(path.join(destinationDir, 'photo (1).jpg'), 'another existing file');
  const files = [{ name: 'photo.jpg', bytes: Buffer.from('downloaded file') }];

  const result = await downloadBatchToFolder({
    batchId,
    destinationDir,
    fetchImpl: createBatchFetch({ batchId, files }),
    serverOrigin: 'http://localhost:8787',
  });

  assert.deepEqual(result.filenames, ['photo (2).jpg']);
  assert.equal(await fs.readFile(path.join(destinationDir, 'photo.jpg'), 'utf8'), 'existing file');
  assert.equal(await fs.readFile(path.join(destinationDir, 'photo (1).jpg'), 'utf8'), 'another existing file');
  assert.equal(await fs.readFile(path.join(destinationDir, 'photo (2).jpg'), 'utf8'), 'downloaded file');
});

test('desktop batch download rejects unsafe server filenames', async () => {
  const batchId = 'batch_unsafe_name';
  const destinationDir = path.join(testRoot, 'unsafe');
  await fs.mkdir(destinationDir);

  await assert.rejects(
    downloadBatchToFolder({
      batchId,
      destinationDir,
      fetchImpl: createBatchFetch({
        batchId,
        files: [{ name: '../outside.jpg', bytes: Buffer.from('unsafe') }],
      }),
      serverOrigin: 'http://localhost:8787',
    }),
    /invalid batch filename/i,
  );
  assert.deepEqual(await fs.readdir(destinationDir), []);
});

test('batch-specific server route returns original file bytes without changing selection', async (t) => {
  await ensureStorageDirectories();
  const batchId = 'batch_route_download';
  const batchDir = path.join(serverDataRoot, 'batches', batchId);
  await fs.mkdir(batchDir, { recursive: true });
  await fs.writeFile(
    path.join(batchDir, '.batch.json'),
    `${JSON.stringify({ id: batchId, createdAt: new Date().toISOString() })}\n`,
  );
  const filename = 'untouched-original.webp';
  const originalBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x20]);
  await fs.writeFile(path.join(batchDir, filename), originalBytes);
  const selectedBatchId = 'batch_stays_selected';
  const selectedBatchDir = path.join(serverDataRoot, 'batches', selectedBatchId);
  await fs.mkdir(selectedBatchDir, { recursive: true });
  await fs.writeFile(
    path.join(selectedBatchDir, '.batch.json'),
    `${JSON.stringify({ id: selectedBatchId, createdAt: new Date(0).toISOString() })}\n`,
  );
  await fs.writeFile(path.join(selectedBatchDir, 'selected.jpg'), 'selected');
  await selectBatch(selectedBatchId);
  const app = createServerApp({
    getServerStatus: () => ({ status: 'listening' }),
    isLoopbackRequest: () => true,
    onShutdown: () => {},
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  ))));

  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/api/batches/${batchId}/files/${encodeURIComponent(filename)}`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), originalBytes);
  assert.equal((await listBatches()).find((batch) => batch.current)?.id, selectedBatchId);
});
