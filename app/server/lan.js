import os from 'os';
import { PORT } from './config.js';
import { isPrivateIpv4 } from '../lan-address.js';

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
      if (details.family !== 'IPv4' || details.internal || !isPrivateIpv4(details.address) || seen.has(details.address)) {
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
  return addresses.find(({ address }) => isPrivateIpv4(address))?.address || '';
};

const getPhoneUrlRecords = ({
  addresses = getLanIpv4Addresses(),
  port = PORT,
} = {}) => addresses.filter(({ address }) => isPrivateIpv4(address)).map(({ address }) => ({
  address,
  private: true,
  url: `http://${address}:${port}`,
}));

export { getLanIpv4Addresses, getPhoneUrlRecords, getPreferredLanIpv4Address };
