import { execFile } from 'node:child_process';
import { isPrivateIpv4 } from '../lan-address.js';

export const createWindowsNetworkProfileScript = (address) => {
  if (!isPrivateIpv4(address)) throw new TypeError('Expected a LAN IPv4 address.');
  // Resolve the advertised LAN address to its adapter, rather than inspecting
  // an unrelated default route (for example, a VPN or second network adapter).
  return [
    "$ErrorActionPreference = 'Stop'",
    `$addresses = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress '${address}' -ErrorAction Stop)`,
    '$profiles = @($addresses | ForEach-Object { Get-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -ErrorAction Stop })',
    "@($profiles | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } | ForEach-Object {",
    '  $profile = $_',
    '  $medium = $null',
    '  try { $medium = [int](Get-NetAdapter -InterfaceIndex $profile.InterfaceIndex -IncludeHidden -ErrorAction Stop).NdisPhysicalMedium } catch {}',
    '  [pscustomobject]@{ NetworkCategory = [string]$profile.NetworkCategory; NdisPhysicalMedium = $medium }',
    '}) | ConvertTo-Json -Compress',
  ].join('\r\n');
};

export async function getWindowsNetworkProfile(address, {
  platform = process.platform,
  execFileImpl = execFile,
  onAdapterDetected = () => {},
} = {}) {
  const script = createWindowsNetworkProfileScript(address);
  onAdapterDetected(null);
  if (platform !== 'win32') return null;
  try {
    const output = await new Promise((resolve, reject) => {
      execFileImpl('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ], { windowsHide: true, timeout: 4000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    const parsed = JSON.parse(output.trim());
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const profiles = records.map((record) => typeof record === 'string' ? record : record?.NetworkCategory);
    const unique = [...new Set(profiles)];
    const adapterTypes = [...new Set(records.map((record) => {
      // NDIS physical media: 802.3 = 14; Wireless LAN = 1; Native 802.11 = 9.
      if (record?.NdisPhysicalMedium === 14) return 'ethernet';
      if ([1, 9].includes(record?.NdisPhysicalMedium)) return 'wifi';
      return null;
    }))];
    if (unique.length === 1 && ['Public', 'Private', 'DomainAuthenticated'].includes(unique[0])) {
      onAdapterDetected(adapterTypes.length === 1 ? adapterTypes[0] : null);
    }
    // Missing, ambiguous, or unrecognized results must not claim access is blocked.
    return unique.length === 1 && ['Public', 'Private', 'DomainAuthenticated'].includes(unique[0])
      ? unique[0] : null;
  } catch {
    return null;
  }
}

export async function openWindowsNetworkSettings({ shell, adapterType = null, platform = process.platform }) {
  if (platform !== 'win32') return false;
  try {
    const settingsUri = adapterType === 'ethernet' ? 'ms-settings:network-ethernet'
      : adapterType === 'wifi' ? 'ms-settings:network-wifi' : 'ms-settings:network-status';
    await shell.openExternal(settingsUri);
    return true;
  } catch {
    return false;
  }
}
