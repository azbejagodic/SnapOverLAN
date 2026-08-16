import os from 'os';
import { PORT } from './config.js';

const isPrivateIpv4 = (address) => (
  address.startsWith('10.') ||
  address.startsWith('192.168.') ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
);

const getIpv4Rank = (address) => {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 2;
  if (address.startsWith('169.254.')) return 4;
  return 3;
};

const getLanIpv4Addresses = () => {
  const seen = new Set();
  const addresses = [];

  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const details of interfaces || []) {
      if (details.family !== 'IPv4' || details.internal || seen.has(details.address)) {
        continue;
      }

      seen.add(details.address);
      addresses.push({
        address: details.address,
        private: isPrivateIpv4(details.address),
      });
    }
  }

  return addresses.sort((a, b) => (
    getIpv4Rank(a.address) - getIpv4Rank(b.address) ||
    a.address.localeCompare(b.address)
  ));
};

const getPreferredLanIpv4Address = (addresses = getLanIpv4Addresses()) => {
  const usableAddresses = addresses.filter(({ address }) => !address.startsWith('169.254.'));
  return usableAddresses.find(({ private: isPrivate }) => isPrivate)?.address
    || usableAddresses[0]?.address
    || '';
};

const getPhoneUrlRecords = ({
  addresses = getLanIpv4Addresses(),
  port = PORT,
} = {}) => addresses.map(({ address, private: isPrivate }) => ({
  address,
  private: isPrivate,
  url: `http://${address}:${port}`,
}));

export { getLanIpv4Addresses, getPhoneUrlRecords, getPreferredLanIpv4Address };
