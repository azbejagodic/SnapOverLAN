const UPLOAD_DRAIN_TIMEOUT_MS = 5 * 60 * 1000;

const createUploadLifecycle = ({ timeoutMs = UPLOAD_DRAIN_TIMEOUT_MS, logger = console } = {}) => {
  const status = {
    draining: false,
    activeUploads: 0,
    get uploadInProgress() { return this.activeUploads > 0; },
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
      logger.warn(`Upload drain timed out after ${timeoutMs} ms; waiting for a shutdown decision.`);
      publish('decision');
    }, timeoutMs);
    publish('waiting');
  };
  const decideDrain = ({ revision, decision } = {}) => {
    if (drainState.phase !== 'decision' || revision !== drainState.revision) return false;
    if (decision === 'wait') startDrainTimer();
    else if (decision === 'continue') finishDrain('continue');
    else return false;
    return true;
  };

  const markUploadStarted = (req, res, next) => {
    // Admission and counting are synchronous: shutdown cannot interleave between them.
    if (status.draining) {
      res.status(503).json({ error: 'Server is shutting down. Please try again.' });
      return;
    }
    status.activeUploads += 1;
    status.lastUploadStartedAt = Date.now();
    status.lastUploadFinishedAt = null;
    let didFinish = false;
    const markUploadFinished = () => {
      if (didFinish) return;
      didFinish = true;
      status.activeUploads = Math.max(0, status.activeUploads - 1);
      status.lastUploadFinishedAt = Date.now();
      status.uploadVersion += 1;
      if (status.activeUploads === 0) finishDrain?.('idle');
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

  const beginDrain = () => {
    // Close admission before checking the count, yielding, or acknowledging shutdown.
    status.draining = true;
    if (drainPromise) return drainPromise;
    if (status.activeUploads === 0) {
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
    status, markUploadStarted, beginDrain, decideDrain,
    getDrainState: () => drainState,
    subscribeDrain: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
};

const uploadLifecycle = createUploadLifecycle();

export { createUploadLifecycle, uploadLifecycle, UPLOAD_DRAIN_TIMEOUT_MS };
