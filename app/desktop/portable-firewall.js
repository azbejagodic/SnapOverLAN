import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const TCP_RULE = 'SnapOverLAN Portable LAN Upload';
const MDNS_RULE = 'SnapOverLAN Portable mDNS';
const READY_TIMEOUT_MS = 60_000;

const quotePowerShell = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const isPortableWindowsRuntime = ({
  env = process.env,
  isPackaged = false,
  platform = process.platform,
} = {}) => (
  platform === 'win32'
  && isPackaged
  && Boolean(env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR)
);

export const createPortableFirewallScript = ({ executablePath, processId, statusPath, cleanupLogPath }) => {
  const tcpRule = quotePowerShell(TCP_RULE);
  const mdnsRule = quotePowerShell(MDNS_RULE);
  const sourceProgram = quotePowerShell(executablePath);
  const status = quotePowerShell(statusPath);
  const cleanupLog = quotePowerShell(cleanupLogPath);

  return [
    "$ErrorActionPreference = 'Stop'",
    `$tcpRule = ${tcpRule}`,
    `$mdnsRule = ${mdnsRule}`,
    `$cleanupLog = ${cleanupLog}`,
    '$writeCleanupDiagnostic = {',
    '  param([string]$message)',
    '  try { Add-Content -LiteralPath $cleanupLog -Value "$(Get-Date -Format o) $message" -Encoding UTF8 -ErrorAction Stop } catch {}',
    '}',
    '$getRules = {',
    '  param([string]$ruleName)',
    '  try {',
    '    return @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction Stop)',
    '  } catch {',
    "    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_DisplayName,Get-NetFirewallRule*') { return @() }",
    '    throw',
    '  }',
    '}',
    '$removeRules = {',
    '  param([string]$phase)',
    '  $failures = @()',
    '  foreach ($ruleName in @($tcpRule, $mdnsRule)) {',
    '    try {',
    '      $matches = @(& $getRules $ruleName)',
    '      if ($matches.Count -eq 0) { continue }',
    '      Remove-NetFirewallRule -DisplayName $ruleName -Confirm:$false -ErrorAction Stop',
    '      if (@(& $getRules $ruleName).Count -ne 0) { throw "Rule remains after deletion: $ruleName" }',
    '    } catch {',
    '      $failures += "${ruleName}: $($_.Exception.Message)"',
    '    }',
    '  }',
    '  if ($failures.Count -ne 0) { throw "Firewall rule cleanup ($phase) failed: $($failures -join \'; \')" }',
    '}',
    'try {',
    "  Add-Type -TypeDefinition @'",
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public static class SnapOverLANPath {',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetLongPathNameW")]',
    '  public static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint bufferLength);',
    '}',
    "'@",
    `  $sourceProgram = ${sourceProgram}`,
    '  $programBuffer = New-Object System.Text.StringBuilder 260',
    '  $programLength = [SnapOverLANPath]::GetLongPathName($sourceProgram, $programBuffer, [uint32]$programBuffer.Capacity)',
    '  if ($programLength -ge $programBuffer.Capacity) {',
    '    $programBuffer = New-Object System.Text.StringBuilder -ArgumentList ([int]$programLength + 1)',
    '    $programLength = [SnapOverLANPath]::GetLongPathName($sourceProgram, $programBuffer, [uint32]$programBuffer.Capacity)',
    '  }',
    "  if ($programLength -eq 0 -or $programLength -ge $programBuffer.Capacity) { throw 'Could not resolve the portable executable long path.' }",
    '  $program = $programBuffer.ToString()',
    "  & $removeRules 'startup'",
    "  New-NetFirewallRule -DisplayName $tcpRule -Description 'allow phones on the same private LAN to reach portable SnapOverLAN on port 8787' -Direction Inbound -Action Allow -Enabled True -Profile Private -Protocol TCP -LocalPort 8787 -RemoteAddress LocalSubnet -Program $program | Out-Null",
    "  New-NetFirewallRule -DisplayName $mdnsRule -Description 'allow local devices to discover portable SnapOverLAN over mDNS' -Direction Inbound -Action Allow -Enabled True -Profile Private -Protocol UDP -LocalPort 5353 -RemoteAddress LocalSubnet -Program $program | Out-Null",
    `  Set-Content -LiteralPath ${status} -Value 'ready' -Encoding Ascii`,
    `  Wait-Process -Id ${processId} -ErrorAction Stop`,
    '} catch {',
    "  & $writeCleanupDiagnostic \"portable firewall setup failed: $($_.Exception.Message)\"",
    `  Set-Content -LiteralPath ${status} -Value 'failed' -Encoding Ascii -ErrorAction SilentlyContinue`,
    '} finally {',
    '  try {',
    "    & $removeRules 'exit'",
    '  } catch {',
    "    & $writeCleanupDiagnostic \"portable firewall exit cleanup failed: $($_.Exception.Message)\"",
    '  }',
    '}',
  ].join('\r\n');
};

const waitForStatus = ({ child, fsApi, statusPath, timeoutMs }) => new Promise((resolve) => {
  let settled = false;
  let interval;
  let timeout;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearInterval(interval);
    clearTimeout(timeout);
    resolve(result);
  };

  const inspect = async () => {
    try {
      const status = (await fsApi.readFile(statusPath, 'utf8')).trim();
      finish(status === 'ready');
    } catch (error) {
      if (error?.code !== 'ENOENT') finish(false);
    }
  };

  child.once('error', () => finish(false));
  child.once('exit', (code) => {
    if (code !== 0) finish(false);
  });
  interval = setInterval(() => { void inspect(); }, 100);
  timeout = setTimeout(() => finish(false), timeoutMs);
  void inspect();
});

export async function configurePortableFirewall({
  electronApp,
  env = process.env,
  executablePath = process.execPath,
  fsApi = fs,
  platform = process.platform,
  processId = process.pid,
  spawnImpl = spawn,
  timeoutMs = READY_TIMEOUT_MS,
} = {}) {
  if (!isPortableWindowsRuntime({ env, isPackaged: electronApp?.isPackaged, platform })) {
    return Object.freeze({ configured: false, reason: 'not-portable-windows' });
  }

  const statusPath = path.join(electronApp.getPath('temp'), `snapoverlan-firewall-${randomUUID()}.status`);
  const cleanupLogPath = path.join(electronApp.getPath('userData'), 'portable-firewall.log');
  const script = createPortableFirewallScript({ executablePath, processId, statusPath, cleanupLogPath });
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const elevateCommand = [
    'Start-Process',
    "-FilePath 'powershell.exe'",
    `-ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encodedScript}')`,
    '-Verb RunAs',
  ].join(' ');

  let child;
  try {
    child = spawnImpl('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      elevateCommand,
    ], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    return Object.freeze({ configured: false, reason: 'configuration-failed' });
  }
  child.unref?.();

  const configured = await waitForStatus({ child, fsApi, statusPath, timeoutMs });
  await fsApi.rm(statusPath, { force: true }).catch(() => {});
  return Object.freeze({ configured, reason: configured ? 'configured' : 'configuration-failed' });
}

export const PORTABLE_FIREWALL_RULES = Object.freeze({ tcp: TCP_RULE, mdns: MDNS_RULE });
