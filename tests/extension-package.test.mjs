import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectFiles, packageExtension } from '../scripts/package-extension.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(projectRoot, 'extension');

const readCentralDirectoryNames = (archive) => {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = archive.lastIndexOf(endSignature);
  assert.notEqual(endOffset, -1, 'ZIP end record is missing');
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  const names = [];

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, 'ZIP central header is invalid');
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
};

test('extension popup has no obsolete format-specific filtering', async () => {
  const popupSource = await fs.readFile(path.join(extensionDir, 'popup.js'), 'utf8');
  assert.doesNotMatch(popupSource, /isVideoFile|getImageFiles|\.(?:mp4|mov|webm)/i);
  assert.match(popupSource, /const files = await loadLatest\(origin\)/);
  assert.match(popupSource, /for \(const file of files\)/);
});

test('extension package is versioned from its manifest and keeps manifest.json at the root', async (t) => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-extension-package-'));
  t.after(() => fs.rm(outputDir, { force: true, recursive: true }));

  const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const expectedEntries = (await collectFiles(extensionDir)).map(({ name }) => name);
  const result = await packageExtension({ extensionDir, outputDir });
  const archive = await fs.readFile(result.artifactPath);

  assert.equal(result.artifactName, `SnapOverLAN-extension-${manifest.version}.zip`);
  assert.deepEqual(readCentralDirectoryNames(archive), expectedEntries);
  assert.ok(result.entries.includes('manifest.json'));
  assert.ok(result.entries.every((name) => !name.startsWith('extension/')));
});
