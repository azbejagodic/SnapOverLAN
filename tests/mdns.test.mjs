import assert from 'node:assert/strict';
import dnsPacket from 'dns-packet';
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

const createDecodedHostnameQuery = ({ hostname, qtype = 'A', qu = false }) => {
  const questions = [
    { name: hostname, type: 'UNKNOWN_65', class: 'IN' },
    { name: hostname, type: 'AAAA', class: 'IN' },
    { name: hostname, type: qtype, class: 'IN' },
  ];
  const encoded = dnsPacket.encode({ type: 'query', questions });
  let offset = 12;
  for (const question of questions) {
    offset += dnsPacket.name.encodingLength(question.name) + 2;
    if (qu && question.type === qtype) {
      encoded.writeUInt16BE(encoded.readUInt16BE(offset) | 0x8000, offset);
    }
    offset += 2;
  }
  return dnsPacket.decode(encoded);
};

const createAdvertiserFixture = async () => {
  const events = [];
  const logs = [];
  const publications = [];
  const responses = [];
  const warnings = [];
  let constructorOptions = null;
  let responseError = null;
  let service = null;
  let mdnsSocket = null;

  class FakeBonjour {
    constructor(options) {
      constructorOptions = options;
      mdnsSocket = new EventEmitter();
      mdnsSocket.respond = (packet, destinationOrCallback, responseCallback) => {
        const multicast = typeof destinationOrCallback === 'function';
        const callback = multicast ? destinationOrCallback : responseCallback;
        responses.push({
          destination: multicast ? null : destinationOrCallback,
          packet,
        });
        callback?.(responseError);
      };
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
    logger: {
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    },
    port: 8787,
  });
  const status = await advertiser.start();
  return {
    advertiser,
    constructorOptions,
    events,
    logs,
    mdnsSocket,
    publications,
    responses,
    service,
    setResponseError: (error) => { responseError = error; },
    status,
    warnings,
  };
};

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

test('mDNS service leaves hostname A/AAAA ownership to the explicit responder', async () => {
  const fixture = await createAdvertiserFixture();

  assert.deepEqual(fixture.constructorOptions, { bind: '0.0.0.0', interface: '192.168.1.25' });
  assert.deepEqual(fixture.publications[0], {
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
    fixture.service.records().filter(({ type }) => type === 'A' || type === 'AAAA'),
    [],
  );
  assert.deepEqual(fixture.status, {
    deviceId: 'a1b2c3d4',
    hostname: 'snap-a1b2c3d4.local',
    ipv4Addresses: ['192.168.1.25'],
    port: 8787,
    stableUrl: 'http://snap-a1b2c3d4.local:8787',
    started: true,
  });

  await fixture.advertiser.stop();
  assert.deepEqual(fixture.events, ['unpublish', 'destroy']);
});

test('normal A and ANY questions produce multicast and compatibility-unicast A answers', async () => {
  const fixture = await createAdvertiserFixture();
  const hostname = fixture.status.hostname;
  const remote = { address: '192.168.1.50', port: 5353 };
  const query = createDecodedHostnameQuery({ hostname });
  const expectedAnswers = [{
    name: hostname,
    type: 'A',
    class: 'IN',
    flush: true,
    ttl: 120,
    data: '192.168.1.25',
  }];

  assert.deepEqual(query.questions.map(({ type }) => type), ['UNKNOWN_65', 'AAAA', 'A']);
  fixture.mdnsSocket.emit('query', query, remote);

  assert.equal(fixture.responses.length, 2);
  assert.equal(fixture.responses[0].destination, null);
  assert.deepEqual(fixture.responses[1].destination, remote);
  assert.deepEqual(fixture.responses[0].packet.answers, expectedAnswers);
  assert.deepEqual(fixture.responses[1].packet.answers, expectedAnswers);
  assert.match(fixture.logs.join('\n'), /qtype=UNKNOWN_65[^\n]*QU=false/);
  assert.match(fixture.logs.join('\n'), /qtype=AAAA[^\n]*QU=false/);
  assert.match(fixture.logs.join('\n'), /qtype=A rawQclass=IN qclassCode=1 decodedQclass=IN QU=false/);
  assert.match(
    fixture.logs.join('\n'),
    /destination=224\.0\.0\.251:5353 mode=multicast result=success/,
  );
  assert.match(
    fixture.logs.join('\n'),
    /destination=192\.168\.1\.50:5353 mode=compat-unicast result=success/,
  );

  const anyQuery = createDecodedHostnameQuery({ hostname, qtype: 'ANY' });
  fixture.mdnsSocket.emit('query', anyQuery, remote);
  assert.equal(fixture.responses.length, 4);
  assert.equal(fixture.responses[2].destination, null);
  assert.deepEqual(fixture.responses[3].destination, remote);
  assert.deepEqual(fixture.responses[2].packet.answers, expectedAnswers);
  assert.deepEqual(fixture.responses[3].packet.answers, expectedAnswers);

  fixture.mdnsSocket.emit('query', {
    questions: [
      { name: hostname, type: 'UNKNOWN_65', class: 'IN' },
      { name: hostname, type: 'AAAA', class: 'IN' },
    ],
  }, remote);
  assert.equal(fixture.responses.length, 4);

  fixture.mdnsSocket.emit('query', {
    questions: [{ name: `other-${hostname}`, type: 'A', class: 'IN' }],
  }, remote);
  assert.equal(fixture.responses.length, 4);

  fixture.mdnsSocket.emit('query', {
    questions: [{ name: hostname, type: 'A', class: 'CH' }],
  }, remote);
  assert.equal(fixture.responses.length, 4);

  fixture.mdnsSocket.emit('query', {
    questions: [{ name: hostname, type: 'A', class: 'IN' }],
  });
  assert.equal(fixture.responses.length, 5);
  assert.equal(fixture.responses[4].destination, null);
  assert.deepEqual(fixture.responses[4].packet.answers, expectedAnswers);

  await fixture.advertiser.stop();
  assert.equal(fixture.mdnsSocket.listenerCount('query'), 0);
});

test('QU A question produces one unicast answer to the requesting address and port', async () => {
  const fixture = await createAdvertiserFixture();
  const hostname = fixture.status.hostname;
  const remote = { address: '192.168.1.51', port: 5353 };
  const query = createDecodedHostnameQuery({ hostname, qu: true });
  const aQuestion = query.questions.find(({ type }) => type === 'A');

  // dns-packet 5.6.1 preserves the QU bit only in this UNKNOWN_<class> string.
  assert.equal(aQuestion.class, 'UNKNOWN_32769');
  assert.equal(aQuestion.qu, undefined);
  fixture.mdnsSocket.emit('query', query, remote);

  assert.equal(fixture.responses.length, 1);
  assert.deepEqual(fixture.responses[0].destination, remote);
  assert.deepEqual(fixture.responses[0].packet.answers, [{
    name: hostname,
    type: 'A',
    class: 'IN',
    flush: true,
    ttl: 120,
    data: '192.168.1.25',
  }]);
  assert.match(
    fixture.logs.join('\n'),
    /qtype=A rawQclass=UNKNOWN_32769 qclassCode=32769 decodedQclass=IN QU=true/,
  );
  assert.match(
    fixture.logs.join('\n'),
    /destination=192\.168\.1\.51:5353 mode=unicast result=success/,
  );
  assert.doesNotMatch(fixture.logs.join('\n'), /mode=compat-unicast/);

  fixture.setResponseError(new Error('simulated send failure'));
  fixture.mdnsSocket.emit('query', query, remote);
  assert.match(
    fixture.warnings.join('\n'),
    /mode=unicast result=error error=simulated send failure/,
  );

  await fixture.advertiser.stop();
  assert.equal(fixture.mdnsSocket.listenerCount('query'), 0);
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
