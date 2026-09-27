import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import { isPrivateIpv4 } from '../app/lan-address.js';
import { getLanIpv4Addresses, getPhoneUrlRecords, getPreferredLanIpv4Address } from '../app/server/lan.js';

test('LAN rule accepts exactly valid RFC1918 IPv4 ranges', () => {
  for (const address of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
    assert.equal(isPrivateIpv4(address), true, address);
  }
  for (const address of ['26.10.20.30', '127.0.0.1', '169.254.1.2', '172.15.1.2', '172.32.1.2',
    '192.169.1.2', '8.8.8.8', '::1', '10.999.1.2', '10.1.2', 'localhost', undefined]) {
    assert.equal(isPrivateIpv4(address), false, String(address));
  }
});

test('discovery preserves Ethernet/Wi-Fi private addresses and excludes Radmin, link-local, and loopback', (t) => {
  const adapter = (address, internal = false) => [{ address, internal, family: 'IPv4' }];
  t.mock.method(os, 'networkInterfaces', () => ({
    Ethernet: adapter('192.168.1.25'), WiFi: adapter('10.0.0.25'),
    PrivateLAN: adapter('172.20.1.25'), Radmin: adapter('26.10.20.30'),
    Disconnected: adapter('169.254.1.2'), Loopback: adapter('127.0.0.1', true),
  }));
  assert.deepEqual(getLanIpv4Addresses().map(({ address }) => address), ['192.168.1.25', '10.0.0.25', '172.20.1.25']);
  assert.equal(getPhoneUrlRecords().length, 3);
});

test('VPN-only discovery and explicit address lists have no arbitrary public-address fallback', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({
    Radmin: [{ address: '26.10.20.30', family: 'IPv4', internal: false }],
  }));
  assert.deepEqual(getLanIpv4Addresses(), []);
  assert.deepEqual(getPhoneUrlRecords(), []);
  assert.equal(getPreferredLanIpv4Address(), '');
  const addresses = [{ address: '26.10.20.30', private: true }, { address: '169.254.1.2', private: true }];
  assert.deepEqual(getPhoneUrlRecords({ addresses }), []);
  assert.equal(getPreferredLanIpv4Address(addresses), '');
  addresses.push({ address: '10.1.2.3', private: false });
  assert.equal(getPreferredLanIpv4Address(addresses), '10.1.2.3');
  assert.deepEqual(getPhoneUrlRecords({ addresses, port: 8787 }), [
    { address: '10.1.2.3', private: true, url: 'http://10.1.2.3:8787' },
  ]);
});
