// Both shutdown transports use this main-process decision loop. The server owns
// the deadline and rejects stale/duplicate decisions using its state revision.
const waitForUploadDrain = async ({ subscribe, start, decide, askToContinue }) => {
  let complete;
  let fail;
  const ready = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  // Subscription can fail before the caller starts awaiting ready.
  ready.catch(() => {});
  let dialogAbort = null;
  let latestRevision = -1;
  let finished = false;
  const cancelDialog = () => { dialogAbort?.abort(); dialogAbort = null; };
  const closed = () => { finished = true; cancelDialog(); complete(); };
  const error = (reason) => { finished = true; cancelDialog(); fail(reason); };
  const state = (value) => {
    if (finished || !Number.isInteger(value?.revision) || value.revision <= latestRevision) return;
    latestRevision = value.revision;
    cancelDialog();
    if (value.phase === 'ready') { closed(); return; }
    if (value.phase !== 'decision') return;
    const controller = new AbortController();
    dialogAbort = controller;
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) return askToContinue({ signal: controller.signal });
    }).then((decision) => {
      if (controller.signal.aborted || finished) return;
      return decide({ revision: value.revision, decision: decision === 'continue' ? 'continue' : 'wait' });
    }).catch((reason) => {
      if (!controller.signal.aborted && !finished) error(reason);
    });
  };
  let unsubscribe;
  try {
    unsubscribe = await subscribe({ state, closed, error });
    await start();
    await ready;
  } finally {
    finished = true;
    cancelDialog();
    unsubscribe?.();
  }
};

export { waitForUploadDrain };
