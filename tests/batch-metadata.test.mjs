import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-metadata-'));
process.env.SNAPOVERLAN_DATA_DIR = root;
const { setCurrentBatchId, getCurrentBatchId, writeBatchMetadata, listBatchFiles, resolveBatchDir } =
  await import('../app/server/storage/batches.js');
after(async () => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(root, { recursive: true, force: true });
});
const batchId = 'batch_atomic';
const batchDir = resolveBatchDir(batchId);
const targets = [
  {
    name: 'current batch', destination: path.join(root, 'current-batch.json'),
    write: (value) => setCurrentBatchId(value),
    old: 'batch_old', next: 'batch_new', json: (value) => ({ currentBatchId: value }),
  },
  {
    name: 'batch metadata', destination: path.join(batchDir, '.batch.json'),
    write: (value) => writeBatchMetadata(batchId, value),
    old: { createdAt: '2020-01-01T00:00:00.000Z' }, next: { createdAt: '2026-01-01T00:00:00.000Z' },
    json: (value) => ({ id: batchId, ...value }),
  },
];

for (const target of targets) {
  test(`${target.name} is replaced atomically with unchanged pretty JSON and newline`, async (t) => {
    await target.write(target.old);
    const previous = await fs.readFile(target.destination, 'utf8');
    const rename = fs.rename;
    let replacements = 0;
    t.mock.method(fs, 'rename', async (temporary, destination) => {
      assert.equal(destination, target.destination);
      assert.equal(path.dirname(temporary), path.dirname(destination));
      assert.ok(path.basename(temporary).startsWith('.'));
      assert.equal(await fs.readFile(destination, 'utf8'), previous);
      assert.equal(await fs.readFile(temporary, 'utf8'), `${JSON.stringify(target.json(target.next), null, 2)}\n`);
      replacements += 1;
      return rename(temporary, destination);
    });
    await target.write(target.next);
    assert.equal(replacements, 1);
    assert.equal(await fs.readFile(target.destination, 'utf8'), `${JSON.stringify(target.json(target.next), null, 2)}\n`);
    assert.equal((await fs.readdir(path.dirname(target.destination))).some((name) => name.endsWith('.tmp')), false);
    if (target.name === 'current batch') assert.equal(await getCurrentBatchId(), target.next);
  });

  for (const phase of ['write', 'rename']) {
    test(`${target.name} ${phase} failure preserves destination and removes partial temporary file`, async (t) => {
      await target.write(target.old);
      const previous = await fs.readFile(target.destination, 'utf8');
      const failure = Object.assign(new Error(`injected ${phase} failure`), { code: 'EIO' });
      let temporary;
      const open = fs.open;
      t.mock.method(fs, 'open', async (filename, flags) => {
        temporary = filename;
        assert.equal(flags, 'wx');
        const handle = await open(filename, flags);
        if (phase === 'write') {
          const write = handle.writeFile.bind(handle);
          t.mock.method(handle, 'writeFile', async () => {
            await write('{"partial":', 'utf8');
            throw failure;
          });
        }
        return handle;
      });
      if (phase === 'rename') t.mock.method(fs, 'rename', async () => { throw failure; });
      await assert.rejects(target.write(target.next), (error) => error === failure);
      assert.equal(await fs.readFile(target.destination, 'utf8'), previous);
      await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
    });
  }
}

test('concurrent metadata writes use distinct hidden files that batch listing never exposes', async (t) => {
  await fs.mkdir(batchDir, { recursive: true });
  await fs.writeFile(path.join(batchDir, 'photo.jpg'), 'photo');
  const rename = fs.rename;
  const temporaryPaths = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let allReady;
  const ready = new Promise((resolve) => { allReady = resolve; });
  t.mock.method(fs, 'rename', async (temporary, destination) => {
    temporaryPaths.push(temporary);
    if (temporaryPaths.length === 8) allReady();
    await gate;
    return rename(temporary, destination);
  });
  const writes = Array.from({ length: 8 }, (_, index) => writeBatchMetadata(batchId, { index }));
  const settled = Promise.allSettled(writes);
  await ready;
  try {
    assert.equal(new Set(temporaryPaths).size, 8);
    assert.ok(temporaryPaths.every((filename) => path.dirname(filename) === batchDir && path.basename(filename).startsWith('.')));
    assert.deepEqual((await listBatchFiles(batchId)).map((file) => file.name), ['photo.jpg']);
  } finally {
    release();
    await settled;
  }
  const results = await settled;
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  for (const result of results) {
    // Windows may reject competing replacements, but must preserve complete JSON.
    if (result.status === 'rejected') assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(result.reason.code));
  }
  const metadata = JSON.parse(await fs.readFile(path.join(batchDir, '.batch.json'), 'utf8'));
  assert.equal(metadata.id, batchId);
  assert.ok(Number.isInteger(metadata.index));
  assert.deepEqual((await fs.readdir(batchDir)).sort(), ['.batch.json', 'photo.jpg']);
});
