import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import sharp from 'sharp';

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-auto-copy-'));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SNAPOVERLAN_DATA_DIR = dataRoot;

const {
  copyFirstUploadedImage,
  decodeUploadedImage,
  UPLOAD_COMPLETED_EVENT,
  validateUploadCompletedMessage,
} = await import('../app/auto-copy.js');
const {
  DEFAULT_DESKTOP_SETTINGS,
  normalizeDesktopSettings,
  updateDesktopSetting,
} = await import('../app/desktop-settings.js');
const { createApiRouter } = await import('../app/server/routes/api.js');
const { ensureStorageDirectories } = await import('../app/server/storage.js');
const { sendUploadCompletedToParent } = await import('../app/server/index.js');

await ensureStorageDirectories();
const fixtureDir = path.join(dataRoot, 'fixtures');
await fs.mkdir(fixtureDir, { recursive: true });
const fixturePaths = {
  png: path.join(fixtureDir, 'sample.png'),
  jpeg: path.join(fixtureDir, 'sample.jpg'),
  rotatedJpeg: path.join(fixtureDir, 'rotated.jpg'),
  webp: path.join(fixtureDir, 'sample.webp'),
  malformed: path.join(fixtureDir, 'malformed.png'),
};
const baseImage = {
  create: {
    width: 40,
    height: 20,
    channels: 4,
    background: { r: 25, g: 145, b: 220, alpha: 0.7 },
  },
};
await Promise.all([
  sharp(baseImage).png().toFile(fixturePaths.png),
  sharp(baseImage).jpeg().toFile(fixturePaths.jpeg),
  sharp(baseImage).withMetadata({ orientation: 6 }).jpeg().toFile(fixturePaths.rotatedJpeg),
  sharp(baseImage).webp().toFile(fixturePaths.webp),
  fs.writeFile(fixturePaths.malformed, 'not an image'),
]);

let completionHandler = () => {};
const apiApp = express();
apiApp.use('/api', createApiRouter({
  getServerStatus: () => ({ status: 'listening' }),
  onUploadCompleted: (event) => completionHandler(event),
}));
const server = await new Promise((resolve, reject) => {
  const instance = apiApp.listen(0, '127.0.0.1', () => resolve(instance));
  instance.once('error', reject);
});
const { port } = server.address();

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  await fs.rm(dataRoot, { recursive: true, force: true });
});

const uploadFiles = async (files) => {
  const form = new FormData();
  for (const file of files) {
    form.append('photos', new Blob([file.contents || file.name], { type: file.type }), file.name);
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/upload`, {
    method: 'POST',
    body: form,
  });
  return {
    response,
    body: await response.json(),
  };
};

const validMessage = (filePath = path.join(dataRoot, 'first.png')) => ({
  type: UPLOAD_COMPLETED_EVENT,
  batchId: 'batch_test',
  firstImage: {
    name: 'first.png',
    path: filePath,
    mimeType: 'image/png',
  },
});

const fakeImage = (width = 40, height = 20, empty = false) => ({
  isEmpty: () => empty,
  getSize: () => ({ width, height }),
});

const getFreePort = async () => {
  const portServer = createServer();
  await new Promise((resolve, reject) => {
    portServer.once('error', reject);
    portServer.listen(0, '127.0.0.1', resolve);
  });
  const freePort = portServer.address().port;
  await new Promise((resolve, reject) => portServer.close((error) => (
    error ? reject(error) : resolve()
  )));
  return freePort;
};

const waitForHttpServer = async (targetPort) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/api/server-status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Child server did not become ready.');
};

test('desktop settings default and migrate auto-copy safely', () => {
  assert.deepEqual(DEFAULT_DESKTOP_SETTINGS, {
    backgroundMode: false,
    autoCopyFirstPhoto: false,
  });
  assert.deepEqual(normalizeDesktopSettings({ backgroundMode: true }), {
    backgroundMode: true,
    autoCopyFirstPhoto: false,
  });
  assert.deepEqual(normalizeDesktopSettings(null), DEFAULT_DESKTOP_SETTINGS);
});

test('saving auto-copy preserves the Background Mode setting', () => {
  assert.deepEqual(
    updateDesktopSetting({ backgroundMode: true }, 'autoCopyFirstPhoto', true),
    {
      backgroundMode: true,
      autoCopyFirstPhoto: true,
    },
  );
});

test('the upload route emits one event with the first image from an ordered mixed batch', async () => {
  const events = [];
  completionHandler = (event) => events.push(event);

  const { response, body } = await uploadFiles([
    { name: 'clip.mp4', type: 'video/mp4' },
    { name: 'first.png', type: 'image/png' },
    { name: 'second.jpg', type: 'image/jpeg' },
  ]);

  assert.equal(response.status, 200);
  assert.equal(body.files.length, 3);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, UPLOAD_COMPLETED_EVENT);
  assert.match(events[0].batchId, /^batch_/);
  assert.match(events[0].firstImage.name, /photo-001\.png$/);
  assert.equal(events[0].firstImage.mimeType, 'image/png');
  assert.equal(path.isAbsolute(events[0].firstImage.path), true);
});

test('video-only and empty batches do not emit image-copy requests', async () => {
  const events = [];
  completionHandler = (event) => events.push(event);

  const videoUpload = await uploadFiles([
    { name: 'clip.mp4', type: 'video/mp4' },
  ]);
  const emptyUpload = await uploadFiles([]);

  assert.equal(videoUpload.response.status, 200);
  assert.equal(emptyUpload.response.status, 200);
  assert.equal(events.length, 0);
});

test('failed uploads do not emit completion events', async () => {
  const events = [];
  completionHandler = (event) => events.push(event);
  const form = new FormData();
  form.append(
    'photos',
    new Blob(['not allowed'], { type: 'application/octet-stream' }),
    'file.bin',
  );

  const response = await fetch(`http://127.0.0.1:${port}/api/upload`, {
    method: 'POST',
    body: form,
  });

  assert.equal(response.status, 400);
  assert.equal(events.length, 0);
});

test('IPC callback failures and unavailable IPC do not fail uploads', async () => {
  completionHandler = () => {
    throw new Error('IPC unavailable');
  };
  const { response, body } = await uploadFiles([
    { name: 'photo.png', type: 'image/png' },
  ]);

  assert.equal(response.status, 200);
  assert.equal(body.files.length, 1);
  assert.equal(sendUploadCompletedToParent(validMessage(), { connected: false }), false);
});

test('a real server child sends exactly one upload-completed event over IPC', async (t) => {
  const childPort = await getFreePort();
  const childDataRoot = path.join(dataRoot, 'real-ipc-child');
  const serverEntry = path.join(projectRoot, 'app', 'server', 'index.js');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SNAPOVERLAN_PORT: String(childPort),
      SNAPOVERLAN_DATA_DIR: childDataRoot,
      SNAPOVERLAN_SERVER_SOURCE: 'auto-copy-real-ipc-test',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const messages = [];
  child.on('message', (message) => messages.push(message));

  await waitForHttpServer(childPort);
  const form = new FormData();
  form.append(
    'photos',
    new Blob([await fs.readFile(fixturePaths.png)], { type: 'image/png' }),
    'fixture.png',
  );
  const response = await fetch(`http://127.0.0.1:${childPort}/api/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(response.status, 200);

  for (let attempt = 0; attempt < 20 && messages.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const uploadMessages = messages.filter((message) => (
    message?.type === UPLOAD_COMPLETED_EVENT
  ));
  assert.equal(uploadMessages.length, 1, stderr);
  assert.match(uploadMessages[0].firstImage.name, /photo-001\.png$/);
  assert.equal(path.isAbsolute(uploadMessages[0].firstImage.path), true);

  const exitPromise = new Promise((resolve) => child.once('exit', resolve));
  child.send({ type: 'snapoverlan:shutdown' });
  await exitPromise;
});

test('malformed IPC payloads are ignored before filesystem or clipboard access', async () => {
  let dependencyCalls = 0;
  const result = await copyFirstUploadedImage({
    message: { type: UPLOAD_COMPLETED_EVENT, firstImage: { path: 'relative.png' } },
    enabled: true,
    fileExists: async () => { dependencyCalls += 1; return true; },
    decodeImage: async () => { dependencyCalls += 1; return { image: fakeImage() }; },
    writeImage: () => { dependencyCalls += 1; },
    readImage: () => { dependencyCalls += 1; return fakeImage(); },
  });

  assert.equal(validateUploadCompletedMessage({}), null);
  assert.deepEqual(result, { status: 'ignored' });
  assert.equal(dependencyCalls, 0);
});

test('disabled auto-copy does not access or replace the clipboard', async () => {
  let writes = 0;
  const result = await copyFirstUploadedImage({
    message: validMessage(),
    enabled: false,
    fileExists: async () => true,
    decodeImage: async () => ({ image: fakeImage(), method: 'path', width: 40, height: 20 }),
    writeImage: () => { writes += 1; },
    readImage: () => fakeImage(),
  });

  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(writes, 0);
});

test('enabled auto-copy reports success only after verified clipboard readback', async () => {
  const decodedImage = fakeImage();
  let writes = 0;
  const result = await copyFirstUploadedImage({
    message: validMessage(),
    enabled: true,
    fileExists: async () => true,
    decodeImage: async () => ({
      image: decodedImage,
      method: 'path',
      width: 40,
      height: 20,
    }),
    writeImage: (image) => {
      assert.equal(image, decodedImage);
      writes += 1;
    },
    readImage: () => fakeImage(),
    delay: async () => {},
  });

  assert.equal(result.status, 'copied');
  assert.equal(result.filename, 'first.png');
  assert.equal(writes, 1);
});

test('empty clipboard readback retries once and never reports success', async () => {
  let writes = 0;
  const result = await copyFirstUploadedImage({
    message: validMessage(),
    enabled: true,
    fileExists: async () => true,
    decodeImage: async () => ({
      image: fakeImage(),
      method: 'path',
      width: 40,
      height: 20,
    }),
    writeImage: () => { writes += 1; },
    readImage: () => fakeImage(0, 0, true),
    delay: async () => {},
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /readback was empty/i);
  assert.equal(writes, 2);
});

test('nativeImage path and buffer stages decode PNG and JPEG', async () => {
  const pngResult = await decodeUploadedImage({
    filePath: fixturePaths.png,
    createImageFromPath: () => fakeImage(40, 20),
    createImageFromBuffer: () => {
      throw new Error('buffer fallback should not be needed');
    },
  });
  let jpegBufferCalls = 0;
  const jpegResult = await decodeUploadedImage({
    filePath: fixturePaths.jpeg,
    createImageFromPath: () => fakeImage(0, 0, true),
    createImageFromBuffer: () => {
      jpegBufferCalls += 1;
      return fakeImage(40, 20);
    },
  });

  assert.equal(pngResult.method, 'path');
  assert.equal(jpegResult.method, 'buffer');
  assert.equal(jpegBufferCalls, 1);
});

test('EXIF rotation and WebP use an in-memory oriented PNG fallback', async () => {
  let rotatedBufferCalls = 0;
  const rotatedResult = await decodeUploadedImage({
    filePath: fixturePaths.rotatedJpeg,
    createImageFromPath: () => fakeImage(40, 20),
    createImageFromBuffer: () => {
      rotatedBufferCalls += 1;
      return rotatedBufferCalls === 1 ? fakeImage(40, 20) : fakeImage(20, 40);
    },
  });
  let webpBufferCalls = 0;
  const webpResult = await decodeUploadedImage({
    filePath: fixturePaths.webp,
    createImageFromPath: () => fakeImage(0, 0, true),
    createImageFromBuffer: () => {
      webpBufferCalls += 1;
      return webpBufferCalls === 1 ? fakeImage(0, 0, true) : fakeImage(40, 20);
    },
  });

  assert.equal(rotatedResult.method, 'oriented-png');
  assert.deepEqual(
    { width: rotatedResult.width, height: rotatedResult.height },
    { width: 20, height: 40 },
  );
  assert.equal(webpResult.method, 'converted-png');
});

test('malformed image data fails safely after all decode stages', async () => {
  await assert.rejects(
    decodeUploadedImage({
      filePath: fixturePaths.malformed,
      createImageFromPath: () => fakeImage(0, 0, true),
      createImageFromBuffer: () => fakeImage(0, 0, true),
    }),
    (error) => error.code === 'UNSUPPORTED_IMAGE' && /malformed/i.test(error.message),
  );
});
