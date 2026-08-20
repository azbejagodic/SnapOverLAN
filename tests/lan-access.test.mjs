import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-lan-access-'));
process.env.SNAPOVERLAN_DATA_DIR = dataRoot;

const [{ createServerApp }, { ensureStorageDirectories }] = await Promise.all([
  import('../app/server/app.js'),
  import('../app/server/storage.js'),
]);

await ensureStorageDirectories();
let autoCopyEnabled = false;
const app = createServerApp({
  getAutoCopySetting: () => autoCopyEnabled,
  getServerStatus: () => ({
    status: 'listening',
    port: 8787,
    stableUrl: 'http://snap-test.local:8787',
    lanUrls: [{ address: '192.168.1.18', url: 'http://192.168.1.18:8787' }],
  }),
  isLoopbackRequest: (req) => req.get('x-snapoverlan-test-client') !== 'lan',
  onShutdown: () => {
    throw new Error('Remote shutdown must not be reached.');
  },
  onUploadCompleted: () => {},
  setAutoCopySetting: (enabled) => {
    autoCopyEnabled = enabled;
    return enabled;
  },
});
const server = await new Promise((resolve, reject) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  instance.once('error', reject);
});
const origin = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  await fs.rm(dataRoot, { recursive: true, force: true });
});

const request = (pathname, options = {}) => {
  const { lan = false, headers = {}, ...fetchOptions } = options;
  return fetch(`${origin}${pathname}`, {
    ...fetchOptions,
    headers: {
      ...headers,
      ...(lan ? { 'x-snapoverlan-test-client': 'lan' } : {}),
    },
  });
};

const uploadFiles = async (files, { lan = false } = {}) => {
  const form = new FormData();
  for (const file of files) {
    form.append('photos', new Blob([file.contents || file.name], { type: file.type }), file.name);
  }
  const response = await request('/api/upload', { body: form, lan, method: 'POST' });
  return { response, body: await response.json() };
};

test('LAN clients can load the static phone interface without permissive CORS', async () => {
  const pageResponse = await request('/', {
    lan: true,
    headers: { Origin: 'https://unrelated.example' },
  });
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /SnapOverLAN/);
  assert.equal(pageResponse.headers.get('access-control-allow-origin'), null);

  const appResponse = await request('/app.js', { lan: true });
  assert.equal(appResponse.status, 200);
  assert.match(await appResponse.text(), /ALLOWED_IMAGE_MIME_TYPES/);

  const stylesResponse = await request('/styles.css', { lan: true, method: 'HEAD' });
  assert.equal(stylesResponse.status, 200);
});

test('LAN uploads accept only the approved image MIME allowlist', async () => {
  const allowedFiles = [
    { name: 'photo.jpg', type: 'image/jpeg' },
    { name: 'photo.png', type: 'image/png' },
    { name: 'photo.webp', type: 'image/webp' },
    { name: 'photo.heic', type: 'image/heic' },
    { name: 'photo.heif', type: 'image/heif' },
  ];
  const accepted = await uploadFiles(allowedFiles, { lan: true });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.files.length, allowedFiles.length);
  assert.deepEqual(
    accepted.body.files.map(({ name }) => path.extname(name)),
    ['.jpg', '.png', '.webp', '.heic', '.heif'],
  );

  const rejectedFiles = [
    { name: 'clip.mp4', type: 'video/mp4' },
    { name: 'clip.mov', type: 'video/quicktime' },
    { name: 'clip.webm', type: 'video/webm' },
    { name: 'notes.txt', type: 'text/plain' },
    { name: 'vector.svg', type: 'image/svg+xml' },
  ];
  for (const file of rejectedFiles) {
    const rejected = await uploadFiles([file], { lan: true });
    assert.equal(rejected.response.status, 400, file.type);
    assert.match(rejected.body.error, /Only JPEG, PNG, WebP, HEIC, and HEIF images are allowed/);
  }

  const tooMany = await uploadFiles(Array.from({ length: 11 }, (_, index) => ({
    name: `photo-${index + 1}.jpg`,
    type: 'image/jpeg',
  })), { lan: true });
  assert.equal(tooMany.response.status, 400);
  assert.match(tooMany.body.error, /Maximum 10 files are allowed/);
});

test('LAN clients receive 404 for batch, file, settings, diagnostics, and control APIs', async () => {
  const upload = await uploadFiles([{ name: 'private.png', type: 'image/png' }]);
  assert.equal(upload.response.status, 200);
  const filename = upload.body.files[0].name;
  const batchesResponse = await request('/api/batches');
  const { batches } = await batchesResponse.json();
  const batchId = batches[0].id;

  const blockedRequests = [
    request('/api/latest', { lan: true }),
    request('/api/latest/download', { lan: true }),
    request('/api/batches', { lan: true }),
    request(`/api/batches/${encodeURIComponent(batchId)}`, { lan: true }),
    request(`/api/batches/${encodeURIComponent(batchId)}/files/${encodeURIComponent(filename)}`, { lan: true }),
    request(`/api/batches/${encodeURIComponent(batchId)}/select`, { lan: true, method: 'POST' }),
    request(`/api/batches/${encodeURIComponent(batchId)}`, { lan: true, method: 'DELETE' }),
    request('/api/batches', { lan: true, method: 'DELETE' }),
    request('/files/' + encodeURIComponent(filename), { lan: true }),
    request('/api/storage-settings', { lan: true }),
    request('/api/storage-settings', {
      lan: true,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxBatches: 1 }),
    }),
    request('/api/server-status', { lan: true }),
    request('/api/phone-url', { lan: true }),
    request('/api/upload-status', { lan: true }),
    request('/api/auto-copy', { lan: true }),
    request('/api/server-control', { lan: true }),
    request('/api/server-shutdown', { lan: true, method: 'POST' }),
  ];
  const blockedResponses = await Promise.all(blockedRequests);
  assert.deepEqual(blockedResponses.map(({ status }) => status), blockedResponses.map(() => 404));

  const remainingBatches = await request('/api/batches').then((response) => response.json());
  assert.ok(remainingBatches.batches.some(({ id }) => id === batchId));
});

test('loopback desktop APIs and existing photo downloads remain available', async () => {
  const statusResponse = await request('/api/server-status', {
    headers: { Origin: 'chrome-extension://snapoverlan-test' },
  });
  assert.equal(statusResponse.status, 200);
  assert.equal(
    statusResponse.headers.get('access-control-allow-origin'),
    'chrome-extension://snapoverlan-test',
  );
  assert.equal((await statusResponse.json()).status, 'listening');

  assert.equal((await request('/api/phone-url')).status, 200);
  assert.equal((await request('/api/batches')).status, 200);
  assert.equal((await request('/api/storage-settings')).status, 200);
  assert.equal((await request('/api/auto-copy')).status, 200);

  const autoCopyResponse = await request('/api/auto-copy', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(autoCopyResponse.status, 200);
  assert.deepEqual(await autoCopyResponse.json(), { enabled: true });

  const upload = await uploadFiles([{ name: 'desktop.jpg', type: 'image/jpeg' }]);
  assert.equal(upload.response.status, 200);
  const fileResponse = await request(`/files/${encodeURIComponent(upload.body.files[0].name)}`);
  assert.equal(fileResponse.status, 200);
  assert.equal(await fileResponse.text(), 'desktop.jpg');
});
