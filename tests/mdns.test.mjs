import assert from 'node:assert/strict';
import dnsPacket from 'dns-packet';
import { Bonjour } from 'bonjour-service';
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
const { createMdnsAdvertiser, getMdnsIpv6Interface } = await import('../app/server/mdns.js');
const { getPhoneUrlRecords, getPreferredLanIpv4Address } = await import('../app/server/lan.js');
const { startServer, stopServer } = await import('../app/server/index.js');
const { QR_MAX_UTF8_BYTES } = await import('../app/renderer/qr-code.js');
const rendererSource = await fs.readFile(
  new URL('../app/renderer/app.js', import.meta.url),
  'utf8',
);

const createDecodedHostnameQuery = ({ hostname, qtype = 'A', qu = false, allQu = false, encodedResult = false }) => {
  const questions = [
    { name: hostname, type: 'UNKNOWN_65', class: 'IN' },
    { name: hostname, type: 'AAAA', class: 'IN' },
    { name: hostname, type: qtype, class: 'IN' },
  ];
  const encoded = dnsPacket.encode({ type: 'query', questions });
  let offset = 12;
  for (const question of questions) {
    offset += dnsPacket.name.encodingLength(question.name) + 2;
    if (allQu || (qu && question.type === qtype)) {
      encoded.writeUInt16BE(encoded.readUInt16BE(offset) | 0x8000, offset);
    }
    offset += 2;
  }
  return encodedResult ? encoded : dnsPacket.decode(encoded);
};

// Exercise the installed Bonjour/multicast-dns stack without opening UDP sockets.
const createSocketHarness = ({ failIpv6 = false } = {}) => {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(options) { super(); this.options = options; this.sent = []; this.memberships = []; this.dropped = []; this.closed = false; sockets.push(this); }
    bind(port, address, callback) {
      this.bound = { port, address };
      setImmediate(() => {
        if (failIpv6 && this.options.type === 'udp6') {
          this.emit('error', Object.assign(new Error('IPv6 port unavailable'), { code: 'EADDRINUSE' }));
        } else { this.emit('listening'); callback(); }
      });
    }
    address() { return this.bound; }
    addMembership(group, iface) { this.memberships.push({ group, iface }); }
    dropMembership(group, iface) { this.dropped.push({ group, iface }); }
    setMulticastInterface(iface) { this.outgoingInterface = iface; }
    setMulticastTTL(ttl) { this.ttl = ttl; }
    setMulticastLoopback() {}
    send(buffer, _offset, _length, port, address, callback) {
      this.sent.push({ packet: dnsPacket.decode(buffer), port, address });
      setImmediate(() => callback?.());
    }
    close(callback) { this.closed = true; setImmediate(() => callback?.()); }
  }
  class SocketBonjour extends Bonjour {
    constructor(options, onError) { super({ ...options, socket: options.socket || new FakeSocket({ type: 'udp4', reuseAddr: true }) }, onError); }
  }
  return { sockets, BonjourClass: SocketBonjour, socketFactory: (options) => new FakeSocket(options) };
};

const createAdvertiserFixture = async ({ debug = false, useEnvironment = false, ipv6Interface = '' } = {}) => {
  const events = [];
  const logs = [];
  const publications = [];
  const responses = [];
  const warnings = [];
  let constructorOptions = null;
  let responseError = null;
  let socketWarning = null;
  let service = null;
  let mdnsSocket = null;
  const sockets = [];
  const optionsByTransport = [];
  const services = [];
  const socketOptions = [];

  class FakeBonjour {
    constructor(options, onWarning) {
      constructorOptions = options;
      optionsByTransport.push(options);
      socketWarning = onWarning;
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
      sockets.push(mdnsSocket);
    }

    publish(options) {
      publications.push(options);
      service = new EventEmitter();
      service.records = () => [
        { name: options.host, type: 'A', data: '192.168.1.25' },
        { name: options.host, type: 'A', data: '26.10.20.30' },
        { name: options.host, type: 'AAAA', data: 'fe80::1' },
        { name: `${options.name}._http._tcp.local`, type: 'SRV', data: { target: options.host } },
        { name: '_http._tcp.local', type: 'PTR', data: `${options.name}._http._tcp.local` },
        { name: `${options.name}._http._tcp.local`, type: 'TXT', data: ['application=SnapOverLAN'] },
      ];
      services.push(service);
      const published = service;
      setImmediate(() => published.emit('up'));
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

  const advertiserOptions = {
    BonjourClass: FakeBonjour,
    getIpv6Interface: () => ipv6Interface,
    socketFactory: (options) => { socketOptions.push(options); return {}; },
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
  };
  if (!useEnvironment) advertiserOptions.debug = debug;
  const advertiser = createMdnsAdvertiser(advertiserOptions);
  const status = await advertiser.start();
  return {
    advertiser,
    constructorOptions,
    events,
    emitSocketWarning: (error) => socketWarning(error),
    logs,
    mdnsSocket,
    publications,
    responses,
    service,
    setResponseError: (error) => { responseError = error; },
    status,
    warnings,
    sockets, services, optionsByTransport, socketOptions,
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
    ipv6Interface: '',
    port: 8787,
    stableUrl: 'http://snap-a1b2c3d4.local:8787',
    started: true,
  });
  assert.deepEqual(fixture.logs, [
    'SnapOverLAN mDNS ready: snap-a1b2c3d4.local -> 192.168.1.25',
  ]);

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
  assert.doesNotMatch(fixture.logs.join('\n'), /mDNS query:/);
  assert.doesNotMatch(fixture.logs.join('\n'), /mDNS A answer:/);

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
  assert.doesNotMatch(fixture.logs.join('\n'), /mDNS query:|mDNS A answer:/);

  fixture.setResponseError(new Error('simulated send failure'));
  fixture.mdnsSocket.emit('query', query, remote);
  assert.match(
    fixture.warnings.join('\n'),
    /mode=unicast result=error error=simulated send failure/,
  );

  await fixture.advertiser.stop();
  assert.equal(fixture.mdnsSocket.listenerCount('query'), 0);
});

test('SNAPOVERLAN_DEBUG_MDNS=1 enables detailed logs without changing responses', async () => {
  const previousDebugValue = process.env.SNAPOVERLAN_DEBUG_MDNS;
  process.env.SNAPOVERLAN_DEBUG_MDNS = '1';

  try {
    const fixture = await createAdvertiserFixture({ useEnvironment: true });
    const hostname = fixture.status.hostname;
    const remote = { address: '192.168.1.52', port: 5353 };
    fixture.mdnsSocket.emit('query', createDecodedHostnameQuery({ hostname }), remote);

    assert.equal(fixture.responses.length, 2);
    assert.equal(fixture.responses[0].destination, null);
    assert.deepEqual(fixture.responses[1].destination, remote);
    assert.match(fixture.logs.join('\n'), /qtype=UNKNOWN_65[^\n]*QU=false/);
    assert.match(fixture.logs.join('\n'), /qtype=AAAA[^\n]*QU=false/);
    assert.match(
      fixture.logs.join('\n'),
      /qtype=A rawQclass=IN qclassCode=1 decodedQclass=IN QU=false/,
    );
    assert.match(
      fixture.logs.join('\n'),
      /destination=224\.0\.0\.251:5353 mode=multicast result=success/,
    );
    assert.match(
      fixture.logs.join('\n'),
      /destination=192\.168\.1\.52:5353 mode=compat-unicast result=success/,
    );

    await fixture.advertiser.stop();
  } finally {
    if (previousDebugValue === undefined) delete process.env.SNAPOVERLAN_DEBUG_MDNS;
    else process.env.SNAPOVERLAN_DEBUG_MDNS = previousDebugValue;
  }
});

test('mDNS debug logs stay disabled when the environment flag is absent or not 1', async () => {
  const previousDebugValue = process.env.SNAPOVERLAN_DEBUG_MDNS;

  try {
    for (const debugValue of [undefined, 'true']) {
      if (debugValue === undefined) delete process.env.SNAPOVERLAN_DEBUG_MDNS;
      else process.env.SNAPOVERLAN_DEBUG_MDNS = debugValue;

      const fixture = await createAdvertiserFixture({ useEnvironment: true });
      fixture.mdnsSocket.emit('query', createDecodedHostnameQuery({
        hostname: fixture.status.hostname,
      }), { address: '192.168.1.53', port: 5353 });

      assert.doesNotMatch(fixture.logs.join('\n'), /mDNS query:|mDNS A answer:/);
      await fixture.advertiser.stop();
    }
  } finally {
    if (previousDebugValue === undefined) delete process.env.SNAPOVERLAN_DEBUG_MDNS;
    else process.env.SNAPOVERLAN_DEBUG_MDNS = previousDebugValue;
  }
});

test('mDNS socket and publish warnings remain enabled in normal mode', async () => {
  const fixture = await createAdvertiserFixture();

  fixture.emitSocketWarning(new Error('simulated socket warning'));
  fixture.service.emit('error', new Error('simulated publish failure'));

  assert.match(fixture.warnings.join('\n'), /SnapOverLAN mDNS error:/);
  assert.match(fixture.warnings.join('\n'), /SnapOverLAN mDNS publish error:/);
  await fixture.advertiser.stop();
});

test('IP discovery remains available and selects the private LAN address for mDNS', () => {
  const addresses = [
    { address: '192.168.1.25', private: true },
    { address: '26.10.20.30', private: false },
  ];
  assert.equal(getPreferredLanIpv4Address(addresses), '192.168.1.25');
  assert.deepEqual(getPhoneUrlRecords({ addresses, port: 8787 }), [
    { address: '192.168.1.25', private: true, url: 'http://192.168.1.25:8787' },
  ]);
});

test('Electron phone setup prefers stableUrl and diagnostics retain raw LAN details', () => {
  assert.match(
    rendererSource,
    /const stableUrl = isUsablePhoneUrl\(data\?\.stableUrl\)[\s\S]*?currentPhoneUrl = stableUrl \|\| choosePhoneUrl\(data\)\?\.url \|\| ''/,
  );
  assert.match(rendererSource, /addDiagnosticRow\('Device ID', data\.deviceId/);
  assert.match(rendererSource, /addDiagnosticRow\('\.local hostname', data\.hostname/);
  assert.match(rendererSource, /renderUrlList\(diagnosticsUrls, 'Detected LAN URLs',[\s\S]*?isPrivateLanUrl\(item.url\)/);
});

test('server status exposes persistent identity and cleanly stops successful mDNS', async (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({ wifi: [{ family: 'IPv4', internal: false, address: '192.168.1.25' }] }));
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

  assert.match(advertisedDeviceId, DEVICE_ID_PATTERN);
  assert.equal(status.deviceId, advertisedDeviceId);
  assert.equal(status.hostname, formatDeviceHostname(advertisedDeviceId));
  assert.equal(status.stableUrl, formatStableUrl(advertisedDeviceId, port));

  await stopServer();
  assert.deepEqual(events, ['stop']);
});

test('live LAN changes refresh only mDNS, serialize ticks, recover, and stop cleanly', async (t) => {
  let addresses = ['10.1.2.3'];
  t.mock.method(os, 'networkInterfaces', () => ({ wifi: addresses.map((address) => ({
    family: 'IPv4', internal: false, address,
  })) }));
  let monitor;
  let cleared = false;
  let unrefed = false;
  const timer = { unref() { unrefed = true; } };
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (callback, delay, ...args) => {
    if (delay !== 15_000) return originalSet(callback, delay, ...args);
    monitor = callback;
    return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (value) => {
    if (value === timer) cleared = true;
    else originalClear(value);
  });
  const starts = [];
  let stops = 0;
  let active = 0;
  let nextGate = null;
  let release = () => {};
  t.after(async () => { release(); await stopServer(); });
  const server = await startServer({ host: '127.0.0.1', port: 0, log: false,
    mdnsFactory: ({ deviceId, port, getLanAddresses }) => {
      const address = getPreferredLanIpv4Address(getLanAddresses());
      const gate = nextGate;
      nextGate = null;
      let stopped = false;
      return {
        start: async () => {
          assert.equal(active, 0, 'previous advertiser must stop before another starts');
          active += 1;
          starts.push({ deviceId, address });
          if (gate) await gate;
          return { started: true, ipv4Addresses: [address], stableUrl: formatStableUrl(deviceId, port) };
        },
        stop: async () => { assert.equal(stopped, false); stopped = true; active -= 1; stops += 1; },
      };
    },
  });
  const port = server.address().port;
  const status = async () => {
    assert.equal(server.listening, true);
    const response = await fetch(`http://127.0.0.1:${port}/api/server-status`);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.status, 'listening');
    return value;
  };
  const tick = async () => { monitor(); await new Promise((resolve) => setImmediate(resolve)); };
  const stable = (await status()).stableUrl;
  assert.ok(stable);
  assert.equal(unrefed, true);
  await tick();
  addresses = ['192.168.1.20', '10.1.2.3'];
  await tick();
  assert.equal(starts.length, 1, 'a newly preferred adapter must not cause flapping');
  assert.equal((await status()).stableUrl, stable);

  addresses = ['192.168.1.20'];
  assert.equal((await status()).stableUrl, '', 'stale URL disappears even before the monitor ticks');
  nextGate = new Promise((resolve) => { release = resolve; });
  await tick();
  await tick();
  await tick();
  assert.equal(starts.length, 2);
  assert.equal(stops, 1);
  assert.equal((await status()).primaryLanUrl, `http://192.168.1.20:${port}`);
  assert.equal((await status()).stableUrl, '');
  release();
  await tick();
  assert.equal((await status()).stableUrl, stable);

  addresses = [];
  assert.equal((await status()).stableUrl, '');
  await tick();
  await tick();
  assert.equal(active, 0);
  assert.equal(stops, 2);
  assert.equal(starts.length, 2);
  assert.deepEqual((await status()).lanUrls, []);
  addresses = ['192.168.2.30'];
  await tick();
  assert.equal((await status()).stableUrl, stable);
  assert.equal((await status()).primaryLanUrl, `http://192.168.2.30:${port}`);
  assert.equal(new Set(starts.map((entry) => entry.deviceId)).size, 1);

  addresses = ['192.168.3.40'];
  nextGate = new Promise((resolve) => { release = resolve; });
  await tick();
  const stopping = stopServer();
  await tick();
  assert.equal(cleared, true);
  assert.equal(starts.length, 4);
  release();
  await stopping;
  await tick();
  assert.equal(active, 0);
  assert.equal(stops, 4);
  assert.equal(starts.length, 4);
  assert.equal(server.listening, false);
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

  assert.equal(statusResponse.status, 200);
  assert.match(status.deviceId, DEVICE_ID_PATTERN);
  assert.match(status.hostname, /^snap-[a-f0-9]{8}\.local$/);
  assert.equal(status.stableUrl, '');
  assert.doesNotMatch(status.primaryLanUrl, /\.local(?::|$)/);
  assert.ok(status.lanUrls.length > 0);
  assert.equal(stopCalled, true);

  await stopServer();
});

test('IPv6 on the IPv4 endpoint adapter uses scoped membership and never unrelated adapters', () => {
  const interfaces = {
    unrelated: [{ address: '10.0.0.5', family: 'IPv4' }, { address: 'fe80::5', family: 'IPv6', scopeid: 5 }],
    wifi: [{ address: '192.168.1.25', family: 'IPv4' }, { address: 'fe80::7', family: 'IPv6', scopeid: 7 }],
  };
  assert.equal(getMdnsIpv6Interface('192.168.1.25', interfaces, 'win32'), '::%7');
  assert.equal(getMdnsIpv6Interface('192.168.1.25', interfaces, 'linux'), '::%wifi');
  assert.equal(getMdnsIpv6Interface('192.168.1.99', interfaces, 'win32'), '');
  interfaces.wifi[1].internal = true;
  assert.equal(getMdnsIpv6Interface('192.168.1.25', interfaces, 'win32'), '');
});

test('dual transports answer IPv6 QM, QU and the captured combined iPhone query with IPv4 A only', async () => {
  const h = await createAdvertiserFixture({ ipv6Interface: '::%7' });
  const hostname = h.status.hostname;
  const remote = { address: 'fe80::abcd%7', port: 5353 };
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(h.socketOptions, [{ type: 'udp6', reuseAddr: true, ipv6Only: true }]);
  assert.deepEqual(h.optionsByTransport[1], {
    type: 'udp6', bind: '::', ip: 'ff02::fb', interface: '::%7', socket: {},
  });
  for (const service of h.services) {
    assert.deepEqual(service.records().map(({ type }) => type), ['SRV', 'PTR', 'TXT']);
  }
  h.sockets[1].emit('query', createDecodedHostnameQuery({ hostname }), remote);
  assert.equal(h.responses.length, 2);
  assert.equal(h.responses[0].destination, null, 'QM uses this transport multicast');
  assert.deepEqual(h.responses[1].destination, remote);
  const query = createDecodedHostnameQuery({ hostname, qu: true });
  // All three questions in the captured packet requested unicast.
  for (const question of query.questions) question.class = 'UNKNOWN_32769';
  h.sockets[1].emit('query', query, remote);
  assert.equal(h.responses.length, 3);
  assert.deepEqual(h.responses[2].destination, remote, 'QU retains IPv6 scope and port');
  h.sockets[1].emit('query', { questions: [
    { name: hostname, type: 'AAAA' }, { name: hostname, type: 'UNKNOWN_65' },
    { name: 'other.local', type: 'A' },
  ] }, remote);
  assert.equal(h.responses.length, 3, 'unsupported and unrelated questions are not answered');
  for (const { packet } of h.responses) {
    assert.equal(packet.answers.length, 1);
    assert.equal(packet.answers[0].type, 'A');
    assert.equal(packet.answers[0].data, '192.168.1.25');
  }
  await Promise.all([h.advertiser.start(), h.advertiser.start()]);
  assert.equal(h.sockets.length, 2, 'unchanged/repeated starts do not duplicate sockets');
  await h.advertiser.stop();
  assert.deepEqual(h.events, ['unpublish', 'unpublish', 'destroy', 'destroy']);
  for (const socket of h.sockets) assert.equal(socket.listenerCount('query'), 0);
  await h.advertiser.stop();
  assert.equal(h.events.length, 4, 'shutdown is idempotent');
});

test('Public-network loopback mode exposes no LAN URLs and never starts mDNS', async (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({ wifi: [{
    family: 'IPv4', internal: false, address: '192.168.1.20',
  }] }));
  let starts = 0;
  const server = await startServer({
    host: '127.0.0.1',
    lanExposure: false,
    log: false,
    mdnsFactory: () => ({
      start: async () => { starts += 1; },
      stop: async () => {},
    }),
    port: 0,
  });
  t.after(() => stopServer());
  const { port } = server.address();
  const status = await fetch(`http://127.0.0.1:${port}/api/server-status`).then(
    (response) => response.json(),
  );
  assert.equal(status.bindHost, '127.0.0.1');
  assert.deepEqual(status.lanUrls, []);
  assert.equal(status.primaryLanUrl, '');
  assert.equal(status.stableUrl, '');
  assert.equal(starts, 0);
});

test('installed multicast-dns joins both groups, routes IPv6 replies and cleans memberships after a startup race', async (t) => {
  const harness = createSocketHarness();
  const advertiser = createMdnsAdvertiser({
    ...harness, deviceId: 'a1b2c3d4', getLanAddresses: () => [{ address: '192.168.1.25' }],
    getIpv6Interface: () => '::%7', logger: { log() {}, warn() {} },
  });
  t.after(() => advertiser.stop());
  const start = advertiser.start();
  assert.equal(advertiser.start(), start);
  await start;
  const [v4, v6] = harness.sockets;
  assert.deepEqual(v4.memberships, [{ group: '224.0.0.251', iface: '192.168.1.25' }]);
  assert.deepEqual(v6.bound, { port: 5353, address: '::' });
  assert.deepEqual(v6.memberships, [{ group: 'ff02::fb', iface: '::%7' }]);
  assert.equal(v6.outgoingInterface, '::%7');
  assert.equal(v6.ttl, 255);
  const hostname = 'snap-a1b2c3d4.local';
  const remote = { address: 'fe80::abcd%7', port: 5353 };
  v6.sent.length = 0;
  v6.emit('message', dnsPacket.encode(createDecodedHostnameQuery({ hostname })), remote);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(v6.sent[0].address, 'ff02::fb');
  assert.equal(v6.sent[1].address, remote.address);
  v6.emit('message', createDecodedHostnameQuery({ hostname, allQu: true, encodedResult: true }), remote);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(v6.sent[2].address, remote.address);
  for (const { packet } of v6.sent) assert.deepEqual(packet.answers.map(({ type, data }) => ({ type, data })), [{ type: 'A', data: '192.168.1.25' }]);
  v6.sent.length = 0;
  v6.emit('message', dnsPacket.encode({ type: 'query', questions: [{ name: '_http._tcp.local', type: 'PTR' }] }), remote);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(v6.sent[0].packet.answers[0].type, 'PTR');
  assert.deepEqual(v6.sent[0].packet.additionals.map(({ type }) => type).sort(), ['SRV', 'TXT']);
  await advertiser.stop();
  for (const socket of harness.sockets) {
    assert.equal(socket.closed, true);
    assert.deepEqual(socket.dropped, socket.memberships);
  }
  const restarting = advertiser.start();
  const stopping = advertiser.stop();
  await Promise.all([restarting, stopping]);
  assert.equal(harness.sockets.length, 4);
  assert.ok(harness.sockets.every((socket) => socket.closed), 'no late transport survives concurrent stop');
});

test('IPv6 startup failure closes both transports rather than leaving a partial advertiser', async () => {
  const harness = createSocketHarness({ failIpv6: true });
  const advertiser = createMdnsAdvertiser({
    ...harness, deviceId: 'a1b2c3d4', getLanAddresses: () => [{ address: '192.168.1.25' }],
    getIpv6Interface: () => '::%7', logger: { log() {}, warn() {} },
  });
  await assert.rejects(advertiser.start(), /IPv6 port unavailable/);
  await advertiser.stop();
  assert.equal(harness.sockets.length, 2);
  assert.ok(harness.sockets.every((socket) => socket.closed));
});

test('IPv6 interface changes recreate both real-library transports; unchanged refresh does not duplicate them', async (t) => {
  let scopeid = 7;
  t.mock.method(os, 'networkInterfaces', () => ({ [scopeid === 7 ? 'wifi' : 'wifi-new']: [
    { address: '192.168.1.25', family: 'IPv4', internal: false },
    { address: 'fe80::25', family: 'IPv6', internal: false, scopeid },
  ] }));
  let monitor;
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const timer = { unref() {} };
  t.mock.method(globalThis, 'setInterval', (callback, delay, ...args) => {
    if (delay !== 15_000) return originalSet(callback, delay, ...args);
    monitor = callback; return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (value) => {
    if (value !== timer) originalClear(value);
  });
  const harness = createSocketHarness();
  const server = await startServer({ host: '127.0.0.1', port: 0, log: false,
    mdnsFactory: (options) => createMdnsAdvertiser({ ...options, ...harness,
      logger: { log() {}, warn() {} },
    }),
  });
  t.after(() => stopServer());
  monitor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sockets.length, 2);
  scopeid = 8;
  monitor();
  monitor();
  const endpoint = `http://127.0.0.1:${server.address().port}/api/server-status`;
  for (let attempts = 0; attempts < 400; attempts += 1) {
    const status = await fetch(endpoint).then((response) => response.json());
    if (harness.sockets.length === 4 && status.stableUrl) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(harness.sockets.length, 4);
  assert.ok(harness.sockets.slice(0, 2).every((socket) => socket.closed));
  assert.deepEqual(harness.sockets[3].memberships, [{ group: 'ff02::fb', iface: process.platform === 'win32' ? '::%8' : '::%wifi-new' }]);
  monitor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sockets.length, 4);
  await stopServer();
  assert.ok(harness.sockets.every((socket) => socket.closed));
});
