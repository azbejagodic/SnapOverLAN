import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { imageFixture } from './helpers/image-fixtures.mjs';
import sharp from 'sharp';
import http from 'node:http';

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
    form.append('photos', new Blob([file.contents ?? await imageFixture(file.type)], { type: file.type }), file.name);
  }
  const response = await request('/api/upload', {
    body: form, lan, method: 'POST',
    headers: lan ? { Origin: 'http://192.168.1.18:8787', 'Sec-Fetch-Site': 'same-origin' } : {},
  });
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
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
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
    headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
  });
  assert.equal(statusResponse.status, 200);
  assert.equal(
    statusResponse.headers.get('access-control-allow-origin'),
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
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
  assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), await imageFixture('image/jpeg'));
});

test('hostile and opaque browser Origins cannot read management or stored files', async () => {
  const uploaded = await uploadFiles([{ name: 'private.jpg', type: 'image/jpeg' }]);
  for (const hostile of ['https://evil.example', 'http://evil.example', 'null', 'http://localhost:9999', 'chrome-extension://fake', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop.evil.example']) {
    for (const resource of ['/api/latest', '/api/server-status', '/api/server-control', '/api/batches', uploaded.body.files[0].url]) {
      const response = await request(resource, { headers: { Origin: hostile } });
      assert.equal(response.status, 403, `${hostile} ${resource}`);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  }
});

test('hostile browser requests are rejected before state changes, including simple POSTs', async () => {
  const batchesBefore = await request('/api/batches').then((r) => r.json());
  const settingBefore = autoCopyEnabled;
  const id = batchesBefore.batches[0].id;
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { Referer: 'https://evil.example/' }]) {
    for (const [resource, method] of [[`/api/batches/${id}/select`, 'POST'], [`/api/batches/${id}`, 'DELETE'], ['/api/batches', 'DELETE'], ['/api/auto-copy', 'PUT'], ['/api/server-shutdown', 'POST']]) {
      const response = await request(resource, { method, headers });
      assert.equal(response.status, 403, `${resource} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(autoCopyEnabled, settingBefore);
  assert.deepEqual(await request('/api/batches').then((r) => r.json()), batchesBefore);
  const preflight = await request('/api/auto-copy', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(preflight.status, 403);
});

test('extension IDs, preflight, thumbnails, and Auto-copy access work on loopback', async () => {
  for (const extensionOrigin of ['chrome-extension://abcdefghijklmnopabcdefghijklmnop', `chrome-extension://${'p'.repeat(32)}`]) {
    const preflight = await request('/api/auto-copy', { method: 'OPTIONS', headers: { Origin: extensionOrigin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), extensionOrigin);
    const response = await request('/api/auto-copy', { method: 'PUT', headers: { Origin: extensionOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    assert.equal(response.status, 200);
    assert.equal(autoCopyEnabled, false);
    const latest = await request('/api/latest').then((r) => r.json());
    const thumbnail = await request(latest.files[0].url, { headers: { Referer: `${extensionOrigin}/popup.html`, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(thumbnail.status, 200);
    assert.equal((await request('/api/latest', { lan: true, headers: { Origin: extensionOrigin } })).status, 404);
  }
  assert.equal((await request('/api/batches', { headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
});

const rawRequest = (pathname, headers = {}) => new Promise((resolve, reject) => {
  const req = http.get(`${origin}`, { path: pathname, headers }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
});

test('DNS rebinding hosts and cross-site no-Origin reads do not get native access', async () => {
  assert.equal(await rawRequest('/api/latest', { Host: 'rebound.evil.example:8787' }), 403);
  assert.equal(await rawRequest('/api/latest', { Host: 'rebound.evil.example:8787', Origin: 'http://rebound.evil.example:8787' }), 403);
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Referer: 'https://evil.example/' }]) {
    assert.equal((await request('/api/latest', { headers })).status, 403);
  }
});

test('verified content determines filenames, MIME headers, nosniff, and unchanged bytes', async () => {
  for (const [actualType, extension] of [['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/heic', '.heic'], ['image/heif', '.heif']]) {
    const contents = await imageFixture(actualType);
    const uploaded = await uploadFiles([{ name: 'payload.html', type: 'image/jpeg', contents }], { lan: true });
    assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.body));
    const file = uploaded.body.files[0];
    assert.equal(path.extname(file.name), extension);
    const batches = await request('/api/batches').then((r) => r.json());
    const id = batches.batches.find((batch) => batch.current).id;
    for (const route of [file.url, `/api/batches/${id}/files/${file.name}`]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await request(route, { method });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), actualType);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        if (method === 'GET') assert.deepEqual(Buffer.from(await response.arrayBuffer()), contents);
      }
    }
  }
});

test('fake, empty, unsupported, and malformed images never leave a partial batch', async () => {
  const batchesBefore = await request('/api/batches').then((r) => r.json());
  const latestBefore = await request('/api/latest').then((r) => r.json());
  const jpeg = await imageFixture('image/jpeg');
  const png = await imageFixture('image/png');
  const heic = await imageFixture('image/heic');
  const cases = [
    { contents: Buffer.from('<html><script>alert(1)</script></html>') },
    { contents: Buffer.alloc(0) },
    { contents: jpeg, type: 'text/html' },
    { contents: jpeg.subarray(0, jpeg.length - 20) },
    { contents: png.subarray(0, png.length - 25) },
    { contents: heic.subarray(0, heic.length - 30), type: 'image/heic' },
    { contents: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
  ];
  for (const invalid of cases) {
    const result = await uploadFiles([
      { name: 'valid.jpg', type: 'image/jpeg' },
      { name: 'payload.html', type: 'image/jpeg', ...invalid },
    ], { lan: true });
    assert.equal(result.response.status, 400, JSON.stringify(result.body));
    assert.deepEqual(await fs.readdir(path.join(dataRoot, 'upload-tmp')), []);
    assert.deepEqual(await request('/api/batches').then((r) => r.json()), batchesBefore);
    assert.deepEqual(await request('/api/latest').then((r) => r.json()), latestBefore);
  }
});

test('12MB size and 10-file limits remain enforced with clean failure', async () => {
  const jpeg = await imageFixture('image/jpeg');
  const exactLimit = Buffer.alloc(12 * 1024 * 1024);
  jpeg.copy(exactLimit);
  const accepted = await uploadFiles([{ name: 'limit.jpg', type: 'image/jpeg', contents: exactLimit }]);
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  const before = await request('/api/batches').then((r) => r.json());
  const rejected = await uploadFiles([{ name: 'oversize.jpg', type: 'image/jpeg', contents: Buffer.concat([exactLimit, Buffer.alloc(1)]) }]);
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.body.error, /12MB/);
  assert.deepEqual(await request('/api/batches').then((r) => r.json()), before);
  assert.deepEqual(await fs.readdir(path.join(dataRoot, 'upload-tmp')), []);
  const ten = await uploadFiles(Array.from({ length: 10 }, () => ({ name: 'photo.jpg', type: 'image/jpeg' })));
  assert.equal(ten.response.status, 200);
  assert.equal(ten.body.files.length, 10);
  const eleven = await uploadFiles(Array.from({ length: 11 }, () => ({ name: 'photo.jpg', type: 'image/jpeg' })));
  assert.equal(eleven.response.status, 400);
  assert.deepEqual(await fs.readdir(path.join(dataRoot, 'upload-tmp')), []);
});

test('absurd dimensions are rejected before full pixel decoding', async () => {
  const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: 'black' } }).png().toBuffer();
  const result = await uploadFiles([{ name: 'huge.png', type: 'image/png', contents: huge }]);
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /pixel limit|megapixel/i);
  assert.deepEqual(await fs.readdir(path.join(dataRoot, 'upload-tmp')), []);
});

test('a full-resolution 48MP phone image remains uploadable', async () => {
  const contents = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#507080' } }).jpeg().toBuffer();
  const result = await uploadFiles([{ name: 'phone-48mp.jpg', type: 'image/jpeg', contents }]);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
});

test('in-progress batches are invisible and an aborted multipart upload is cleaned up', async () => {
  const before = await request('/api/batches').then((r) => r.json());
  const boundary = 'snapoverlan-aborted-test';
  const req = http.request(`${origin}/api/upload`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  req.on('error', () => {});
  req.write(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="unfinished.html"\r\nContent-Type: image/jpeg\r\n\r\n`);
  req.write(await imageFixture('image/jpeg'));
  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('Upload staging/cleanup did not complete.');
  };
  try {
    await waitFor(async () => (await fs.readdir(path.join(dataRoot, 'upload-tmp'))).length === 1);
    assert.deepEqual(await request('/api/batches').then((r) => r.json()), before);
  } finally { req.destroy(); }
  await waitFor(async () => (await fs.readdir(path.join(dataRoot, 'upload-tmp'))).length === 0);
  assert.deepEqual(await request('/api/batches').then((r) => r.json()), before);
});

test('legacy web extensions are served only as nosniff attachments', async () => {
  const batches = await request('/api/batches').then((r) => r.json());
  const id = batches.batches.find((batch) => batch.current).id;
  await fs.writeFile(path.join(dataRoot, 'batches', id, 'legacy.html'), '<script>alert(1)</script>');
  for (const route of ['/files/legacy.html', `/api/batches/${id}/files/legacy.html`]) {
    const response = await request(route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('content-disposition'), 'attachment');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('batch and file routes reject raw and encoded traversal and absolute paths', async () => {
  const batches = await request('/api/batches').then((r) => r.json());
  const id = batches.batches[0].id;
  for (const name of ['..%2foutside.jpg', '..%5coutside.jpg', '%2foutside.jpg', 'C:%5coutside.jpg', 'folder%2ffile.jpg', '%252e%252e%252foutside.jpg']) {
    for (const route of [`/files/${name}`, `/api/batches/${id}/files/${name}`]) {
      assert.ok([400, 404].includes(await rawRequest(route)), route);
    }
  }
  for (const invalidId of ['..', '..%5c', '%2fabsolute', 'C:%5c', 'bad_id']) {
    assert.ok([400, 404].includes(await rawRequest(`/api/batches/${invalidId}`)));
  }
});
