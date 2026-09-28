// The server owns atomic upload admission and the bounded emergency deadline.
const waitForUploadDrain = async ({ subscribe, start }) => {
  let complete;
  let fail;
  const ready = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  ready.catch(() => {});
  let unsubscribe;
  try {
    unsubscribe = await subscribe({
      state: (value) => { if (value?.phase === 'ready') complete(true); },
      closed: () => complete(true),
      blocked: () => complete(false),
      error: fail,
    });
    if (await start() === false) return false;
    return await ready;
  } finally {
    unsubscribe?.();
  }
};

export { waitForUploadDrain };
