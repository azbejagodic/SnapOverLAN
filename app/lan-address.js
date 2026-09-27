// Shared by network discovery and the desktop: phone LAN access requires RFC1918 IPv4.
const isPrivateIpv4 = (address) => {
  if (typeof address !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
  const octets = address.split('.').map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
};

const isPrivateLanUrl = (value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && isPrivateIpv4(url.hostname);
  } catch { return false; }
};

export { isPrivateIpv4, isPrivateLanUrl };
