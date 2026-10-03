import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  createWindowsNetworkProfileScript,
  getWindowsNetworkProfile,
  openWindowsNetworkSettings,
} from '../app/desktop/windows-network-profile.js';

test('profile detection queries only the adapter owning the advertised address, read-only and hidden without elevation', async () => {
  let launch;
  const result = await getWindowsNetworkProfile('192.168.1.20', {
    platform: 'win32',
    execFileImpl: (command, args, options, callback) => {
      launch = { command, args, options };
      callback(null, '["Public"]');
    },
  });
  assert.equal(result, 'Public');
  assert.equal(launch.command, 'powershell.exe');
  assert.deepEqual(launch.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.deepEqual(launch.options, { windowsHide: true, timeout: 4000, maxBuffer: 65536, encoding: 'utf8' });
  const script = Buffer.from(launch.args[3], 'base64').toString('utf16le');
  assert.match(script, /Get-NetIPAddress -AddressFamily IPv4 -IPAddress '192\.168\.1\.20' -ErrorAction Stop/);
  assert.match(script, /Get-NetConnectionProfile -InterfaceIndex \$_\.InterfaceIndex -ErrorAction Stop/);
  assert.match(script, /IPv4Connectivity -ne 'Disconnected'/);
  assert.doesNotMatch(script, /Set-|New-|Remove-|RunAs|Start-Process|Firewall|Invoke-/);
});

for (const [output, expected] of [
  ['"Public"', 'Public'], ['["Private"]', 'Private'],
  ['["DomainAuthenticated"]', 'DomainAuthenticated'], ['["Public","Public"]', 'Public'],
  ['[]', null], ['null', null], ['', null], ['bad JSON', null],
  ['["Public","Private"]', null], ['["Public",null]', null],
  ['{"NetworkCategory":"Public"}', null], ['"Unknown"', null],
]) {
  test(`profile output ${JSON.stringify(output)} resolves safely to ${expected}`, async () => {
    assert.equal(await getWindowsNetworkProfile('10.0.0.50', {
      platform: 'win32', execFileImpl: (_command, _args, _options, callback) => callback(null, output),
    }), expected);
  });
}

test('unsupported platforms do not launch PowerShell', async () => {
  assert.equal(await getWindowsNetworkProfile('192.168.1.20', {
    platform: 'linux', execFileImpl: () => assert.fail('must not launch'),
  }), null);
});

test('query failures and timeouts yield unknown rather than a Public warning', async () => {
  for (const error of [new Error('access denied'), Object.assign(new Error('timed out'), { killed: true })]) {
    assert.equal(await getWindowsNetworkProfile('192.168.1.20', {
      platform: 'win32', execFileImpl: (_command, _args, _options, callback) => callback(error, '"Public"'),
    }), null);
  }
  assert.equal(await getWindowsNetworkProfile('192.168.1.20', {
    platform: 'win32', execFileImpl: () => { throw new Error('spawn failed'); },
  }), null);
});

test('invalid addresses and PowerShell injection attempts are rejected before process launch', async () => {
  for (const address of [null, {}, '', '8.8.8.8', '192.168.1.999', "192.168.1.20'; Start-Process calc; #", 'snap-test.local']) {
    await assert.rejects(getWindowsNetworkProfile(address, {
      platform: 'win32', execFileImpl: () => assert.fail('must not launch'),
    }), /Expected a LAN IPv4 address/);
  }
});

test('generated profile query parses in Windows PowerShell', { skip: process.platform !== 'win32' }, () => {
  const encoded = Buffer.from(createWindowsNetworkProfileScript('192.168.1.20'), 'utf16le').toString('base64');
  const command = [
    `$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))`,
    '$tokens = $null; $errors = $null',
    '[System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors) | Out-Null',
    'if ($errors.Count -ne 0) { $errors | ForEach-Object { $_.Message }; exit 1 }',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('settings action opens only the fixed Windows network page and handles failure safely', async () => {
  const opened = [];
  const shell = { openExternal: async (url) => opened.push(url) };
  assert.equal(await openWindowsNetworkSettings({ shell, platform: 'win32', url: 'file:///C:/secret' }), true);
  assert.deepEqual(opened, ['ms-settings:network-status']);
  assert.equal(await openWindowsNetworkSettings({ shell, platform: 'linux' }), false);
  assert.equal(opened.length, 1);
  assert.equal(await openWindowsNetworkSettings({ platform: 'win32', shell: {
    openExternal: async () => { throw new Error('settings unavailable'); },
  } }), false);
});

test('preload settings action cannot forward an arbitrary URL or command', async () => {
  const source = await readFile(new URL('../app/preload.cjs', import.meta.url), 'utf8');
  let bridge;
  const requests = [];
  runInNewContext(source, { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
    ipcRenderer: { invoke: (...args) => { requests.push(args); } },
  }) });
  bridge.openNetworkSettings('ms-settings:privacy', 'powershell.exe');
  bridge.getNetworkProfile('192.168.1.20');
  assert.deepEqual(requests, [['network:open-settings'], ['network:get-profile', '192.168.1.20']]);
});
