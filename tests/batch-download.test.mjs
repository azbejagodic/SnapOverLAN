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
    { name: 'phone-original.heic', bytes: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]) },
    { name: 'camera-original.jpg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
  ];
  const signals = [];
  const fetchBatch = createBatchFetch({ batchId, files });

  const result = await downloadBatchToFolder({
    batchId,
    destinationDir,
    fetchImpl: (url, { signal }) => {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      signals.push(signal);
      return fetchBatch(url);
    },
    serverOrigin: 'http://localhost:8787',
  });

  assert.equal(result.savedCount, 3);
  assert.equal(new Set(signals).size, 4, 'metadata and each file have independent deadlines');
  assert.deepEqual(result.filenames, files.map((file) => file.name));
  assert.deepEqual((await fs.readdir(destinationDir)).sort(), files.map((file) => file.name).sort());
  for (const file of files) {
    assert.deepEqual(await fs.readFile(path.join(destinationDir, file.name)), file.bytes);
  }
});

for (const request of ['metadata', 'file']) {
  for (const phase of ['headers', 'body']) {
    test(`${request} timeout during ${phase} has stable text and preserves saved files for retry`, async (t) => {
      const controllers = [];
      t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
        assert.equal(milliseconds, 30_000);
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      });
      const batchId = 'batch_timeout';
      const destinationDir = path.join(testRoot, `timeout-${request}-${phase}`);
      await fs.mkdir(destinationDir);
      const files = [
        { name: 'first.jpg', bytes: 'first original' },
        { name: 'second.jpg', bytes: 'second original' },
      ];
      const fetchBatch = createBatchFetch({ batchId, files });
      const fetchImpl = async (url, { signal }) => {
        assert.equal(signal, controllers.at(-1).signal);
        const target = request === 'metadata'
          ? !url.pathname.includes('/files/') : url.pathname.endsWith('/second.jpg');
        if (!target) return fetchBatch(url);
        const timeout = () => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          controllers.at(-1).abort(new DOMException('deadline exceeded', 'TimeoutError'));
        });
        if (phase === 'headers') return timeout();
        return { ok: true, json: timeout, arrayBuffer: timeout };
      };
      await assert.rejects(downloadBatchToFolder({
        batchId, destinationDir, fetchImpl, serverOrigin: 'http://localhost:8787',
      }), { message: 'Download timed out. Please try again.' });
      assert.deepEqual(await fs.readdir(destinationDir), request === 'file' ? ['first.jpg'] : []);
      if (request === 'file') {
        assert.equal(await fs.readFile(path.join(destinationDir, 'first.jpg'), 'utf8'), 'first original');
      }
      const retry = await downloadBatchToFolder({
        batchId, destinationDir, fetchImpl: fetchBatch, serverOrigin: 'http://localhost:8787',
      });
      assert.deepEqual(retry.filenames, request === 'file' ? ['first (1).jpg', 'second.jpg'] : ['first.jpg', 'second.jpg']);
      assert.equal(await fs.readFile(path.join(destinationDir, 'first.jpg'), 'utf8'), 'first original');
    });
  }
}

for (const request of ['metadata', 'file']) {
  test(`${request} HTTP failure retains the existing status error`, async () => {
    await assert.rejects(downloadBatchToFolder({
      batchId: 'batch_missing', destinationDir: testRoot, serverOrigin: 'http://localhost:8787',
      fetchImpl: async (url) => request === 'file' && !url.pathname.includes('/files/')
        ? { ok: true, json: async () => ({ files: [{ name: 'missing.jpg' }] }) }
        : { ok: false, status: 404 },
    }), { message: 'Download failed (404).' });
  });
}

test('ordinary request errors propagate without becoming timeout errors', async () => {
  const error = new TypeError('fetch failed');
  await assert.rejects(downloadBatchToFolder({
    batchId: 'batch_network', destinationDir: testRoot, serverOrigin: 'http://localhost:8787',
    fetchImpl: async () => { throw error; },
  }), (received) => received === error);
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

for (const phase of ['write', 'publication']) {
  test(`${phase} failure leaves no final partial file or temporary file`, async (t) => {
    const destinationDir = path.join(testRoot, `failure-${phase}`);
    await fs.mkdir(destinationDir);
    const failure = Object.assign(new Error(`injected ${phase} failure`), { code: phase === 'write' ? 'ENOSPC' : 'EIO' });
    const fsApi = { ...fs };
    fsApi.open = async (filename, flags) => {
      assert.equal(path.dirname(filename), destinationDir);
      assert.ok(path.basename(filename).startsWith('.'));
      assert.equal(flags, 'wx');
      const handle = await fs.open(filename, flags);
      if (phase === 'write') {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async () => { await write('partial'); throw failure; });
      }
      return handle;
    };
    if (phase === 'publication') fsApi.link = async (source) => {
      assert.equal(await fs.readFile(source, 'utf8'), 'complete bytes');
      throw failure;
    };
    await assert.rejects(downloadBatchToFolder({
      batchId: 'batch_failure', destinationDir, fsApi, serverOrigin: 'http://localhost:8787',
      fetchImpl: createBatchFetch({ batchId: 'batch_failure', files: [{ name: 'photo.jpg', bytes: 'complete bytes' }] }),
    }), (error) => error === failure);
    assert.deepEqual(await fs.readdir(destinationDir), []);
  });
}

test('a competing final filename is preserved and publication retries the next suffix', async () => {
  const destinationDir = path.join(testRoot, 'publication-race');
  await fs.mkdir(destinationDir);
  let attempts = 0;
  const result = await downloadBatchToFolder({
    batchId: 'batch_race', destinationDir, serverOrigin: 'http://localhost:8787',
    fetchImpl: createBatchFetch({ batchId: 'batch_race', files: [{ name: 'photo.jpg', bytes: 'downloaded' }] }),
    fsApi: { ...fs, link: async (source, target) => {
      if (attempts++ === 0) await fs.writeFile(target, 'user file', { flag: 'wx' });
      return fs.link(source, target);
    } },
  });
  assert.deepEqual(result.filenames, ['photo (1).jpg']);
  assert.equal(attempts, 2);
  assert.equal(await fs.readFile(path.join(destinationDir, 'photo.jpg'), 'utf8'), 'user file');
  assert.equal(await fs.readFile(path.join(destinationDir, 'photo (1).jpg'), 'utf8'), 'downloaded');
  assert.deepEqual((await fs.readdir(destinationDir)).sort(), ['photo (1).jpg', 'photo.jpg']);
});

test('concurrent exports use independent temporary files and never overwrite each other', async () => {
  const destinationDir = path.join(testRoot, 'concurrent');
  await fs.mkdir(destinationDir);
  const temporaryPaths = new Set();
  const fsApi = { ...fs, open: async (name, flags) => {
    assert.equal(temporaryPaths.has(name), false);
    temporaryPaths.add(name);
    return fs.open(name, flags);
  } };
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => downloadBatchToFolder({
    batchId: 'batch_concurrent', destinationDir, fsApi, serverOrigin: 'http://localhost:8787',
    fetchImpl: createBatchFetch({ batchId: 'batch_concurrent', files: [{ name: 'photo.jpg', bytes: `photo ${index}` }] }),
  })));
  assert.equal(temporaryPaths.size, 4);
  assert.equal(new Set(results.map((result) => result.filenames[0])).size, 4);
  for (const [index, result] of results.entries()) {
    assert.equal(await fs.readFile(path.join(destinationDir, result.filenames[0]), 'utf8'), `photo ${index}`);
  }
  assert.equal((await fs.readdir(destinationDir)).length, 4);
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
