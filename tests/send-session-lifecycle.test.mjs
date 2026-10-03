import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createUploadLifecycle, SEND_SESSION_LEASE_MS } from '../app/server/upload-lifecycle.js';

const admit = (lifecycle, sessionId) => {
  const req = new EventEmitter();
  req.get = () => sessionId;
  const res = new EventEmitter();
  let accepted = false;
  let code;
  res.status = (value) => { code = value; return res; };
  res.json = () => {};
  lifecycle.markUploadStarted(req, res, () => { accepted = true; });
  return { req, res, accepted, code };
};

test('a server-issued preparation lease blocks shutdown without counting a multipart upload', () => {
  const lifecycle = createUploadLifecycle();
  const session = lifecycle.beginSendSession();
  assert.match(session.sessionId, /^[a-f0-9]{64}$/);
  assert.equal(session.expiresInMs, 60000);
  assert.equal(lifecycle.status.activeUploads, 0);
  assert.equal(lifecycle.status.activeSendSessions, 1);
  assert.equal(lifecycle.status.uploadInProgress, true);
  const before = JSON.stringify(lifecycle.status);
  assert.equal(lifecycle.beginDrain({ onlyIfIdle: true }), null);
  assert.equal(JSON.stringify(lifecycle.status), before);
  assert.equal(lifecycle.getDrainState().phase, 'idle');
  lifecycle.endSendSession(session.sessionId);
});

test('successful completion transfers the same session to the upload guard with no idle gap', () => {
  const lifecycle = createUploadLifecycle();
  const { sessionId } = lifecycle.beginSendSession();
  const upload = admit(lifecycle, sessionId);
  assert.equal(upload.accepted, true);
  assert.equal(upload.req.sendSessionId, sessionId);
  assert.equal(lifecycle.status.activeSendSessions, 0);
  assert.equal(lifecycle.status.activeUploads, 1);
  assert.equal(lifecycle.status.uploadInProgress, true);
  assert.equal(lifecycle.beginDrain({ onlyIfIdle: true }), null);
  upload.res.emit('finish');
  assert.equal(lifecycle.status.uploadInProgress, false);
  assert.equal(lifecycle.status.activeUploads, 0);
  // Late or duplicate end requests cannot change upload counters.
  lifecycle.endSendSession(sessionId);
  upload.res.emit('close');
  assert.equal(lifecycle.status.uploadVersion, 1);
});

test('lease expiry, late end, and duplicate uploads cannot release an interrupted upload before cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const lifecycle = createUploadLifecycle();
  const { sessionId } = lifecycle.beginSendSession();
  const upload = admit(lifecycle, sessionId);
  t.mock.timers.tick(SEND_SESSION_LEASE_MS * 2);
  lifecycle.endSendSession(sessionId);
  assert.equal(admit(lifecycle, sessionId).accepted, false);
  assert.equal(lifecycle.beginDrain({ onlyIfIdle: true }), null);
  let cleaned;
  upload.req.uploadProcessing = new Promise(resolve => { cleaned = resolve; });
  upload.res.emit('close');
  assert.equal(upload.req.uploadInterrupted, true);
  assert.equal(lifecycle.status.uploadInProgress, true);
  cleaned();
  await upload.req.uploadProcessing;
  assert.equal(lifecycle.status.uploadInProgress, false);
});

test('no heartbeat expires a lost phone session after 60 seconds and cannot be resurrected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const lifecycle = createUploadLifecycle();
  const { sessionId } = lifecycle.beginSendSession();
  t.mock.timers.tick(59999);
  assert.equal(lifecycle.beginDrain({ onlyIfIdle: true }), null);
  t.mock.timers.tick(1);
  assert.equal(lifecycle.status.uploadInProgress, false);
  assert.throws(() => lifecycle.renewSendSession(sessionId), { statusCode: 410 });
  assert.equal(admit(lifecycle, sessionId).code, 410);
  assert.equal(await lifecycle.beginDrain({ onlyIfIdle: true }), 'idle');
});

test('heartbeats extend the lease; explicit cancellation clears it immediately and is idempotent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const lifecycle = createUploadLifecycle();
  const { sessionId } = lifecycle.beginSendSession();
  for (let i = 0; i < 12; i += 1) {
    t.mock.timers.tick(10000);
    lifecycle.renewSendSession(sessionId);
    assert.equal(lifecycle.status.activeSendSessions, 1);
    assert.equal(lifecycle.beginDrain({ onlyIfIdle: true }), null);
  }
  lifecycle.endSendSession(sessionId);
  lifecycle.endSendSession(sessionId);
  assert.equal(lifecycle.status.uploadInProgress, false);
  assert.equal(await lifecycle.beginDrain({ onlyIfIdle: true }), 'idle');
});

test('duplicate begins, random IDs, and malformed tokens cannot mutate the active session', () => {
  const lifecycle = createUploadLifecycle();
  const { sessionId } = lifecycle.beginSendSession();
  assert.throws(() => lifecycle.beginSendSession(), { statusCode: 429 });
  for (const invalid of ['', {}, null, 'a'.repeat(63), '../session']) {
    assert.throws(() => lifecycle.renewSendSession(invalid), { statusCode: 400 });
    assert.throws(() => lifecycle.endSendSession(invalid), { statusCode: 400 });
  }
  const other = sessionId === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
  assert.throws(() => lifecycle.renewSendSession(other), { statusCode: 410 });
  lifecycle.endSendSession(other);
  assert.equal(lifecycle.status.activeSendSessions, 1);
  lifecycle.endSendSession(sessionId);
  const fresh = lifecycle.beginSendSession();
  assert.notEqual(fresh.sessionId, sessionId);
  lifecycle.endSendSession(fresh.sessionId);
});

test('forced shutdown closes session admission and settles when an abandoned preparation lease expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const lifecycle = createUploadLifecycle({ logger: { warn() {} } });
  const { sessionId } = lifecycle.beginSendSession();
  const draining = lifecycle.beginDrain();
  assert.throws(() => lifecycle.beginSendSession(), { statusCode: 503 });
  assert.throws(() => lifecycle.renewSendSession(sessionId), { statusCode: 503 });
  t.mock.timers.tick(60000);
  assert.equal(await draining, 'idle');
});

test('legacy uploads retain the original guard and prevent a new preparation lease', () => {
  const lifecycle = createUploadLifecycle();
  const upload = admit(lifecycle);
  assert.equal(upload.accepted, true);
  assert.throws(() => lifecycle.beginSendSession(), { statusCode: 429 });
  assert.equal(lifecycle.beginDrain({ onlyIfIdle: true }), null);
  upload.res.emit('finish');
  assert.equal(lifecycle.status.uploadInProgress, false);
});
