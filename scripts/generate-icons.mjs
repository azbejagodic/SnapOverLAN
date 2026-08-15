import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brandingDir = path.join(root, 'assets', 'branding');
const electronDir = path.join(root, 'assets', 'electron');
const extensionDir = path.join(root, 'extension', 'icons');
const pwaDir = path.join(root, 'pwa', 'icons');
const markSvg = await readFile(path.join(brandingDir, 'snapoverlan-mark.svg'));
const appIconSvg = await readFile(path.join(brandingDir, 'snapoverlan-app-icon.svg'));
const sizes = [16, 19, 20, 24, 32, 38, 48, 64, 128, 180, 192, 256, 512, 1024];
const visibleMarkWidth = 0.62;

await Promise.all([electronDir, extensionDir, pwaDir].map((dir) => mkdir(dir, { recursive: true })));

async function render(svg, size) {
  return sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

// Trim the SVG viewBox before sizing so the visible chevrons—not invisible
// canvas padding—are centered in every derived icon.
const trimmedMark = await sharp(markSvg, { density: 384 })
  .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

async function centeredMark(size) {
  const mark = await sharp(trimmedMark)
    .resize({ width: Math.round(size * visibleMarkWidth), kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function fullBleedIcon(size) {
  const mark = await centeredMark(size);
  return sharp({ create: { width: size, height: size, channels: 4, background: '#343940' } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function monochromeMark(size, color = '#10bfae') {
  const alpha = await centeredMark(size);
  return sharp({ create: { width: size, height: size, channels: 4, background: color } })
    .composite([{ input: alpha, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function iconContainer(type, images) {
  if (type === 'ico') {
    const header = Buffer.alloc(6 + images.length * 16);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, data }, index) => {
      const entry = 6 + index * 16;
      header.writeUInt8(size >= 256 ? 0 : size, entry);
      header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(data.length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += data.length;
    });
    return Buffer.concat([header, ...images.map(({ data }) => data)]);
  }

  const chunks = images.map(({ chunkType, data }) => {
    const chunk = Buffer.alloc(8 + data.length);
    chunk.write(chunkType, 0, 4, 'ascii');
    chunk.writeUInt32BE(chunk.length, 4);
    data.copy(chunk, 8);
    return chunk;
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

const rendered = new Map();
for (const size of sizes) {
  const mark = await centeredMark(size);
  const appIcon = await render(appIconSvg, size);
  rendered.set(size, { mark, appIcon });
}

const desktopSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
await Promise.all(desktopSizes.map((size) => writeFile(path.join(electronDir, `app-${size}.png`), rendered.get(size).appIcon)));
await Promise.all([16, 24, 32].map(async (size) => writeFile(path.join(electronDir, `tray-${size}.png`), await monochromeMark(size))));

const icoImages = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: rendered.get(size).appIcon }));
await writeFile(path.join(electronDir, 'app.ico'), iconContainer('ico', icoImages));

const icnsTypes = [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']];
await writeFile(path.join(electronDir, 'app.icns'), iconContainer('icns', icnsTypes.map(([size, chunkType]) => ({ chunkType, data: rendered.get(size).appIcon }))));

const extensionSizes = [16, 19, 20, 24, 32, 38, 48, 128];
await Promise.all(extensionSizes.map((size) => writeFile(path.join(extensionDir, `icon-${size}.png`), rendered.get(size).mark)));

await Promise.all([
  writeFile(path.join(pwaDir, 'favicon-16.png'), rendered.get(16).mark),
  writeFile(path.join(pwaDir, 'favicon-32.png'), rendered.get(32).mark),
  writeFile(path.join(pwaDir, 'mark-128.png'), rendered.get(128).mark),
  writeFile(path.join(pwaDir, 'icon-192.png'), rendered.get(192).appIcon),
  writeFile(path.join(pwaDir, 'icon-512.png'), rendered.get(512).appIcon),
  writeFile(path.join(pwaDir, 'icon-maskable-192.png'), await fullBleedIcon(192)),
  writeFile(path.join(pwaDir, 'icon-maskable-512.png'), await fullBleedIcon(512)),
  writeFile(path.join(pwaDir, 'apple-touch-icon.png'), await fullBleedIcon(180)),
]);

const faviconImages = [16, 24, 32, 48].map((size) => ({ size, data: rendered.get(size).mark }));
await writeFile(path.join(pwaDir, 'favicon.ico'), iconContainer('ico', faviconImages));

console.log('Generated SnapOverLAN Electron, extension, and PWA icons.');
