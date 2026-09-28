import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-startup-cleanup-'));
process.env.SNAPOVERLAN_DATA_DIR = dataRoot;
const { ensureStorageDirectories } = await import('../app/server/storage.js');
const tempRoot = path.join(dataRoot, 'upload-tmp');
const batchesRoot = path.join(dataRoot, 'batches');
const batchRoot = path.join(batchesRoot, 'batch_saved');
const protectedFiles = new Map([
  [path.join(batchRoot, 'photo.jpg'), 'saved photo'],
  [path.join(batchRoot, '.batch.json'), JSON.stringify({ id: 'batch_saved', createdAt: new Date().toISOString() })],
  [path.join(dataRoot, 'current-batch.json'), '{"currentBatchId":"batch_saved"}\n'],
  [path.join(dataRoot, 'storage-settings.json'), '{"retentionDays":null}\n'],
  [path.join(dataRoot, 'latest', 'legacy.jpg'), 'existing latest data'],
  [path.join(dataRoot, 'upload-tmp-sibling', 'keep.txt'), 'outside temp'],
]);

const reset = async () => {
  assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataRoot).startsWith('snapoverlan-startup-cleanup-'));
  await fs.rm(dataRoot, { recursive: true, force: true });
};
after(reset);
beforeEach(async () => {
  await reset();
  await fs.mkdir(tempRoot, { recursive: true });
  for (const [file, contents] of protectedFiles) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
});

const assertProtectedFiles = async () => {
  for (const [file, contents] of protectedFiles) {
    assert.equal(await fs.readFile(file, 'utf8'), contents, file);
  }
};
const assertEmptyTemp = async () => {
  assert.equal((await fs.lstat(tempRoot)).isDirectory(), true);
  assert.deepEqual(await fs.readdir(tempRoot), []);
};
const directoryLink = (target, link) => fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

test('startup removes a stale file and preserves the temp root and saved storage', async () => {
  await fs.writeFile(path.join(tempRoot, 'partial.jpg'), 'partial');
  await ensureStorageDirectories();
  await assertEmptyTemp();
  await assertProtectedFiles();
});

test('startup removes a stale directory including nested staging files', async () => {
  const nested = path.join(tempRoot, 'batch_abandoned', 'nested');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'partial.jpg'), 'partial');
  await ensureStorageDirectories();
  await assertEmptyTemp();
  await assertProtectedFiles();
});

test('startup removes multiple files and directories', async () => {
  for (const name of ['one.jpg', 'two.jpg']) await fs.writeFile(path.join(tempRoot, name), 'partial');
  for (const name of ['batch_one', 'batch_two']) await fs.mkdir(path.join(tempRoot, name));
  await ensureStorageDirectories();
  await assertEmptyTemp();
  await assertProtectedFiles();
});

test('startup works with an empty or missing temp root', async () => {
  await ensureStorageDirectories();
  await assertEmptyTemp();
  await fs.rmdir(tempRoot);
  await ensureStorageDirectories();
  await assertEmptyTemp();
  await assertProtectedFiles();
});

test('direct and nested junctions/symlinks are removed without touching outside targets', async () => {
  await directoryLink(batchesRoot, path.join(tempRoot, 'saved-batches'));
  await directoryLink(path.join(dataRoot, 'latest'), path.join(tempRoot, 'latest-link'));
  const nested = path.join(tempRoot, 'abandoned');
  await fs.mkdir(nested);
  await directoryLink(dataRoot, path.join(nested, 'data-link'));
  await directoryLink(path.join(dataRoot, 'upload-tmp-sibling'), path.join(nested, 'sibling-link'));
  await ensureStorageDirectories();
  await assertEmptyTemp();
  await assertProtectedFiles();
});

test('a redirected temp root is rejected without deleting saved storage', async () => {
  await fs.rmdir(tempRoot);
  await directoryLink(batchesRoot, tempRoot);
  await assert.rejects(ensureStorageDirectories(), /Unsafe upload staging directory/);
  await assertProtectedFiles();
  assert.equal((await fs.lstat(tempRoot)).isSymbolicLink(), true);
});

test('malformed child names cannot escape the canonical temp root', async (t) => {
  const readdir = fs.readdir;
  const canonicalRoot = await fs.realpath(tempRoot);
  const names = ['..', '.', '', '../batches', '..\\latest', '../upload-tmp-sibling', batchesRoot, 'C:escape'];
  t.mock.method(fs, 'readdir', async (dir, ...args) => (
    dir === canonicalRoot ? [...names, 'safe.jpg'] : readdir(dir, ...args)
  ));
  const warn = t.mock.method(console, 'warn', () => {});
  const rm = t.mock.method(fs, 'rm');
  await fs.writeFile(path.join(tempRoot, 'safe.jpg'), 'stale');
  await ensureStorageDirectories();
  assert.equal(warn.mock.callCount(), names.length);
  assert.deepEqual(rm.mock.calls.map(({ arguments: args }) => args[0]), [path.join(canonicalRoot, 'safe.jpg')]);
  assert.deepEqual(await readdir(tempRoot), []);
  await assertProtectedFiles();
});

test('one deletion failure is logged and remaining stale children are still attempted', async (t) => {
  const canonicalRoot = await fs.realpath(tempRoot);
  const blocked = path.join(canonicalRoot, 'blocked.jpg');
  const remaining = path.join(canonicalRoot, 'remaining.jpg');
  await fs.writeFile(blocked, 'blocked');
  await fs.writeFile(remaining, 'stale');
  const readdir = fs.readdir;
  t.mock.method(fs, 'readdir', async (dir, ...args) => (
    dir === canonicalRoot ? ['blocked.jpg', 'remaining.jpg'] : readdir(dir, ...args)
  ));
  const failure = Object.assign(new Error('file locked'), { code: 'EPERM' });
  const rm = fs.rm;
  const removals = t.mock.method(fs, 'rm', async (file, options) => {
    if (file === blocked) throw failure;
    return rm(file, options);
  });
  const warn = t.mock.method(console, 'warn', () => {});
  await ensureStorageDirectories();
  assert.deepEqual(removals.mock.calls.map(({ arguments: args }) => args[0]), [blocked, remaining]);
  assert.deepEqual(await readdir(tempRoot), ['blocked.jpg']);
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(warn.mock.calls[0].arguments[0].includes(canonicalRoot));
  assert.ok(warn.mock.calls[0].arguments[0].includes('blocked.jpg'));
  assert.equal(warn.mock.calls[0].arguments[1], failure);
  await assertProtectedFiles();
});

test('a temp root creation failure still rejects startup', async () => {
  await fs.rmdir(tempRoot);
  await fs.writeFile(tempRoot, 'not a directory');
  await assert.rejects(ensureStorageDirectories(), { code: 'EEXIST' });
  await assertProtectedFiles();
});

test('a temp root access failure still rejects startup', async (t) => {
  const canonicalRoot = await fs.realpath(tempRoot);
  const readdir = fs.readdir;
  const failure = Object.assign(new Error('cannot read staging root'), { code: 'EACCES' });
  t.mock.method(fs, 'readdir', async (dir, ...args) => {
    if (dir === canonicalRoot) throw failure;
    return readdir(dir, ...args);
  });
  await assert.rejects(ensureStorageDirectories(), (error) => error === failure);
  await assertProtectedFiles();
});

test('real server startup cleans staging before it begins listening', async (t) => {
  const { startServer, stopServer } = await import('../app/server/index.js');
  t.after(stopServer);
  await fs.writeFile(path.join(tempRoot, 'previous-process.jpg'), 'stale');
  const server = await startServer({
    host: '127.0.0.1', port: 0, log: false,
    mdnsFactory: () => ({ start: async () => ({ started: false }), stop: async () => {} }),
  });
  assert.equal(server.listening, true);
  await assertEmptyTemp();
  await assertProtectedFiles();
});
