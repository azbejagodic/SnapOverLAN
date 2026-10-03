import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  configurePortableFirewall,
  createPortableFirewallScript,
  isPortableWindowsRuntime,
  PORTABLE_FIREWALL_RULES,
} from '../app/desktop/portable-firewall.js';

test('portable firewall activation is limited to packaged Windows portable builds', () => {
  const portableEnv = { PORTABLE_EXECUTABLE_FILE: 'C:\\Tools\\SnapOverLAN.exe' };
  assert.equal(isPortableWindowsRuntime({ env: portableEnv, isPackaged: true, platform: 'win32' }), true);
  assert.equal(isPortableWindowsRuntime({ env: {}, isPackaged: true, platform: 'win32' }), false);
  assert.equal(isPortableWindowsRuntime({ env: portableEnv, isPackaged: false, platform: 'win32' }), false);
  assert.equal(isPortableWindowsRuntime({ env: portableEnv, isPackaged: true, platform: 'linux' }), false);
});

test('portable rules remain program-bound, private-profile, and local-subnet only', () => {
  const script = createPortableFirewallScript({
    executablePath: "C:\\Temp\\Snap's App\\SnapOverLAN.exe",
    processId: 4242,
    statusPath: 'C:\\Temp\\firewall.status',
    cleanupLogPath: 'C:\\Temp\\portable-firewall.log',
  });

  for (const rule of Object.values(PORTABLE_FIREWALL_RULES)) assert.match(script, new RegExp(rule));
  assert.match(script, /-Protocol TCP -LocalPort 8787 -RemoteAddress LocalSubnet -Program \$program/);
  assert.match(script, /-Protocol UDP -LocalPort 5353 -RemoteAddress LocalSubnet -Program \$program/);
  assert.equal((script.match(/-Profile Private/g) || []).length, 2);
  assert.doesNotMatch(script, /Profile (?:Public|Any)|RemoteAddress Any/);
  assert.match(script, /Wait-Process -Id 4242 -ErrorAction Stop/);
  assert.match(script, /Remove-NetFirewallRule -DisplayName \$ruleName -Confirm:\$false -ErrorAction Stop/);
  assert.doesNotMatch(script, /(?:Get|Remove)-NetFirewallRule[^\r\n]*SilentlyContinue/);
  assert.match(script, /finally \{\r\n  try \{\r\n    & \$removeRules 'exit'/);
  assert.ok(script.indexOf("& $removeRules 'startup'") < script.indexOf('New-NetFirewallRule'));
});

test('portable cleanup removes each existing rule, verifies deletion, and logs exit failures', () => {
  const script = createPortableFirewallScript({
    executablePath: 'C:\\Temp\\SnapOverLAN.exe',
    processId: 4242,
    statusPath: 'C:\\Temp\\firewall.status',
    cleanupLogPath: 'C:\\Users\\Ažbe\\AppData\\Roaming\\SnapOverLAN\\portable-firewall.log',
  });

  assert.match(script, /foreach \(\$ruleName in @\(\$tcpRule, \$mdnsRule\)\)/);
  assert.match(script, /CmdletizationQuery_NotFound_DisplayName,Get-NetFirewallRule\*/);
  assert.match(script, /if \(\$_\.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_DisplayName,Get-NetFirewallRule\*'\) \{ return @\(\) \}/);
  assert.match(script, /\$matches = @\(& \$getRules \$ruleName\)/);
  assert.match(script, /if \(\$matches\.Count -eq 0\) \{ continue \}/);
  assert.match(script, /if \(@\(& \$getRules \$ruleName\)\.Count -ne 0\) \{ throw "Rule remains after deletion: \$ruleName" \}/);
  assert.match(script, /Rule remains after deletion: \$ruleName/);
  assert.match(script, /portable firewall exit cleanup failed:/);
  assert.match(script, /Add-Content -LiteralPath \$cleanupLog/);
  assert.match(script, /\$cleanupLog = 'C:\\Users\\Ažbe\\AppData\\Roaming\\SnapOverLAN\\portable-firewall\.log'/);
});

test('portable cleanup treats only the expected missing-rule query as an absent rule', () => {
  const script = createPortableFirewallScript({
    executablePath: 'C:\\Temp\\SnapOverLAN.exe',
    processId: 4242,
    statusPath: 'C:\\Temp\\firewall.status',
    cleanupLogPath: 'C:\\Temp\\portable-firewall.log',
  });

  assert.match(script, /return @\(Get-NetFirewallRule -DisplayName \$ruleName -ErrorAction Stop\)/);
  assert.match(script, /CmdletizationQuery_NotFound_DisplayName,Get-NetFirewallRule\*/);
  assert.match(script, /    throw\r\n  \}/);
  assert.doesNotMatch(script, /Get-NetFirewallRule[^\r\n]*SilentlyContinue/);
  assert.doesNotMatch(script, /Remove-NetFirewallRule[^\r\n]*SilentlyContinue/);
});

test('generated portable firewall PowerShell parses without interpolation errors', { skip: process.platform !== 'win32' }, () => {
  const script = createPortableFirewallScript({
    executablePath: 'C:\\Temp\\SnapOverLAN.exe',
    processId: 4242,
    statusPath: 'C:\\Temp\\firewall.status',
    cleanupLogPath: 'C:\\Temp\\portable-firewall.log',
  });
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const parserCommand = [
    `$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedScript}'))`,
    '$tokens = $null',
    '$errors = $null',
    '[System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors) | Out-Null',
    'if ($errors.Count -ne 0) { $errors | ForEach-Object { $_.Message }; exit 1 }',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parserCommand], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(script, /\$failures \+= "\$\{ruleName\}: \$\(\$_\.Exception\.Message\)"/);
  assert.doesNotMatch(script, /\$[A-Za-z_][A-Za-z0-9_]*:/);
});

test('portable executable short paths are resolved with the Windows long-path API', () => {
  const script = createPortableFirewallScript({
    executablePath: 'C:\\Users\\AZBE~1\\AppData\\Local\\Temp\\BUILD~1\\SnapOverLAN.exe',
    processId: 4242,
    statusPath: 'C:\\Users\\Ažbe\\AppData\\Local\\Temp\\firewall.status',
    cleanupLogPath: 'C:\\Users\\Ažbe\\AppData\\Roaming\\SnapOverLAN\\portable-firewall.log',
  });

  assert.match(script, /EntryPoint = "GetLongPathNameW"/);
  assert.match(script, /\$sourceProgram = 'C:\\Users\\AZBE~1\\AppData\\Local\\Temp\\BUILD~1\\SnapOverLAN\.exe'/);
  assert.match(script, /\[SnapOverLANPath\]::GetLongPathName\(\$sourceProgram, \$programBuffer/);
  assert.match(script, /\$program = \$programBuffer\.ToString\(\)/);
  assert.match(script, /-Program \$program/);
  assert.doesNotMatch(script, /-Program (?:'[^']*~1|\$sourceProgram)/i);
  assert.match(script, /Set-Content -LiteralPath 'C:\\Users\\Ažbe\\AppData\\Local\\Temp\\firewall\.status'/);
});

test('portable configuration elevates an encoded helper and waits for readiness', async () => {
  const child = new EventEmitter();
  child.unref = () => { child.unreferenced = true; };
  let launch;
  let statusPath;
  const fsApi = {
    readFile: async (file) => {
      statusPath = file;
      return 'ready';
    },
    rm: async (file, options) => {
      assert.equal(file, statusPath);
      assert.deepEqual(options, { force: true });
    },
  };

  const result = await configurePortableFirewall({
    electronApp: { isPackaged: true, getPath: () => 'C:\\Temp' },
    env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\SnapOverLAN.exe' },
    executablePath: 'C:\\Temp\\build-id\\SnapOverLAN.exe',
    fsApi,
    platform: 'win32',
    processId: 99,
    spawnImpl: (command, args, options) => {
      launch = { command, args, options };
      return child;
    },
  });

  assert.deepEqual(result, { configured: true, reason: 'configured' });
  assert.equal(launch.command, 'powershell.exe');
  assert.deepEqual(launch.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(launch.args[3], /-Verb RunAs -Wait/);
  assert.match(launch.args[3], /-EncodedCommand/);
  assert.deepEqual(launch.options, { windowsHide: true, stdio: 'ignore' });
  assert.equal(child.unreferenced, true);
});

test('installed builds do not launch or alter portable firewall rules', async () => {
  let spawned = false;
  const result = await configurePortableFirewall({
    electronApp: { isPackaged: true },
    env: {},
    platform: 'win32',
    spawnImpl: () => { spawned = true; },
  });

  assert.deepEqual(result, { configured: false, reason: 'not-portable-windows' });
  assert.equal(spawned, false);
});

test('a helper launch failure does not prevent portable app startup', async () => {
  const result = await configurePortableFirewall({
    electronApp: { isPackaged: true, getPath: () => 'C:\\Temp' },
    env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\SnapOverLAN.exe' },
    platform: 'win32',
    spawnImpl: () => { throw new Error('PowerShell unavailable'); },
  });

  assert.deepEqual(result, { configured: false, reason: 'configuration-failed' });
});
