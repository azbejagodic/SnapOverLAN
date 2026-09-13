import { parentPort, workerData } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { MAX_FILE_SIZE } from '../config.js';

const { filePath, maxPixels } = workerData;
sharp.cache(false);
const checkDimensions = (width, height) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0 || width * height > maxPixels) {
    throw new Error('Image exceeds the 60 megapixel upload limit or has invalid dimensions.');
  }
};

const identify = (bytes) => {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return { format: 'jpeg', extension: '.jpg', mimeType: 'image/jpeg' };
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { format: 'png', extension: '.png', mimeType: 'image/png' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { format: 'webp', extension: '.webp', mimeType: 'image/webp' };
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const boxSize = bytes.readUInt32BE(0);
    if (boxSize < 16 || boxSize > bytes.length || boxSize > 4096 || boxSize % 4) throw new Error('Invalid HEIF file type box.');
    const brands = [bytes.toString('ascii', 8, 12)];
    for (let offset = 16; offset < boxSize; offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4));
    if (brands.some((brand) => ['avif', 'avis'].includes(brand))) throw new Error('AVIF uploads are not supported.');
    if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))) return { format: 'heif', extension: '.heic', mimeType: 'image/heic' };
    if (brands.some((brand) => ['mif1', 'msf1'].includes(brand))) return { format: 'heif', extension: '.heif', mimeType: 'image/heif' };
  }
  throw new Error('Only valid JPEG, PNG, WebP, HEIC, and HEIF images are allowed.');
};

try {
  const size = (await fs.stat(filePath)).size;
  if (size <= 0 || size > MAX_FILE_SIZE) throw new Error('Image is empty or exceeds the 12MB file limit.');
  const bytes = await fs.readFile(filePath);
  const verified = identify(bytes);
  if (verified.format === 'heif') {
    const metadata = await sharp(bytes, { failOn: 'warning', limitInputPixels: maxPixels }).metadata();
    if (metadata.format !== 'heif' || metadata.compression !== 'hevc') throw new Error('Unsupported HEIF image compression.');
    checkDimensions(metadata.width, metadata.height);
    // Sharp's distributed binaries omit HEVC. Decode locally with bundled WASM,
    // inside this disposable worker; never fall back to MIME/header-only acceptance.
    const { default: libheifModule } = await import('libheif-js/wasm-bundle.js');
    const libheif = await libheifModule;
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(bytes);
    if (!images.length || images.length > 10) throw new Error('Invalid HEIF image count.');
    let pixels = 0;
    for (const image of images) {
      const width = image.get_width();
      const height = image.get_height();
      checkDimensions(width, height);
      pixels += width * height;
      if (pixels > maxPixels) throw new Error('HEIF images exceed the 60 megapixel upload limit.');
    }
    for (const image of images) {
      const width = image.get_width();
      const height = image.get_height();
      await new Promise((resolve, reject) => {
        image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) => {
          if (result) resolve(); else reject(new Error('Malformed HEIF image data.'));
        });
      });
      image.free();
    }
  } else {
    const options = { failOn: 'warning', limitInputPixels: maxPixels, sequentialRead: true, pages: -1 };
    const metadata = await sharp(bytes, options).metadata();
    if (metadata.format !== verified.format) throw new Error('Image format does not match its content.');
    checkDimensions(metadata.width, metadata.height);
    // metadata() alone does not validate compressed pixels. stats() forces a
    // full decode, including animation frames, without returning a raw JS buffer.
    await sharp(bytes, options).timeout({ seconds: 20 }).stats();
  }
  parentPort.postMessage(verified);
} catch (error) {
  parentPort.postMessage({ error: `Invalid image: ${error.message}` });
}
