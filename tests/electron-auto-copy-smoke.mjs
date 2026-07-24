import { app, clipboard, nativeImage } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  copyFirstUploadedImage,
  UPLOAD_COMPLETED_EVENT,
} from '../app/auto-copy.js';

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-electron-smoke-'));
const sourceImage = {
  create: {
    width: 40,
    height: 20,
    channels: 4,
    background: { r: 20, g: 150, b: 220, alpha: 0.65 },
  },
};

const makeMessage = (filePath, mimeType) => ({
  type: UPLOAD_COMPLETED_EVENT,
  batchId: `batch_smoke_${path.extname(filePath).slice(1) || 'invalid'}`,
  firstImage: {
    name: path.basename(filePath),
    path: filePath,
    mimeType,
  },
});

const runClipboardCase = async (label, filePath, mimeType, expectedSize) => {
  clipboard.writeText(`SnapOverLAN ${label} clipboard sentinel`);
  const result = await copyFirstUploadedImage({
    message: makeMessage(filePath, mimeType),
    enabled: true,
    fileExists: async (targetPath) => {
      try {
        return (await fs.stat(targetPath)).isFile();
      } catch {
        return false;
      }
    },
    createImageFromPath: (targetPath) => nativeImage.createFromPath(targetPath),
    createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
    writeImage: (image) => clipboard.writeImage(image),
    readImage: () => clipboard.readImage(),
    onDiagnostic: (stage, details) => console.log(`[auto-copy] ${stage}`, details),
  });

  if (result.status !== 'copied') {
    throw new Error(`${label} did not copy: ${result.error || result.status}`);
  }
  if (
    result.dimensions.width !== expectedSize.width
    || result.dimensions.height !== expectedSize.height
  ) {
    throw new Error(
      `${label} clipboard dimensions were ${result.dimensions.width}x${result.dimensions.height}, `
      + `expected ${expectedSize.width}x${expectedSize.height}.`,
    );
  }
  console.log(`[electron-smoke] PASS ${label}`, {
    method: result.method,
    dimensions: result.dimensions,
  });
};

const runSmoke = async () => {
  const { default: sharp } = await import('sharp');
  const safetyTimer = setTimeout(() => {
    console.error('[electron-smoke] FAIL timed out');
    app.exit(1);
  }, 30_000);
  const initialClipboardImage = clipboard.readImage();
  const initialClipboardText = clipboard.readText();

  try {
    const fixtures = {
      png: path.join(fixtureRoot, 'sample.png'),
      jpeg: path.join(fixtureRoot, 'sample.jpg'),
      rotatedJpeg: path.join(fixtureRoot, 'rotated.jpg'),
      webp: path.join(fixtureRoot, 'sample.webp'),
      malformed: path.join(fixtureRoot, 'malformed.png'),
    };
    await Promise.all([
      sharp(sourceImage).png().toFile(fixtures.png),
      sharp(sourceImage).jpeg().toFile(fixtures.jpeg),
      sharp(sourceImage).withMetadata({ orientation: 6 }).jpeg().toFile(fixtures.rotatedJpeg),
      sharp(sourceImage).webp().toFile(fixtures.webp),
      fs.writeFile(fixtures.malformed, 'not an image'),
    ]);

    await runClipboardCase('PNG', fixtures.png, 'image/png', { width: 40, height: 20 });
    await runClipboardCase('JPEG', fixtures.jpeg, 'image/jpeg', { width: 40, height: 20 });
    await runClipboardCase(
      'EXIF-rotated JPEG',
      fixtures.rotatedJpeg,
      'image/jpeg',
      { width: 20, height: 40 },
    );
    await runClipboardCase('WebP', fixtures.webp, 'image/webp', { width: 40, height: 20 });

    const malformedResult = await copyFirstUploadedImage({
      message: makeMessage(fixtures.malformed, 'image/png'),
      enabled: true,
      fileExists: async () => true,
      createImageFromPath: (targetPath) => nativeImage.createFromPath(targetPath),
      createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
      writeImage: (image) => clipboard.writeImage(image),
      readImage: () => clipboard.readImage(),
    });
    if (
      malformedResult.status !== 'failed'
      || malformedResult.reason !== 'unsupported image format'
    ) {
      throw new Error('Malformed image data did not fail as unsupported.');
    }
    console.log('[electron-smoke] PASS malformed image rejection');
  } catch (error) {
    console.error('[electron-smoke] FAIL', error);
    process.exitCode = 1;
  } finally {
    if (!initialClipboardImage.isEmpty()) {
      clipboard.writeImage(initialClipboardImage);
    } else {
      clipboard.writeText(initialClipboardText);
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    clearTimeout(safetyTimer);
    app.exit(process.exitCode || 0);
  }
};

app.whenReady().then(runSmoke).catch((error) => {
  console.error('[electron-smoke] FAIL before execution', error);
  app.exit(1);
});
