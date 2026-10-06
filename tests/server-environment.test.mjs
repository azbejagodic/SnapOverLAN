import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { waitForUploadDrain } from '../app/desktop/upload-drain.js';

const managerSource = (await readFile(new URL('../app/desktop/server-manager.js', import.meta.url), 'utf8'))
  .replace(/^import.*;\r?\n/gm, '').replace(/export \{.*\};/, '');
const configUrl = new URL('../app/server/config.js', import.meta.url);
const configSource = (await readFile(configUrl, 'utf8'))
  .replace(/^import.*;\r?\n/gm, '')
  .replace('import.meta.url', JSON.stringify(configUrl.href))
  .replace(/export \{[\s\S]*?\};/, '');
const serverSource = await readFile(new URL('../app/server/index.js', import.meta.url), 'utf8');
const watchSource = serverSource.slice(serverSource.indexOf('const watchParentProcess ='), serverSource.indexOf('const shutdownServer ='));

for (const isPackaged of [false, true]) {
for (const publicNetwork of [false, true]) {
  test(`${isPackaged ? 'packaged' : 'development'} desktop launch writes ${publicNetwork ? 'Public loopback' : 'Private LAN'} variables only`, async () => {
    const root = path.resolve('test-runtime');
    const logPath = path.join(root, 'startup.log');
    let launch;
    const child = new EventEmitter();
    child.exitCode = null;
    const createManager = runInNewContext(`${managerSource}\ncreateServerManager`, {
      path, console, setTimeout, clearTimeout,
      process: { env: { PATH: 'inherited-path', SNAPOVERLAN_PORT: '9999' }, pid: 123, execPath: 'electron.exe', resourcesPath: root },
      spawn: (command, args, options) => { launch = { command, args, ...options }; return child; },
      createServerClient: () => ({
        getServerIdentity: async () => launch ? { kind: 'current', shutdownToken: 'a'.repeat(64) } : null,
        isPortInUse: async () => false,
      }),
    });
    const manager = createManager({
      electronApp: { isPackaged, getPath: () => root },
      getAutoCopyEnabled: () => false,
      getStartupLogPath: () => logPath,
      isQuitting: () => false,
      onAutoCopyUnavailable() {}, onMessage: async () => {}, onStateChanged() {},
      port: 9999, projectRoot: root, serverPath: path.join(root, 'server.js'),
      serverOrigin: 'http://localhost:9999', writeStartupLog: async () => {},
    });
    assert.equal((await manager.start(publicNetwork ? {
      host: '127.0.0.1', lanExposure: false,
    } : undefined)).state, 'online');
    assert.equal(launch.env.SNAPOVERLAN_PARENT_PID, '123');
    assert.equal(launch.env.SNAPOVERLAN_LOG_FILE, logPath);
    assert.equal(launch.env.SNAPOVERLAN_HOST, publicNetwork ? '127.0.0.1' : '0.0.0.0');
    assert.equal(launch.env.SNAPOVERLAN_LAN_EXPOSURE, publicNetwork ? '0' : '1');
    assert.equal(launch.env.SNAPOVERLAN_RUN_SERVER, '1');
    assert.equal(launch.env.SNAPOVERLAN_SERVER_SOURCE, isPackaged ? 'electron-packaged-child' : 'electron-dev-child');
    assert.equal(launch.env.SNAPOVERLAN_DATA_DIR, isPackaged ? path.join(root, 'data') : undefined);
    assert.equal(launch.env.SNAPOVERLAN_PACKAGED, isPackaged ? '1' : undefined);
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, isPackaged ? '1' : undefined);
    assert.equal(launch.env.SNAPOVERLAN_PORT, '9999');
    assert.equal(launch.env.PATH, 'inherited-path');
    assert.deepEqual(Object.keys(launch.env).filter((key) => key.startsWith('PHOTO_GPT_')), []);
    assert.equal(launch.command, isPackaged ? 'electron.exe' : 'node');
    assert.equal(launch.args[0], path.join(root, 'server.js'));
    assert.equal(launch.cwd, root);
    assert.equal(launch.stdio[3], 'ipc');
    assert.equal(launch.windowsHide, true);
  });
}
}

const readConfig = (env, platform = 'win32') => runInNewContext(`${configSource}\n({ PORT, HOST, LAN_EXPOSURE, DATA_ROOT, STARTUP_LOG_PATH, LAUNCH_SOURCE, IS_PACKAGED_RUNTIME, FIREWALL_GUIDANCE_MODE })`, {
  path, fileURLToPath, process: { env, platform },
});

test('firewall guidance distinguishes Windows Setup, portable, development, and other platforms', () => {
  assert.match(serverSource, /firewallGuidanceMode: FIREWALL_GUIDANCE_MODE/);
  assert.equal(readConfig({ SNAPOVERLAN_PACKAGED: '1' }).FIREWALL_GUIDANCE_MODE, 'setup');
  for (const key of ['PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR']) {
    assert.equal(readConfig({ SNAPOVERLAN_PACKAGED: '1', [key]: 'portable-path' }).FIREWALL_GUIDANCE_MODE, 'portable');
  }
  assert.equal(readConfig({}).FIREWALL_GUIDANCE_MODE, 'development');
  assert.equal(readConfig({ SNAPOVERLAN_PACKAGED: '1' }, 'linux').FIREWALL_GUIDANCE_MODE, 'other');
});
// Negative regression inputs: these retired names must not configure the server.
const retiredEnv = {
  PHOTO_GPT_PORT: '9876', PHOTO_GPT_DATA_DIR: 'legacy-data', PHOTO_GPT_LOG_FILE: 'legacy.log',
  PHOTO_GPT_SERVER_SOURCE: 'legacy-launch', PHOTO_GPT_PACKAGED: '1', PHOTO_GPT_PARENT_PID: '123',
};

test('retired environment names are ignored and server defaults remain intact', () => {
  for (const env of [retiredEnv, {
    ...retiredEnv,
    SNAPOVERLAN_PORT: '', SNAPOVERLAN_DATA_DIR: '', SNAPOVERLAN_LOG_FILE: '',
    SNAPOVERLAN_SERVER_SOURCE: '', SNAPOVERLAN_PACKAGED: '', SNAPOVERLAN_PARENT_PID: '',
  }]) {
    const config = readConfig(env);
    assert.equal(config.PORT, 8787);
    assert.equal(config.HOST, '0.0.0.0');
    assert.equal(config.LAN_EXPOSURE, true);
    assert.equal(config.DATA_ROOT, fileURLToPath(new URL('../data', import.meta.url)));
    assert.equal(config.STARTUP_LOG_PATH, '');
    assert.equal(config.LAUNCH_SOURCE, 'standalone');
    assert.equal(config.IS_PACKAGED_RUNTIME, false);
  }
});

test('modern variables configure the server independently of retired inputs', () => {
  for (const extraEnv of [{}, retiredEnv]) {
    const config = readConfig({
      ...extraEnv, SNAPOVERLAN_PORT: '9877', SNAPOVERLAN_DATA_DIR: 'modern-data',
      SNAPOVERLAN_LOG_FILE: 'modern.log', SNAPOVERLAN_SERVER_SOURCE: 'modern-launch', SNAPOVERLAN_PACKAGED: '1',
    });
    assert.equal(config.PORT, 9877);
    assert.equal(config.DATA_ROOT, 'modern-data');
    assert.equal(config.STARTUP_LOG_PATH, 'modern.log');
    assert.equal(config.LAUNCH_SOURCE, 'modern-launch');
    assert.equal(config.IS_PACKAGED_RUNTIME, true);
  }
  assert.equal(readConfig({ SNAPOVERLAN_PARENT_PID: '456' }).LAUNCH_SOURCE, 'electron');
  assert.equal(readConfig({ ...retiredEnv, SNAPOVERLAN_PACKAGED: '0' }).IS_PACKAGED_RUNTIME, false);
});

test('desktop network exposure variables select loopback without accepting arbitrary bind hosts', () => {
  const config = readConfig({ SNAPOVERLAN_HOST: '127.0.0.1', SNAPOVERLAN_LAN_EXPOSURE: '0' });
  assert.equal(config.PORT, 8787);
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.LAN_EXPOSURE, false);
  assert.equal(config.DATA_ROOT, fileURLToPath(new URL('../data', import.meta.url)));
  assert.equal(config.STARTUP_LOG_PATH, '');
  assert.equal(config.LAUNCH_SOURCE, 'standalone');
  assert.equal(config.IS_PACKAGED_RUNTIME, false);
  assert.equal(readConfig({ SNAPOVERLAN_HOST: '192.168.1.20' }).HOST, '0.0.0.0');
});

test('Public startup replaces a verified LAN-bound server before launching one loopback child', async () => {
  const root = path.resolve('test-runtime');
  const token = 'a'.repeat(64);
  let existing = true;
  let launch;
  let shutdowns = 0;
  let shutdownObserver;
  const child = new EventEmitter();
  child.exitCode = null;
  const createManager = runInNewContext(`${managerSource}\ncreateServerManager`, {
    path, console, setTimeout, clearTimeout, waitForUploadDrain,
    process: { env: {}, pid: 123, execPath: 'electron.exe', resourcesPath: root },
    spawn: (command, args, options) => { launch = { command, args, ...options }; return child; },
    createServerClient: () => ({
      getServerIdentity: async () => {
        if (launch) return { kind: 'current', shutdownToken: token, server: { bindHost: '127.0.0.1' } };
        if (existing) return { kind: 'current', shutdownToken: token, server: { bindHost: '0.0.0.0' } };
        return null;
      },
      isPortInUse: async () => false,
      postServerShutdown: async () => {
        shutdowns += 1;
        existing = false;
        shutdownObserver.closed();
      },
      waitForPortRelease: async () => true,
      watchServerShutdown: async (_shutdownToken, observer) => {
        shutdownObserver = observer;
        return () => {};
      },
    }),
  });
  const manager = createManager({
    electronApp: { isPackaged: false },
    getAutoCopyEnabled: () => false,
    getStartupLogPath: () => '',
    isQuitting: () => false,
    onAutoCopyUnavailable() {}, onMessage: async () => {}, onStateChanged() {},
    port: 8787, projectRoot: root, serverPath: path.join(root, 'server.js'),
    serverOrigin: 'http://localhost:8787', writeStartupLog: async () => {},
  });
  const state = await manager.start({ host: '127.0.0.1', lanExposure: false });
  assert.equal(state.state, 'online');
  assert.equal(shutdowns, 1);
  assert.equal(launch.env.SNAPOVERLAN_HOST, '127.0.0.1');
  assert.equal(launch.env.SNAPOVERLAN_LAN_EXPOSURE, '0');
});

for (const modernPid of [undefined, '', '456']) {
  test(`parent monitoring ${modernPid ? 'uses the modern PID' : `ignores retired PID when modern PID is ${modernPid === '' ? 'empty' : 'absent'}`}`, () => {
    let tick;
    let observedPid;
    let shutdownReason;
    const watch = runInNewContext(`let parentWatchTimer;\n${watchSource}\nwatchParentProcess`, {
      process: {
        env: { PHOTO_GPT_PARENT_PID: '123', ...(modernPid !== undefined ? { SNAPOVERLAN_PARENT_PID: modernPid } : {}) },
        kill: (pid, signal) => {
          observedPid = pid;
          assert.equal(signal, 0);
          throw Object.assign(new Error('parent exited'), { code: 'ESRCH' });
        },
      },
      setInterval: (callback, ms) => { assert.equal(ms, 2000); tick = callback; return { unref() {} }; },
      shutdownServer: (reason) => { shutdownReason = reason; },
    });
    watch();
    if (!modernPid) {
      assert.equal(tick, undefined);
      assert.equal(observedPid, undefined);
      assert.equal(shutdownReason, undefined);
      return;
    }
    tick();
    assert.equal(observedPid, Number(modernPid));
    assert.equal(shutdownReason, 'parent-exited');
  });
}
