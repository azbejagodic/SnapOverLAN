import assert from 'node:assert/strict';
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
  });

  for (const rule of Object.values(PORTABLE_FIREWALL_RULES)) assert.match(script, new RegExp(rule));
  assert.match(script, /-Protocol TCP -LocalPort 8787 -RemoteAddress LocalSubnet -Program 'C:\\Temp\\Snap''s App\\SnapOverLAN\.exe'/);
  assert.match(script, /-Protocol UDP -LocalPort 5353 -RemoteAddress LocalSubnet -Program 'C:\\Temp\\Snap''s App\\SnapOverLAN\.exe'/);
  assert.equal((script.match(/-Profile Private/g) || []).length, 2);
  assert.doesNotMatch(script, /Profile (?:Public|Any)|RemoteAddress Any/);
  assert.match(script, /Wait-Process -Id 4242/);
  assert.match(script, /finally \{\r\n  & \$removeRules/);
  assert.ok(script.indexOf('& $removeRules') < script.indexOf('New-NetFirewallRule'));
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
