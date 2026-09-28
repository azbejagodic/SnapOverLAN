import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

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
  test(`${isPackaged ? 'packaged' : 'development'} desktop launch writes modern server variables only`, async () => {
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
    assert.equal((await manager.start()).state, 'online');
    assert.equal(launch.env.SNAPOVERLAN_PARENT_PID, '123');
    assert.equal(launch.env.SNAPOVERLAN_LOG_FILE, logPath);
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

const readConfig = (env) => runInNewContext(`${configSource}\n({ PORT, DATA_ROOT, STARTUP_LOG_PATH, LAUNCH_SOURCE, IS_PACKAGED_RUNTIME })`, {
  path, fileURLToPath, process: { env },
});
const legacyEnv = {
  PHOTO_GPT_PORT: '9876', PHOTO_GPT_DATA_DIR: 'legacy-data', PHOTO_GPT_LOG_FILE: 'legacy.log',
  PHOTO_GPT_SERVER_SOURCE: 'legacy-launch', PHOTO_GPT_PACKAGED: '1', PHOTO_GPT_PARENT_PID: '123',
};

test('server config still accepts legacy external launch inputs', () => {
  const config = readConfig(legacyEnv);
  assert.equal(config.PORT, 9876);
  assert.equal(config.DATA_ROOT, 'legacy-data');
  assert.equal(config.STARTUP_LOG_PATH, 'legacy.log');
  assert.equal(config.LAUNCH_SOURCE, 'legacy-launch');
  assert.equal(config.IS_PACKAGED_RUNTIME, true);
  assert.equal(readConfig({ PHOTO_GPT_PARENT_PID: '123' }).LAUNCH_SOURCE, 'electron');
});

test('modern config inputs take precedence over conflicting legacy inputs', () => {
  const config = readConfig({
    ...legacyEnv, SNAPOVERLAN_PORT: '9877', SNAPOVERLAN_DATA_DIR: 'modern-data',
    SNAPOVERLAN_LOG_FILE: 'modern.log', SNAPOVERLAN_SERVER_SOURCE: 'modern-launch', SNAPOVERLAN_PACKAGED: '0',
  });
  assert.equal(config.PORT, 9877);
  assert.equal(config.DATA_ROOT, 'modern-data');
  assert.equal(config.STARTUP_LOG_PATH, 'modern.log');
  assert.equal(config.LAUNCH_SOURCE, 'modern-launch');
  assert.equal(config.IS_PACKAGED_RUNTIME, false);
});

for (const modernPid of [undefined, '456']) {
  test(`parent monitoring preserves ${modernPid ? 'modern precedence' : 'legacy PID fallback'}`, () => {
    let tick;
    let observedPid;
    let shutdownReason;
    const watch = runInNewContext(`let parentWatchTimer;\n${watchSource}\nwatchParentProcess`, {
      process: {
        env: { PHOTO_GPT_PARENT_PID: '123', ...(modernPid ? { SNAPOVERLAN_PARENT_PID: modernPid } : {}) },
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
    tick();
    assert.equal(observedPid, Number(modernPid || '123'));
    assert.equal(shutdownReason, 'parent-exited');
  });
}
