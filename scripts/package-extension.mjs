import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultExtensionDir = path.join(projectRoot, 'extension');
const defaultOutputDir = path.join(projectRoot, 'dist');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const toDosDateTime = (value) => {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
};

const createZipBuffer = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const modified = toDosDateTime(entry.modifiedAt);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(modified.time, 10);
    localHeader.writeUInt16LE(modified.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(modified.time, 12);
    centralHeader.writeUInt16LE(modified.date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectorySize, 12);
  endRecord.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, endRecord]);
};

const collectFiles = async (rootDir, relativeDir = '') => {
  const directory = path.join(rootDir, relativeDir);
  const directoryEntries = await fs.readdir(directory, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];

  for (const entry of directoryEntries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(rootDir, relativePath));
    } else if (entry.isFile()) {
      const sourcePath = path.join(rootDir, relativePath);
      const stats = await fs.stat(sourcePath);
      files.push({
        data: await fs.readFile(sourcePath),
        modifiedAt: stats.mtime,
        name: relativePath.split(path.sep).join('/'),
      });
    } else {
      throw new Error(`Unsupported extension entry: ${relativePath}`);
    }
  }

  return files;
};

const packageExtension = async ({
  extensionDir = defaultExtensionDir,
  outputDir = defaultOutputDir,
} = {}) => {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.manifest_version !== 3 || typeof manifest.version !== 'string'
    || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error('extension/manifest.json must contain a valid Manifest V3 version.');
  }

  const entries = await collectFiles(extensionDir);
  if (!entries.some(({ name }) => name === 'manifest.json')) {
    throw new Error('The extension package must contain manifest.json at its root.');
  }

  const artifactName = `SnapOverLAN-extension-${manifest.version}.zip`;
  const artifactPath = path.join(outputDir, artifactName);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(artifactPath, createZipBuffer(entries));
  return { artifactName, artifactPath, entries: entries.map(({ name }) => name) };
};

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  packageExtension()
    .then(({ artifactPath, entries }) => {
      console.log(`Packaged ${entries.length} extension files: ${path.relative(projectRoot, artifactPath)}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

export { collectFiles, createZipBuffer, packageExtension };
