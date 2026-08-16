import { Bonjour } from 'bonjour-service';
import { PORT } from './config.js';
import { formatDeviceHostname, formatStableUrl } from './device-identity.js';
import { getLanIpv4Addresses, getPreferredLanIpv4Address } from './lan.js';

const MDNS_SHUTDOWN_TIMEOUT_MS = 500;
const MDNS_STARTUP_TIMEOUT_MS = 3000;

const restrictServiceRecords = (service, ipv4Address) => {
  if (typeof service?.records !== 'function') return;
  const getDefaultRecords = service.records.bind(service);
  service.records = () => getDefaultRecords().filter((record) => (
    record.type !== 'AAAA'
    && (record.type !== 'A' || record.data === ipv4Address)
  ));
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
    const handleQuery = (packet, remote) => {
      const matchingQuestions = (packet.questions || []).filter(
        (question) => String(question.name).toLowerCase() === hostname,
      );
      if (matchingQuestions.length === 0) return;
      logger.log(
        `SnapOverLAN mDNS query: hostname=${hostname} source=${remote.address}:${remote.port} `
        + `types=${matchingQuestions.map((question) => question.type).join(',')}`,
      );
    };
    mdnsSocket?.on?.('query', handleQuery);
    detachQueryLogger = () => mdnsSocket?.removeListener?.('query', handleQuery);

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
    // bonjour-service otherwise creates host records for every OS interface.
    restrictServiceRecords(service, ipv4Address);
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

export { createMdnsAdvertiser, restrictServiceRecords };
