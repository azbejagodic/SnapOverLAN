import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNetworkExposureController,
  LAN_HOST,
  LOOPBACK_HOST,
} from '../app/desktop/network-exposure-controller.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const createHarness = ({ initialProfile = 'Private' } = {}) => {
  let profile = initialProfile;
  let running = false;
  let activeOperations = 0;
  let maxActiveOperations = 0;
  let stopGate = null;
  const events = [];
  const states = [];
  let timerCallback = null;
  let timerCleared = false;
  const manager = {
    isRunning: () => running,
    start: async (options) => {
      activeOperations += 1;
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
      events.push(['start', options]);
      running = true;
      activeOperations -= 1;
    },
    stop: async () => {
      activeOperations += 1;
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
      events.push(['stop']);
      if (stopGate) await stopGate;
      running = false;
      activeOperations -= 1;
    },
  };
  const controller = createNetworkExposureController({
    getLanAddresses: () => [{ address: '192.168.1.20' }],
    getNetworkProfile: async () => profile,
    manager,
    onStateChanged: (state) => states.push(state),
    platform: 'win32',
    setIntervalImpl: (callback, ms) => {
      assert.equal(ms, 5000);
      timerCallback = callback;
      return { unref() {} };
    },
    clearIntervalImpl: () => { timerCleared = true; },
  });
  return {
    controller, events, manager, states,
    getMaxActiveOperations: () => maxActiveOperations,
    getTimerCallback: () => timerCallback,
    getTimerCleared: () => timerCleared,
    setProfile: (value) => { profile = value; },
    setStopGate: (value) => { stopGate = value; },
  };
};

test('startup on Private enables the normal LAN listener and mDNS mode', async () => {
  const h = createHarness();
  await h.controller.start();
  assert.deepEqual(h.events, [['start', { host: LAN_HOST, lanExposure: true }]]);
  assert.deepEqual(h.controller.getState(), { lanAccess: 'available', networkProfile: 'Private' });
  assert.equal(typeof h.getTimerCallback(), 'function');
  await h.controller.dispose();
});

test('startup on Public uses loopback and disables LAN and mDNS exposure', async () => {
  const h = createHarness({ initialProfile: 'Public' });
  await h.controller.start();
  assert.deepEqual(h.events, [['start', { host: LOOPBACK_HOST, lanExposure: false }]]);
  assert.deepEqual(h.controller.getState(), { lanAccess: 'blocked-public', networkProfile: 'Public' });
  assert.ok(h.states.some((state) => state.lanAccess === 'blocked-public'));
  await h.controller.dispose();
});

test('Public to Private enables LAN without an application restart', async () => {
  const h = createHarness({ initialProfile: 'Public' });
  await h.controller.start();
  h.setProfile('Private');
  await h.controller.refresh();
  assert.deepEqual(h.events, [
    ['start', { host: LOOPBACK_HOST, lanExposure: false }],
    ['stop'],
    ['start', { host: LAN_HOST, lanExposure: true }],
  ]);
  assert.equal(h.controller.getState().lanAccess, 'available');
  await h.controller.dispose();
});

test('Private to Public removes LAN exposure while keeping a local server alive', async () => {
  const h = createHarness();
  await h.controller.start();
  h.setProfile('Public');
  await h.controller.refresh();
  assert.deepEqual(h.events.slice(-2), [
    ['stop'],
    ['start', { host: LOOPBACK_HOST, lanExposure: false }],
  ]);
  assert.equal(h.manager.isRunning(), true);
  assert.equal(h.controller.getState().lanAccess, 'blocked-public');
  await h.controller.dispose();
});

test('DomainAuthenticated remains LAN-enabled and repeated profiles do not duplicate lifecycle work', async () => {
  const h = createHarness({ initialProfile: 'DomainAuthenticated' });
  await h.controller.start();
  await Promise.all([h.controller.refresh(), h.controller.refresh(), h.controller.refresh()]);
  assert.deepEqual(h.events, [['start', { host: LAN_HOST, lanExposure: true }]]);
  assert.equal(h.controller.getState().networkProfile, 'DomainAuthenticated');
  await h.controller.dispose();
});

test('rapid profile changes serialize lifecycle work and converge on the final profile', async () => {
  const h = createHarness();
  await h.controller.start();
  const gate = deferred();
  h.setStopGate(gate.promise);
  h.setProfile('Public');
  const first = h.controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  h.setProfile('Private');
  const second = h.controller.refresh();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(h.getMaxActiveOperations(), 1);
  assert.deepEqual(h.events, [
    ['start', { host: LAN_HOST, lanExposure: true }],
    ['stop'],
    ['start', { host: LOOPBACK_HOST, lanExposure: false }],
    ['stop'],
    ['start', { host: LAN_HOST, lanExposure: true }],
  ]);
  assert.deepEqual(h.controller.getState(), { lanAccess: 'available', networkProfile: 'Private' });
  await h.controller.dispose();
});

test('shutdown while Public clears monitoring and allows the local server to stop cleanly', async () => {
  const h = createHarness({ initialProfile: 'Public' });
  await h.controller.start();
  await h.controller.pause();
  await h.manager.stop();
  await h.controller.dispose();
  assert.equal(h.getTimerCleared(), true);
  assert.equal(h.manager.isRunning(), false);
  assert.deepEqual(h.events.map(([name]) => name), ['start', 'stop']);
});

test('a cancelled shutdown resumes monitoring without duplicating the local server', async () => {
  const h = createHarness({ initialProfile: 'Public' });
  await h.controller.start();
  await h.controller.pause();
  assert.equal(h.getTimerCleared(), true);
  await h.controller.start();
  assert.deepEqual(h.events, [['start', { host: LOOPBACK_HOST, lanExposure: false }]]);
  assert.equal(typeof h.getTimerCallback(), 'function');
  await h.controller.dispose();
});

test('shutdown during a profile transition does not relaunch a server or leak the poll timer', async () => {
  const h = createHarness();
  await h.controller.start();
  const gate = deferred();
  h.setStopGate(gate.promise);
  h.setProfile('Public');
  const transition = h.controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  const disposal = h.controller.dispose();
  gate.resolve();
  await Promise.all([transition, disposal]);
  assert.deepEqual(h.events.map(([name]) => name), ['start', 'stop']);
  assert.equal(h.manager.isRunning(), false);
  assert.equal(h.getTimerCleared(), true);
});

test('non-Windows and unknown profile detection preserve existing LAN behavior', async () => {
  for (const platform of ['linux', 'darwin']) {
    const events = [];
    const manager = {
      isRunning: () => events.length > 0,
      start: async (options) => events.push(options),
      stop: async () => {},
    };
    const controller = createNetworkExposureController({
      getLanAddresses: () => [{ address: '192.168.1.20' }],
      getNetworkProfile: () => { throw new Error('must not query'); },
      manager,
      platform,
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    });
    await controller.start();
    assert.deepEqual(events, [{ host: LAN_HOST, lanExposure: true }]);
    await controller.dispose();
  }
});
