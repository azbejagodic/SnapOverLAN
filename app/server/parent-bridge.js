const AUTO_COPY_REQUEST_TIMEOUT_MS = 1500;

const createParentBridge = ({ targetProcess = process } = {}) => {
  const pendingAutoCopyRequests = new Map();
  let nextAutoCopyRequestId = 0;

  const sendUploadCompleted = (event, processTarget = targetProcess) => {
    if (!processTarget?.connected || typeof processTarget.send !== 'function') {
      console.info('[auto-copy] IPC unavailable; standalone upload remains successful');
      return false;
    }

    try {
      processTarget.send(event, (error) => {
        if (error) {
          console.warn('[auto-copy] failed: IPC event delivery', error);
          return;
        }
        console.info('[auto-copy] IPC event sent', {
          batchId: event?.batchId || '',
          filename: event?.firstImage?.name || '',
        });
      });
      return true;
    } catch (error) {
      console.warn('[auto-copy] failed: IPC event send', error);
      return false;
    }
  };

  const requestAutoCopySetting = (
    operation,
    enabled,
    processTarget = targetProcess,
  ) => new Promise((resolve, reject) => {
    if (!processTarget?.connected || typeof processTarget.send !== 'function') {
      reject(new Error('Auto-copy control requires the SnapOverLAN desktop app.'));
      return;
    }

    const requestId = `${process.pid}-${Date.now()}-${nextAutoCopyRequestId += 1}`;
    const timeout = setTimeout(() => {
      pendingAutoCopyRequests.delete(requestId);
      reject(new Error('Timed out waiting for the desktop app.'));
    }, AUTO_COPY_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    pendingAutoCopyRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });

    const message = {
      type: 'snapoverlan:auto-copy-request',
      requestId,
      operation,
    };
    if (operation === 'set') {
      message.enabled = enabled;
    }

    try {
      processTarget.send(message, (error) => {
        if (!error) {
          return;
        }
        const pending = pendingAutoCopyRequests.get(requestId);
        pendingAutoCopyRequests.delete(requestId);
        pending?.reject(new Error('Could not contact the desktop app.'));
      });
    } catch {
      const pending = pendingAutoCopyRequests.get(requestId);
      pendingAutoCopyRequests.delete(requestId);
      pending?.reject(new Error('Could not contact the desktop app.'));
    }
  });

  const handleAutoCopySettingResponse = (message) => {
    if (
      message?.type !== 'snapoverlan:auto-copy-response'
      || typeof message.requestId !== 'string'
    ) {
      return false;
    }

    const pending = pendingAutoCopyRequests.get(message.requestId);
    if (!pending) {
      return false;
    }
    pendingAutoCopyRequests.delete(message.requestId);
    if (typeof message.error === 'string' && message.error) {
      pending.reject(new Error(message.error));
    } else if (typeof message.enabled !== 'boolean') {
      pending.reject(new Error('Invalid auto-copy response from the desktop app.'));
    } else {
      pending.resolve(message.enabled);
    }
    return true;
  };

  return {
    handleAutoCopySettingResponse,
    requestAutoCopySetting,
    sendUploadCompleted,
  };
};

export { createParentBridge };
