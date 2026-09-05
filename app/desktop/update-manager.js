const UPDATE_STATUSES = Object.freeze([
  'disabled',
  'checking',
  'available',
  'not-available',
  'downloading',
  'downloaded',
  'error',
]);

const NETWORK_ERROR_PATTERN = /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|net::|socket|timed?\s*out/i;
const UPDATE_INFO_ERROR_PATTERN = /404|channel.*not found|latest\.ya?ml|release.*not found|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i;
const VERIFICATION_ERROR_PATTERN = /checksum|sha512|signature|certificate|ERR_UPDATER_INVALID_SIGNATURE/i;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

const classifyUpdateRuntime = ({
  isPackaged = false,
  platform = process.platform,
  env = process.env,
} = {}) => {
  if (!isPackaged) {
    return Object.freeze({ eligible: false, kind: 'development', reason: 'development' });
  }
  if (platform !== 'win32') {
    return Object.freeze({ eligible: false, kind: 'unsupported', reason: 'unsupported-platform' });
  }
  if (env?.PORTABLE_EXECUTABLE_FILE || env?.PORTABLE_EXECUTABLE_DIR) {
    return Object.freeze({ eligible: false, kind: 'portable', reason: 'portable' });
  }
  return Object.freeze({ eligible: true, kind: 'installed-nsis', reason: '' });
};

const normalizeVersion = (value) => (
  typeof value === 'string' && VERSION_PATTERN.test(value) ? value : ''
);

const normalizeNumber = (value) => (
  Number.isFinite(value) && value >= 0 ? value : 0
);

const normalizeProgress = (progress = {}) => Object.freeze({
  percent: Math.min(100, normalizeNumber(progress.percent)),
  bytesPerSecond: normalizeNumber(progress.bytesPerSecond),
  transferred: normalizeNumber(progress.transferred),
  total: normalizeNumber(progress.total),
});

const sanitizeUpdaterError = (error) => {
  const rawMessage = [error?.code, error?.message, typeof error === 'string' ? error : '']
    .filter(Boolean)
    .join(' ');

  if (VERIFICATION_ERROR_PATTERN.test(rawMessage)) {
    return 'The downloaded update could not be verified.';
  }
  if (UPDATE_INFO_ERROR_PATTERN.test(rawMessage)) {
    return 'Update information is currently unavailable.';
  }
  if (NETWORK_ERROR_PATTERN.test(rawMessage)) {
    return 'Could not reach the update service.';
  }
  return 'The update could not be completed.';
};

const createState = (status, {
  reason = '',
  version = '',
  progress = null,
  message = '',
} = {}) => Object.freeze({
  status,
  reason,
  version: normalizeVersion(version),
  progress: progress ? normalizeProgress(progress) : null,
  message,
});

const isUpdaterLike = (updater) => Boolean(
  updater
  && typeof updater.on === 'function'
  && typeof updater.removeListener === 'function'
  && typeof updater.checkForUpdates === 'function'
  && typeof updater.quitAndInstall === 'function',
);

const createUpdateManager = ({
  isPackaged = false,
  platform = process.platform,
  env = process.env,
  updater = null,
  logger = console,
  initializationError = null,
} = {}) => {
  const runtime = classifyUpdateRuntime({ isPackaged, platform, env });
  const listeners = new Set();
  const updaterAvailable = runtime.eligible && isUpdaterLike(updater);
  let disposed = false;
  let checkOperation = null;
  let installStarted = false;
  let state = runtime.eligible
    ? createState('not-available', { reason: 'not-checked' })
    : createState('disabled', { reason: runtime.reason });

  const warn = (message) => {
    try {
      logger?.warn?.(message);
    } catch {}
  };

  const publishState = (nextState) => {
    state = nextState;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        warn('An update state listener failed.');
      }
    }
    return state;
  };

  const publishError = (error) => {
    const message = sanitizeUpdaterError(error);
    warn(message);
    return publishState(createState('error', { message }));
  };

  const handlers = {
    'checking-for-update': () => {
      if (!updaterAvailable || ['downloading', 'downloaded'].includes(state.status)) return;
      publishState(createState('checking'));
    },
    'update-available': (info) => {
      if (!updaterAvailable || ['downloading', 'downloaded'].includes(state.status)) return;
      publishState(createState('available', { version: info?.version }));
    },
    'update-not-available': (info) => {
      if (!updaterAvailable || ['downloading', 'downloaded'].includes(state.status)) return;
      publishState(createState('not-available', { version: info?.version }));
    },
    'download-progress': (progress) => {
      if (!updaterAvailable || state.status === 'downloaded') return;
      publishState(createState('downloading', {
        version: state.version,
        progress,
      }));
    },
    'update-downloaded': (info) => {
      if (!updaterAvailable) return;
      publishState(createState('downloaded', {
        version: info?.version || state.version,
      }));
    },
    error: publishError,
  };

  if (updaterAvailable) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    for (const [eventName, handler] of Object.entries(handlers)) {
      updater.on(eventName, handler);
    }
  } else if (runtime.eligible) {
    state = createState('error', {
      message: sanitizeUpdaterError(initializationError),
    });
    warn(state.message);
  }

  const checkForUpdates = () => {
    if (disposed || !updaterAvailable) return Promise.resolve(state);
    if (checkOperation) return checkOperation;
    if (['downloading', 'downloaded'].includes(state.status)) {
      return Promise.resolve(state);
    }

    publishState(createState('checking'));
    const operation = Promise.resolve()
      .then(() => updater.checkForUpdates())
      .then((result) => {
        if (state.status === 'checking' && result?.isUpdateAvailable === true) {
          publishState(createState('available', { version: result.updateInfo?.version }));
        } else if (state.status === 'checking' && result?.isUpdateAvailable === false) {
          publishState(createState('not-available', { version: result.updateInfo?.version }));
        }
        return state;
      })
      .catch((error) => publishError(error))
      .finally(() => {
        if (checkOperation === operation) checkOperation = null;
      });
    checkOperation = operation;
    return operation;
  };

  const installDownloadedUpdate = () => {
    if (
      disposed
      || !updaterAvailable
      || state.status !== 'downloaded'
    ) {
      return false;
    }
    if (installStarted) return true;

    installStarted = true;
    try {
      updater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      installStarted = false;
      publishError(error);
      return false;
    }
  };

  const onStateChanged = (listener) => {
    if (typeof listener !== 'function') {
      throw new TypeError('Expected an update state listener.');
    }
    if (disposed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (updaterAvailable) {
      for (const [eventName, handler] of Object.entries(handlers)) {
        updater.removeListener(eventName, handler);
      }
    }
    listeners.clear();
  };

  return Object.freeze({
    checkForUpdates,
    dispose,
    getRuntime: () => runtime,
    getState: () => state,
    installDownloadedUpdate,
    isEnabled: () => updaterAvailable && !disposed,
    isInstallationReady: () => state.status === 'downloaded',
    onStateChanged,
  });
};

const createElectronUpdateManager = async ({
  electronApp,
  logger = console,
  platform = process.platform,
  env = process.env,
  loadUpdater = () => import('electron-updater'),
} = {}) => {
  const runtimeOptions = {
    isPackaged: Boolean(electronApp?.isPackaged),
    platform,
    env,
    logger,
  };
  const runtime = classifyUpdateRuntime(runtimeOptions);
  if (!runtime.eligible) return createUpdateManager(runtimeOptions);

  try {
    const updaterModule = await loadUpdater();
    const updater = updaterModule.autoUpdater || updaterModule.default?.autoUpdater;
    return createUpdateManager({ ...runtimeOptions, updater });
  } catch (error) {
    return createUpdateManager({ ...runtimeOptions, initializationError: error });
  }
};

export {
  UPDATE_STATUSES,
  classifyUpdateRuntime,
  createElectronUpdateManager,
  createUpdateManager,
  sanitizeUpdaterError,
};
