import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const fixtures = new Map();
const imageFixture = async (mimeType) => {
  if (fixtures.has(mimeType)) return fixtures.get(mimeType);
  let bytes;
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    bytes = await readFile(new URL('../fixtures/valid.heic', import.meta.url));
    if (mimeType === 'image/heif') {
      // A generic HEIF container carrying the same HEVC image. Only container
      // brands change; neither filename nor multipart MIME drives detection.
      bytes = Buffer.from(bytes);
      const size = bytes.readUInt32BE(0);
      for (let offset = 8; offset < size; offset += 4) {
        if (offset !== 12) bytes.write('mif1', offset, 4, 'ascii');
      }
    }
  } else {
    const format = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType];
    bytes = format ? await sharp({ create: { width: 16, height: 12, channels: 3, background: '#48a0c0' } }).toFormat(format).toBuffer() : Buffer.from('not an image');
  }
  fixtures.set(mimeType, bytes);
  return bytes;
};

export { imageFixture };
