import { Bonjour } from 'bonjour-service';
import dgram from 'node:dgram';
import os from 'node:os';
import { PORT } from './config.js';
import { formatDeviceHostname, formatStableUrl } from './device-identity.js';
import { getLanIpv4Addresses, getPreferredLanIpv4Address } from './lan.js';

const MDNS_SHUTDOWN_TIMEOUT_MS = 500;
const MDNS_STARTUP_TIMEOUT_MS = 3000;
const MDNS_MULTICAST_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const QU_MASK = 0x8000;
const DNS_CLASS_NAMES = new Map([
  [1, 'IN'],
  [2, 'CS'],
  [3, 'CH'],
  [4, 'HS'],
  [255, 'ANY'],
]);

// Join only the adapter owning the IPv4 HTTP endpoint, never unrelated adapters.
const getMdnsIpv6Interface = (ipv4Address, interfaces = os.networkInterfaces(), platform = process.platform) => {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses?.some((entry) => !entry.internal && entry.address === ipv4Address)) continue;
    const ipv6 = addresses.find((entry) => !entry.internal
      && (entry.family === 'IPv6' || entry.family === 6)
      && /^fe80:/i.test(entry.address));
    if (!ipv6) return '';
    const scope = platform === 'win32' ? ipv6.scopeid : name;
    return scope ? `::%${scope}` : '';
  }
  return '';
};

const removeBonjourHostAddressRecords = (service) => {
  if (typeof service?.records !== 'function') return;
  const getDefaultRecords = service.records.bind(service);
  service.records = () => getDefaultRecords().filter((record) => (
    record.type !== 'A' && record.type !== 'AAAA'
  ));
};

const createMdnsDebugLogger = ({ enabled, logger }) => (
  enabled ? (message) => logger.log(message) : () => {}
);

const getQuestionClassDetails = (question) => {
  const rawClass = question?.class ?? 'IN';
  let rawClassCode = null;
  if (Number.isInteger(rawClass)) {
    rawClassCode = rawClass;
  } else {
    const normalizedRawClass = String(rawClass).toUpperCase();
    const knownClass = [...DNS_CLASS_NAMES.entries()].find(([, name]) => name === normalizedRawClass);
    if (knownClass) rawClassCode = knownClass[0];
    else if (/^UNKNOWN_\d+$/.test(normalizedRawClass)) {
      rawClassCode = Number(normalizedRawClass.slice('UNKNOWN_'.length));
    }
  }

  const qu = Boolean(
    question?.qu
    || question?.unicastResponse
    || (Number.isInteger(rawClassCode) && (rawClassCode & QU_MASK) !== 0),
  );
  const decodedClassCode = Number.isInteger(rawClassCode)
    ? rawClassCode & ~QU_MASK
    : null;
  return {
    decodedClass: DNS_CLASS_NAMES.get(decodedClassCode) || String(rawClass),
    decodedClassCode,
    qu,
    rawClass,
    rawClassCode,
  };
};

const createHostnameResponder = ({
  debugLog = () => {},
  hostname,
  ipv4Address,
  logger,
  mdnsSocket,
  multicastAddress = MDNS_MULTICAST_ADDRESS,
}) => {
  const answer = {
    name: hostname,
    type: 'A',
    class: 'IN',
    flush: true,
    ttl: 120,
    data: ipv4Address,
  };

  const sendAnswer = ({ mode, remote }) => {
    const direct = mode === 'unicast' || mode === 'compat-unicast';
    const destination = direct
      ? { address: remote.address, port: remote.port }
      : { address: multicastAddress, port: MDNS_PORT };
    const onSent = (error) => {
      const message = `SnapOverLAN mDNS A answer: hostname=${hostname} ipv4=${ipv4Address} `
        + `destination=${destination.address}:${destination.port} mode=${mode} `
        + `result=${error ? 'error' : 'success'}`;
      if (error) logger.warn(`${message} error=${error.message || error}`);
      else debugLog(message);
    };

    try {
      if (direct) mdnsSocket.respond({ answers: [answer] }, destination, onSent);
      else mdnsSocket.respond({ answers: [answer] }, onSent);
    } catch (error) {
      onSent(error);
    }
  };

  const handleQuery = (packet, remote = {}) => {
    const hasValidRemote = typeof remote.address === 'string'
      && remote.address.length > 0
      && Number.isInteger(remote.port)
      && remote.port > 0
      && remote.port <= 65535;
    let shouldSendMulticast = false;
    let shouldSendUnicast = false;
    for (const question of packet.questions || []) {
      if (String(question.name).toLowerCase().replace(/\.$/, '') !== hostname) continue;
      const classDetails = getQuestionClassDetails(question);
      debugLog(
        `SnapOverLAN mDNS query: hostname=${hostname} source=${remote.address || 'unknown'}:`
        + `${remote.port || 'unknown'} qtype=${question.type} rawQclass=${classDetails.rawClass} `
        + `qclassCode=${classDetails.rawClassCode ?? 'unknown'} `
        + `decodedQclass=${classDetails.decodedClass} QU=${classDetails.qu}`,
      );

      const supportedClass = classDetails.decodedClass === 'IN'
        || classDetails.decodedClass === 'ANY';
      if (!supportedClass || (question.type !== 'A' && question.type !== 'ANY')) continue;
      if (classDetails.qu) shouldSendUnicast = true;
      else shouldSendMulticast = true;
    }

    if (shouldSendUnicast && hasValidRemote) {
      sendAnswer({ mode: 'unicast', remote });
    }
    if (shouldSendMulticast) {
      sendAnswer({ mode: 'multicast', remote });
      // Some LAN/Wi-Fi configurations deliver client mDNS queries to the PC but
      // do not reliably deliver multicast responses back to the client.
      if (!shouldSendUnicast && hasValidRemote) {
        sendAnswer({ mode: 'compat-unicast', remote });
      }
    }
  };

  mdnsSocket.on('query', handleQuery);
  return () => mdnsSocket.removeListener('query', handleQuery);
};

const waitForServiceUp = (service, timeoutMs) => new Promise((resolve, reject) => {
  let settled = false;
  const cleanup = () => {
    clearTimeout(timeout);
    service.removeListener?.('up', handleUp);
    service.removeListener?.('error', handleError);
  };
  const handleUp = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  };
  const handleError = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const timeout = setTimeout(() => {
    handleError(new Error(`mDNS advertisement did not start within ${timeoutMs}ms.`));
  }, timeoutMs);
  service.once?.('up', handleUp);
  service.once?.('error', handleError);
});

const waitForCallback = (invoke) => new Promise((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve();
  };
  const timeout = setTimeout(finish, MDNS_SHUTDOWN_TIMEOUT_MS);
  try { invoke(finish); } catch { finish(); }
});

const createMdnsAdvertiser = ({
  BonjourClass = Bonjour,
  debug = process.env.SNAPOVERLAN_DEBUG_MDNS === '1',
  deviceId,
  getLanAddresses = getLanIpv4Addresses,
  getIpv6Interface = getMdnsIpv6Interface,
  socketFactory = (options) => dgram.createSocket(options),
  logger = console,
  port = PORT,
  startupTimeoutMs = MDNS_STARTUP_TIMEOUT_MS,
} = {}) => {
  const debugLog = createMdnsDebugLogger({ enabled: debug, logger });
  const transports = [];
  let starting = null;
  let stopping = null;
  let status = null;

  const stopTransports = async () => {
    const activeTransports = transports.splice(0);
    status = null;
    for (const { bonjour, detach } of activeTransports) detach();
    await Promise.all(activeTransports.map(async ({ bonjour }) => {
      await waitForCallback((done) => bonjour.unpublishAll(done));
      await waitForCallback((done) => bonjour.destroy(done));
    }));
  };

  const startTransports = async () => {
    if (status?.started) return status;
    const hostname = formatDeviceHostname(deviceId);
    const ipv4Address = getPreferredLanIpv4Address(getLanAddresses());
    if (!ipv4Address) throw new Error('No active LAN IPv4 address is available for mDNS.');

    const ipv6Interface = getIpv6Interface(ipv4Address);
    const startTransport = async (options, multicastAddress) => {
      let bonjour;
      try {
        bonjour = new BonjourClass(options, (error) => logger.warn('SnapOverLAN mDNS error:', error));
      } catch (error) {
        try { options.socket?.close(); } catch {}
        throw error;
      }
      const transport = { bonjour, detach: () => {} };
      transports.push(transport);
      const mdnsSocket = bonjour.server?.mdns;
      if (!mdnsSocket?.on || !mdnsSocket?.respond) {
        throw new Error('Bonjour did not expose its multicast-dns socket.');
      }
      transport.detach = createHostnameResponder({
        debugLog, hostname, ipv4Address, logger, mdnsSocket, multicastAddress,
      });
      let service;
      // Bonjour does not attach socket error listeners itself.
      mdnsSocket.on('error', (error) => service?.emit('error', error));
      mdnsSocket.on('warning', (error) => {
        logger.warn('SnapOverLAN mDNS socket warning:', error);
        // A failed membership must not be reported as a working advertisement.
        if (!transport.started) service?.emit('error', error);
      });
      service = bonjour.publish({
        disableIPv6: true,
        host: hostname,
        name: `SnapOverLAN ${deviceId}`,
        port,
        protocol: 'tcp',
        type: 'http',
        txt: { application: 'SnapOverLAN', deviceId, protocolVersion: '1' },
      });
      // Only the explicit responder owns host A records, on both transports.
      removeBonjourHostAddressRecords(service);
      service.on?.('error', (error) => logger.warn('SnapOverLAN mDNS publish error:', error));
      await waitForServiceUp(service, startupTimeoutMs);
      transport.started = true;
    };

    try {
      await startTransport({
        bind: '0.0.0.0',
        interface: ipv4Address,
      }, MDNS_MULTICAST_ADDRESS);
      if (ipv6Interface) {
        await startTransport({
          type: 'udp6', bind: '::', ip: 'ff02::fb', interface: ipv6Interface,
          socket: socketFactory({ type: 'udp6', reuseAddr: true, ipv6Only: true }),
        }, 'ff02::fb');
      }
    } catch (error) {
      logger.warn(
        `SnapOverLAN mDNS advertisement: started=false hostname=${hostname} `
        + `ipv4=${ipv4Address} port=${port}`,
      );
      await stopTransports();
      throw error;
    }

    status = {
      deviceId,
      hostname,
      ipv4Addresses: [ipv4Address],
      ipv6Interface,
      port,
      stableUrl: formatStableUrl(deviceId, port),
      started: true,
    };
    logger.log(`SnapOverLAN mDNS ready: ${hostname} -> ${ipv4Address}`);
    return status;
  };

  const start = () => {
    if (stopping) return stopping.then(start);
    if (!starting) starting = startTransports().finally(() => { starting = null; });
    return starting;
  };
  const stop = () => {
    if (!stopping) stopping = (async () => {
      // Drain an in-flight start before closing, so it cannot create a late socket.
      await starting?.catch(() => {});
      await stopTransports();
    })().finally(() => { stopping = null; });
    return stopping;
  };
  return { start, stop };
};

export {
  createMdnsAdvertiser,
  getMdnsIpv6Interface,
};
