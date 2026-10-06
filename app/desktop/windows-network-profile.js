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
    '  $adapter = $null; $ssid = $null',
    '  try { $adapter = Get-NetAdapter -InterfaceIndex $profile.InterfaceIndex -IncludeHidden -ErrorAction Stop; $medium = [int]$adapter.NdisPhysicalMedium } catch {}',
    '  if ($medium -in @(1, 9)) {',
    '    try {',
    '      $connections = @([Windows.Networking.Connectivity.NetworkInformation, Windows, ContentType=WindowsRuntime]::GetConnectionProfiles() | Where-Object { $_.IsWlanConnectionProfile -and $_.NetworkAdapter.NetworkAdapterId -eq [guid]$adapter.InterfaceGuid })',
    '      if ($connections.Count -eq 1) { $ssid = $connections[0].WlanConnectionProfileDetails.GetConnectedSsid() }',
    '    } catch {}',
    '  }',
    '  [pscustomobject]@{ NetworkCategory = [string]$profile.NetworkCategory; NdisPhysicalMedium = $medium; Ssid = $ssid }',
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
      const adapterType = adapterTypes.length === 1 ? adapterTypes[0] : null;
      const ssid = adapterType === 'wifi' && records.length === 1
        && typeof records[0]?.Ssid === 'string' && records[0].Ssid.trim()
        ? records[0].Ssid : null;
      onAdapterDetected(adapterType, { ssid });
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
