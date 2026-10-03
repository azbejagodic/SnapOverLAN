import { MAX_ACTIVE_UPLOADS, UPLOAD_BUSY_ERROR } from './config.js';
import { randomBytes } from 'node:crypto';

const UPLOAD_DRAIN_TIMEOUT_MS = 60 * 1000;
const SEND_SESSION_LEASE_MS = 60 * 1000;
const SEND_SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

const createUploadLifecycle = ({ timeoutMs = UPLOAD_DRAIN_TIMEOUT_MS, logger = console } = {}) => {
  const sendSessions = new Map();
  const status = {
    draining: false,
    activeUploads: 0,
    get activeSendSessions() { return sendSessions.size; },
    get uploadInProgress() { return this.activeUploads > 0 || sendSessions.size > 0; },
    lastUploadStartedAt: null,
    lastUploadFinishedAt: null,
    uploadVersion: 0,
  };
  let drainPromise = null;
  let finishDrain = null;
  let drainTimer = null;
  let drainState = { phase: 'idle', revision: 0 };
  const listeners = new Set();
  const publish = (phase) => {
    drainState = { phase, revision: drainState.revision + 1 };
    for (const listener of listeners) listener(drainState);
  };
  const startDrainTimer = () => {
    clearTimeout(drainTimer);
    drainTimer = setTimeout(() => {
      drainTimer = null;
      logger.warn(`Upload drain timed out after ${timeoutMs} ms; continuing shutdown.`);
      finishDrain('continue');
    }, timeoutMs);
    publish('waiting');
  };
  const sessionError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  const assertSessionId = (id) => {
    if (typeof id !== 'string' || !SEND_SESSION_ID_PATTERN.test(id)) {
      throw sessionError(400, 'Invalid send session.');
    }
  };
  const endSendSession = (id) => {
    assertSessionId(id);
    clearTimeout(sendSessions.get(id)?.timer);
    sendSessions.delete(id);
    if (!status.uploadInProgress) finishDrain?.('idle');
    return { ended: true };
  };
  const findSendSession = (id) => {
    assertSessionId(id);
    const session = sendSessions.get(id);
    if (session && session.expiresAt <= Date.now()) endSendSession(id);
    if (!sendSessions.has(id)) throw sessionError(410, 'Send session expired. Press Upload again.');
    return session;
  };
  const renewSession = (id, session) => {
    clearTimeout(session.timer);
    session.expiresAt = Date.now() + SEND_SESSION_LEASE_MS;
    session.timer = setTimeout(() => endSendSession(id), SEND_SESSION_LEASE_MS);
    session.timer.unref?.();
  };
  const assertSessionAdmission = () => {
    if (status.draining) throw sessionError(503, 'Server is shutting down. Please try again.');
  };
  const beginSendSession = () => {
    assertSessionAdmission();
    // Timers can be delayed; expired leases must not block a new attempt.
    for (const [id, session] of sendSessions) {
      if (session.expiresAt <= Date.now()) endSendSession(id);
    }
    if (sendSessions.size >= MAX_ACTIVE_UPLOADS || status.activeUploads >= MAX_ACTIVE_UPLOADS) {
      throw sessionError(429, UPLOAD_BUSY_ERROR);
    }
    const sessionId = randomBytes(32).toString('hex');
    const session = {};
    sendSessions.set(sessionId, session);
    renewSession(sessionId, session);
    return { sessionId, expiresInMs: SEND_SESSION_LEASE_MS };
  };
  const renewSendSession = (id) => {
    assertSessionAdmission();
    renewSession(id, findSendSession(id));
    return { renewed: true, expiresInMs: SEND_SESSION_LEASE_MS };
  };
  const markUploadStarted = (req, res, next) => {
    // Admission and counting are synchronous: shutdown cannot interleave between them.
    if (status.draining) {
      res.status(503).json({ error: 'Server is shutting down. Please try again.' });
      return;
    }
    if (status.activeUploads >= MAX_ACTIVE_UPLOADS) {
      res.status(429).json({ error: UPLOAD_BUSY_ERROR });
      return;
    }
    const sessionId = req.get?.('x-snapoverlan-send-session');
    if (sessionId !== undefined) {
      try { findSendSession(sessionId); }
      catch (error) { res.status(error.statusCode).json({ error: error.message }); return; }
    }
    status.activeUploads += 1;
    // Transfer ownership in one event-loop turn: lease removal cannot create
    // an idle gap, and its old timer can never release an active upload.
    if (sessionId !== undefined) {
      req.sendSessionId = sessionId;
      endSendSession(sessionId);
    }
    status.lastUploadStartedAt = Date.now();
    status.lastUploadFinishedAt = null;
    let didFinish = false;
    const markUploadFinished = () => {
      if (didFinish) return;
      didFinish = true;
      status.activeUploads = Math.max(0, status.activeUploads - 1);
      status.lastUploadFinishedAt = Date.now();
      status.uploadVersion += 1;
      if (!status.uploadInProgress) finishDrain?.('idle');
    };
    res.once('finish', markUploadFinished);
    req.once?.('aborted', () => { req.uploadInterrupted = true; });
    res.once('close', () => {
      if (!res.writableFinished) {
        req.uploadInterrupted = true;
        // Keep shutdown draining until interrupted staging work has been cleaned up.
        Promise.resolve(req.uploadProcessing).then(markUploadFinished, markUploadFinished);
      } else {
        markUploadFinished();
      }
    });
    next();
  };

  const beginDrain = ({ onlyIfIdle = false } = {}) => {
    // Check and close admission synchronously in the same server event-loop turn.
    // A blocked user request must not mutate admission, state, or timers.
    if (onlyIfIdle && status.uploadInProgress) return null;
    status.draining = true;
    if (drainPromise) return drainPromise;
    if (!status.uploadInProgress) {
      drainPromise = Promise.resolve('idle');
      publish('ready');
      return drainPromise;
    }
    drainPromise = new Promise((resolve) => {
      finishDrain = (result) => {
        clearTimeout(drainTimer);
        drainTimer = null;
        finishDrain = null;
        publish('ready');
        resolve(result);
      };
    });
    startDrainTimer();
    return drainPromise;
  };

  return {
    status, markUploadStarted, beginDrain, beginSendSession, renewSendSession, endSendSession,
    getDrainState: () => drainState,
    subscribeDrain: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
};

const uploadLifecycle = createUploadLifecycle();

export { createUploadLifecycle, uploadLifecycle, UPLOAD_DRAIN_TIMEOUT_MS, SEND_SESSION_LEASE_MS };
