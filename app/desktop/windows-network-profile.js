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
    "@($profiles | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } | ForEach-Object { [string]$_.NetworkCategory }) | ConvertTo-Json -Compress",
  ].join('\r\n');
};

export async function getWindowsNetworkProfile(address, {
  platform = process.platform,
  execFileImpl = execFile,
} = {}) {
  const script = createWindowsNetworkProfileScript(address);
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
    const profiles = Array.isArray(parsed) ? parsed : [parsed];
    const unique = [...new Set(profiles)];
    // Missing, ambiguous, or unrecognized results must not claim access is blocked.
    return unique.length === 1 && ['Public', 'Private', 'DomainAuthenticated'].includes(unique[0])
      ? unique[0] : null;
  } catch {
    return null;
  }
}

export async function openWindowsNetworkSettings({ shell, platform = process.platform }) {
  if (platform !== 'win32') return false;
  try {
    await shell.openExternal('ms-settings:network-status');
    return true;
  } catch {
    return false;
  }
}
