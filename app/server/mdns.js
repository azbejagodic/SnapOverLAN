import { Bonjour } from 'bonjour-service';
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

const removeBonjourHostAddressRecords = (service) => {
  if (typeof service?.records !== 'function') return;
  const getDefaultRecords = service.records.bind(service);
  service.records = () => getDefaultRecords().filter((record) => (
    record.type !== 'A' && record.type !== 'AAAA'
  ));
};

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
  hostname,
  ipv4Address,
  logger,
  mdnsSocket,
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
      : { address: MDNS_MULTICAST_ADDRESS, port: MDNS_PORT };
    const onSent = (error) => {
      const message = `SnapOverLAN mDNS A answer: hostname=${hostname} ipv4=${ipv4Address} `
        + `destination=${destination.address}:${destination.port} mode=${mode} `
        + `result=${error ? 'error' : 'success'}`;
      if (error) logger.warn(`${message} error=${error.message || error}`);
      else logger.log(message);
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
      if (String(question.name).toLowerCase() !== hostname) continue;
      const classDetails = getQuestionClassDetails(question);
      logger.log(
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
  deviceId,
  getLanAddresses = getLanIpv4Addresses,
  logger = console,
  port = PORT,
  startupTimeoutMs = MDNS_STARTUP_TIMEOUT_MS,
} = {}) => {
  let bonjour = null;
  let detachQueryLogger = () => {};
  let status = null;

  const stop = async () => {
    const activeBonjour = bonjour;
    bonjour = null;
    status = null;
    detachQueryLogger();
    detachQueryLogger = () => {};
    if (!activeBonjour) return;
    await waitForCallback((done) => activeBonjour.unpublishAll(done));
    await waitForCallback((done) => activeBonjour.destroy(done));
  };

  const start = async () => {
    if (status?.started) return status;
    const hostname = formatDeviceHostname(deviceId);
    const ipv4Address = getPreferredLanIpv4Address(getLanAddresses());
    if (!ipv4Address) throw new Error('No active LAN IPv4 address is available for mDNS.');

    bonjour = new BonjourClass({
      bind: '0.0.0.0',
      interface: ipv4Address,
    }, (error) => logger.warn('SnapOverLAN mDNS error:', error));
    const mdnsSocket = bonjour.server?.mdns;
    if (!mdnsSocket?.on || !mdnsSocket?.respond) {
      await stop();
      throw new Error('Bonjour did not expose its multicast-dns socket.');
    }
    detachQueryLogger = createHostnameResponder({
      hostname,
      ipv4Address,
      logger,
      mdnsSocket,
    });

    const service = bonjour.publish({
      disableIPv6: true,
      host: hostname,
      name: `SnapOverLAN ${deviceId}`,
      port,
      protocol: 'tcp',
      type: 'http',
      txt: {
        application: 'SnapOverLAN',
        deviceId,
        protocolVersion: '1',
      },
    });
    // The explicit responder owns hostname A answers. Bonjour remains responsible
    // for PTR/SRV/TXT service discovery and must not register competing A/AAAA data.
    removeBonjourHostAddressRecords(service);
    service.on?.('error', (error) => logger.warn('SnapOverLAN mDNS publish error:', error));

    try {
      await waitForServiceUp(service, startupTimeoutMs);
    } catch (error) {
      logger.warn(
        `SnapOverLAN mDNS advertisement: started=false hostname=${hostname} `
        + `ipv4=${ipv4Address} port=${port}`,
      );
      await stop();
      throw error;
    }

    status = {
      deviceId,
      hostname,
      ipv4Addresses: [ipv4Address],
      port,
      stableUrl: formatStableUrl(deviceId, port),
      started: true,
    };
    logger.log(
      `SnapOverLAN mDNS advertisement: started=true hostname=${hostname} `
      + `ipv4=${ipv4Address} port=${port}`,
    );
    return status;
  };

  return { start, stop };
};

export {
  createHostnameResponder,
  createMdnsAdvertiser,
  getQuestionClassDetails,
  removeBonjourHostAddressRecords,
};
