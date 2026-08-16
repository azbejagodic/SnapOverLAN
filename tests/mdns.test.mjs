import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snapoverlan-mdns-'));
const serverDataRoot = path.join(testRoot, 'server-data');
process.env.SNAPOVERLAN_DATA_DIR = serverDataRoot;

const {
  DEVICE_ID_PATTERN,
  formatDeviceHostname,
  formatStableUrl,
  getDeviceIdPath,
  getOrCreateDeviceId,
} = await import('../app/server/device-identity.js');
const { createMdnsAdvertiser } = await import('../app/server/mdns.js');
const { getPhoneUrlRecords, getPreferredLanIpv4Address } = await import('../app/server/lan.js');
const { createServerApp } = await import('../app/server/app.js');
const { startServer, stopServer } = await import('../app/server/index.js');
const { QR_MAX_UTF8_BYTES } = await import('../app/renderer/qr-code.js');
const rendererSource = await fs.readFile(
  new URL('../app/renderer/app.js', import.meta.url),
  'utf8',
);

after(async () => {
  await stopServer();
  await fs.rm(testRoot, { recursive: true, force: true });
});

test('device ID is generated cryptographically once and reused across reloads', async () => {
  const dataRoot = path.join(testRoot, 'identity-persistence');
  let generationCalls = 0;
  const firstId = await getOrCreateDeviceId({
    dataRoot,
    randomBytes: () => {
      generationCalls += 1;
      return Buffer.from('a1b2c3d4', 'hex');
    },
  });
  const secondId = await getOrCreateDeviceId({
    dataRoot,
    randomBytes: () => {
      generationCalls += 1;
      return Buffer.from('ffffffff', 'hex');
    },
  });

  assert.equal(firstId, 'a1b2c3d4');
  assert.equal(secondId, firstId);
  assert.equal(generationCalls, 1);
  assert.equal((await fs.readFile(getDeviceIdPath(dataRoot), 'utf8')).trim(), firstId);
  assert.match(firstId, DEVICE_ID_PATTERN);
});

test('corrupt device identity is safely replaced with a valid persistent ID', async () => {
  const dataRoot = path.join(testRoot, 'identity-corrupt');
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(getDeviceIdPath(dataRoot), 'not a valid hostname id\n');

  const deviceId = await getOrCreateDeviceId({
    dataRoot,
    randomBytes: () => Buffer.from('1234abcd', 'hex'),
  });

  assert.equal(deviceId, '1234abcd');
  assert.equal((await fs.readFile(getDeviceIdPath(dataRoot), 'utf8')).trim(), deviceId);
});

test('stable hostname and URL are valid and fit the built-in QR capacity', () => {
  const deviceId = 'a1b2c3d4';
  const hostname = formatDeviceHostname(deviceId);
  const stableUrl = formatStableUrl(deviceId, 8787);

  assert.equal(hostname, 'snap-a1b2c3d4.local');
  assert.equal(stableUrl, 'http://snap-a1b2c3d4.local:8787');
  assert.ok(Buffer.byteLength(stableUrl, 'utf8') <= QR_MAX_UTF8_BYTES);
  assert.throws(() => formatDeviceHostname('invalid id'), /invalid/i);
});

test('mDNS publishes only the chosen LAN IPv4 on its explicit multicast interface', async () => {
  const events = [];
  const logs = [];
  const publications = [];
  let constructorOptions = null;
  let service = null;
  let mdnsSocket = null;

  class FakeBonjour {
    constructor(options) {
      constructorOptions = options;
      mdnsSocket = new EventEmitter();
      this.server = { mdns: mdnsSocket };
    }

    publish(options) {
      publications.push(options);
      service = new EventEmitter();
      service.records = () => [
        { name: options.host, type: 'A', data: '192.168.1.25' },
        { name: options.host, type: 'A', data: '26.10.20.30' },
        { name: options.host, type: 'AAAA', data: 'fe80::1' },
        { name: `${options.name}._http._tcp.local`, type: 'SRV', data: { target: options.host } },
      ];
      setImmediate(() => service.emit('up'));
      return service;
    }

    unpublishAll(callback) {
      events.push('unpublish');
      callback();
    }

    destroy(callback) {
      events.push('destroy');
      callback();
    }
  }

  const advertiser = createMdnsAdvertiser({
    BonjourClass: FakeBonjour,
    deviceId: 'a1b2c3d4',
    getLanAddresses: () => [
      { address: '192.168.1.25', private: true },
      { address: '26.10.20.30', private: false },
    ],
    logger: { log: (message) => logs.push(message), warn: (message) => logs.push(message) },
    port: 8787,
  });
  const status = await advertiser.start();

  assert.deepEqual(constructorOptions, { bind: '0.0.0.0', interface: '192.168.1.25' });
  assert.deepEqual(publications[0], {
    disableIPv6: true,
    host: 'snap-a1b2c3d4.local',
    name: 'SnapOverLAN a1b2c3d4',
    port: 8787,
    protocol: 'tcp',
    type: 'http',
    txt: {
      application: 'SnapOverLAN',
      deviceId: 'a1b2c3d4',
      protocolVersion: '1',
    },
  });
  assert.deepEqual(
    service.records().filter(({ type }) => type === 'A' || type === 'AAAA'),
    [{ name: 'snap-a1b2c3d4.local', type: 'A', data: '192.168.1.25' }],
  );
  assert.deepEqual(status, {
    deviceId: 'a1b2c3d4',
    hostname: 'snap-a1b2c3d4.local',
    ipv4Addresses: ['192.168.1.25'],
    port: 8787,
    stableUrl: 'http://snap-a1b2c3d4.local:8787',
    started: true,
  });
  mdnsSocket.emit('query', {
    questions: [{ name: 'snap-a1b2c3d4.local', type: 'A' }],
  }, { address: '192.168.1.50', port: 5353 });
  assert.match(logs.join('\n'), /source=192\.168\.1\.50:5353 types=A/);

  await advertiser.stop();
  assert.deepEqual(events, ['unpublish', 'destroy']);
  assert.equal(mdnsSocket.listenerCount('query'), 0);
});

test('IP discovery remains available and selects the private LAN address for mDNS', () => {
  const addresses = [
    { address: '192.168.1.25', private: true },
    { address: '26.10.20.30', private: false },
  ];
  assert.equal(getPreferredLanIpv4Address(addresses), '192.168.1.25');
  assert.deepEqual(getPhoneUrlRecords({ addresses, port: 8787 }), [
    { address: '192.168.1.25', private: true, url: 'http://192.168.1.25:8787' },
    { address: '26.10.20.30', private: false, url: 'http://26.10.20.30:8787' },
  ]);
});

test('/api/phone-url exposes stableUrl while preserving direct IP primaryUrl and fallbacks', async (t) => {
  let status = {
    port: 8787,
    stableUrl: 'http://snap-a1b2c3d4.local:8787',
    lanUrls: [
      { address: '192.168.1.25', private: true, url: 'http://192.168.1.25:8787' },
      { address: '26.10.20.30', private: false, url: 'http://26.10.20.30:8787' },
    ],
  };
  const app = createServerApp({
    getServerStatus: () => status,
    isLoopbackRequest: () => true,
    onShutdown: () => {},
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  ))));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const stableResponse = await fetch(`${origin}/api/phone-url`).then((response) => response.json());
  assert.equal(stableResponse.stableUrl, status.stableUrl);
  assert.equal(stableResponse.primaryUrl, 'http://192.168.1.25:8787');
  assert.deepEqual(stableResponse.urls, status.lanUrls);

  status = { port: 8787, stableUrl: '', lanUrls: [] };
  const fallbackResponse = await fetch(`${origin}/api/phone-url`).then((response) => response.json());
  assert.equal(fallbackResponse.stableUrl, '');
  assert.doesNotMatch(fallbackResponse.primaryUrl, /\.local(?::|$)/);
  assert.equal(fallbackResponse.urls.length, 1);
});

test('Electron phone setup prefers stableUrl and diagnostics retain raw LAN details', () => {
  assert.match(
    rendererSource,
    /const stableUrl = isUsablePhoneUrl\(data\?\.stableUrl\)[\s\S]*?currentPhoneUrl = stableUrl \|\| choosePhoneUrl\(data\)\?\.url \|\| ''/,
  );
  assert.match(rendererSource, /addDiagnosticRow\('Device ID', data\.deviceId/);
  assert.match(rendererSource, /addDiagnosticRow\('\.local hostname', data\.hostname/);
  assert.match(rendererSource, /renderUrlList\(diagnosticsUrls, 'Detected LAN URLs', data\.lanUrls \|\| \[\]\)/);
});

test('server status exposes persistent identity and cleanly stops successful mDNS', async () => {
  const events = [];
  let advertisedDeviceId = '';
  const server = await startServer({
    host: '127.0.0.1',
    log: false,
    mdnsFactory: ({ deviceId, port }) => {
      advertisedDeviceId = deviceId;
      return {
        start: async () => ({
          deviceId,
          hostname: formatDeviceHostname(deviceId),
          ipv4Addresses: ['192.168.1.25'],
          port,
          stableUrl: formatStableUrl(deviceId, port),
          started: true,
        }),
        stop: async () => { events.push('stop'); },
      };
    },
    port: 0,
  });
  const { port } = server.address();
  const status = await fetch(`http://127.0.0.1:${port}/api/server-status`).then(
    (response) => response.json(),
  );
  const phoneUrl = await fetch(`http://127.0.0.1:${port}/api/phone-url`).then(
    (response) => response.json(),
  );

  assert.match(advertisedDeviceId, DEVICE_ID_PATTERN);
  assert.equal(status.deviceId, advertisedDeviceId);
  assert.equal(status.hostname, formatDeviceHostname(advertisedDeviceId));
  assert.equal(status.stableUrl, formatStableUrl(advertisedDeviceId, port));
  assert.equal(phoneUrl.stableUrl, status.stableUrl);

  await stopServer();
  assert.deepEqual(events, ['stop']);
});

test('mDNS startup failure keeps the HTTP server and IP fallback working', async () => {
  let stopCalled = false;
  const server = await startServer({
    host: '127.0.0.1',
    log: false,
    mdnsFactory: () => ({
      start: async () => { throw new Error('multicast unavailable'); },
      stop: async () => { stopCalled = true; },
    }),
    port: 0,
  });
  const { port } = server.address();
  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/server-status`);
  const status = await statusResponse.json();
  const phoneUrl = await fetch(`http://127.0.0.1:${port}/api/phone-url`).then(
    (response) => response.json(),
  );

  assert.equal(statusResponse.status, 200);
  assert.match(status.deviceId, DEVICE_ID_PATTERN);
  assert.match(status.hostname, /^snap-[a-f0-9]{8}\.local$/);
  assert.equal(status.stableUrl, '');
  assert.equal(phoneUrl.stableUrl, '');
  assert.doesNotMatch(phoneUrl.primaryUrl, /\.local(?::|$)/);
  assert.ok(phoneUrl.urls.length > 0);
  assert.equal(stopCalled, true);

  await stopServer();
});
