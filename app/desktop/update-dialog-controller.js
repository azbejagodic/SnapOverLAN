const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

const READY_DIALOG_OPTIONS = (version) => ({
  type: 'info',
  title: 'SnapOverLAN Update',
  message: `SnapOverLAN ${version} is ready to install.`,
  detail: 'Restart SnapOverLAN now to install the update?',
  buttons: ['Later', 'Restart & Update'],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

const INSTALL_ERROR_DIALOG_OPTIONS = Object.freeze({
  type: 'error',
  title: 'SnapOverLAN Update',
  message: 'The update could not be installed.',
  detail: 'Please restart SnapOverLAN and try again.',
  buttons: ['OK'],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
});

const createUpdateDialogController = ({
  dialog,
  getMainWindow = () => null,
  logger = console,
  requestInstall,
} = {}) => {
  const promptedVersions = new Set();
  let activePrompt = null;
  let disposed = false;

  const warn = (message) => {
    try {
      logger?.warn?.(message);
    } catch {}
  };

  const showMessageBox = (options) => {
    const mainWindow = getMainWindow?.();
    if (
      mainWindow
      && !mainWindow.isDestroyed?.()
      && mainWindow.isVisible?.()
    ) {
      return dialog.showMessageBox(mainWindow, options);
    }
    return dialog.showMessageBox(options);
  };

  const showInstallError = async () => {
    try {
      await showMessageBox(INSTALL_ERROR_DIALOG_OPTIONS);
    } catch {
      warn('The update installation error dialog could not be shown.');
    }
  };

  const handleState = (state) => {
    const version = typeof state?.version === 'string' && VERSION_PATTERN.test(state.version)
      ? state.version
      : '';
    if (
      disposed
      || state?.status !== 'downloaded'
      || !version
      || promptedVersions.has(version)
    ) {
      return activePrompt || Promise.resolve(false);
    }

    promptedVersions.add(version);
    const operation = Promise.resolve()
      .then(() => showMessageBox(READY_DIALOG_OPTIONS(version)))
      .then(async (result) => {
        if (result?.response !== 1) return false;

        let installStarted = false;
        try {
          installStarted = await requestInstall?.() === true;
        } catch {
          warn('The update installation request failed.');
        }
        if (!installStarted) await showInstallError();
        return installStarted;
      })
      .catch(() => {
        warn('The update-ready dialog could not be shown.');
        return false;
      })
      .finally(() => {
        if (activePrompt === operation) activePrompt = null;
      });
    activePrompt = operation;
    return operation;
  };

  return Object.freeze({
    dispose: () => {
      disposed = true;
    },
    handleState,
  });
};

export {
  INSTALL_ERROR_DIALOG_OPTIONS,
  READY_DIALOG_OPTIONS,
  createUpdateDialogController,
};
