import { spawn } from 'child_process';
import path from 'path';
import { createServerClient } from './server-client.js';

const SERVER_STOP_TIMEOUT_MS = 1000;
const SERVER_FORCE_STOP_TIMEOUT_MS = 500;
const LEGACY_SERVER_ERROR = 'An older SnapOverLAN server is running. Stop it once and restart the app.';
const AUTO_COPY_UNAVAILABLE_MESSAGE = 'Auto-copy unavailable because another SnapOverLAN server is running.';

const createServerManager = ({
  electronApp,
  getAutoCopyEnabled,
  getStartupLogPath,
  isQuitting,
  onAutoCopyUnavailable,
  onMessage,
  onStateChanged,
  port,
  projectRoot,
  serverPath,
  serverOrigin,
  writeStartupLog,
}) => {
  const client = createServerClient({ port });
  let ownedServerProcess = null;
  let serverLaunchMode = 'offline';
  let serverState = 'offline';
  let serverError = '';
  let serverOperation = null;
  let serverOperationType = '';
  let verifiedShutdownToken = '';
  let autoCopyUnavailableReason = '';
  const ownedServerMessageListeners = new WeakMap();

  const getState = () => ({
    state: serverState,
    error: serverError,
    owned: Boolean(ownedServerProcess),
  });

  const setState = (nextState, error = '') => {
    serverState = nextState;
    serverError = error;
    onStateChanged(getState());
  };

  const waitForServer = async (serverProcess) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (serverProcess.exitCode !== null || ownedServerProcess !== serverProcess) return null;
      const identity = await client.getServerIdentity();
      if (identity?.shutdownToken) return identity;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  const waitForProcessExit = (serverProcess, timeoutMs) => new Promise((resolve) => {
    if (serverProcess.exitCode !== null) { resolve(true); return; }
    const timeout = setTimeout(() => {
      serverProcess.removeListener('exit', handleExit);
      resolve(false);
    }, timeoutMs);
    const handleExit = () => { clearTimeout(timeout); resolve(true); };
    serverProcess.once('exit', handleExit);
  });

  const detachOwnedServerMessageListener = (serverProcess) => {
    const listener = ownedServerMessageListeners.get(serverProcess);
    if (!listener) return;
    serverProcess.removeListener('message', listener);
    ownedServerMessageListeners.delete(serverProcess);
  };

  const attachOwnedServerMessageListener = (serverProcess) => {
    detachOwnedServerMessageListener(serverProcess);
    const listener = (message) => {
      onMessage(serverProcess, message).catch((error) => {
        console.warn('Could not handle upload completion event:', error);
      });
    };
    ownedServerMessageListeners.set(serverProcess, listener);
    serverProcess.on('message', listener);
  };

  const logAutoCopy = (stage, details = {}) => {
    console.info(`[auto-copy] ${stage}`, details);
  };

  const stopVerifiedReusedServerForAutoCopy = async (identity) => {
    if (identity?.kind !== 'current'
      || typeof identity.shutdownToken !== 'string'
      || !/^[a-f0-9]{64}$/.test(identity.shutdownToken)) {
      return false;
    }
    logAutoCopy('requesting ownership from verified reused server');
    try {
      await client.postServerShutdown(identity.shutdownToken);
      const released = await client.waitForPortRelease(
        SERVER_STOP_TIMEOUT_MS + SERVER_FORCE_STOP_TIMEOUT_MS,
      );
      if (!released) throw new Error(`Port ${port} was not released.`);
      logAutoCopy('verified reused server stopped');
      return true;
    } catch (error) {
      logAutoCopy('failed', { reason: `Could not stop verified reused server: ${error.message}` });
      return false;
    }
  };

  const startServerInternal = async () => {
    if (serverState === 'online') return getState();
    setState('starting');
    let existingIdentity = await client.getServerIdentity();
    if (existingIdentity?.shutdownToken && getAutoCopyEnabled()) {
      const stoppedForOwnership = await stopVerifiedReusedServerForAutoCopy(existingIdentity);
      if (stoppedForOwnership) {
        existingIdentity = null;
        verifiedShutdownToken = '';
        serverLaunchMode = 'offline';
        autoCopyUnavailableReason = '';
      } else {
        existingIdentity = await client.getServerIdentity();
        if (existingIdentity?.shutdownToken) {
          autoCopyUnavailableReason = AUTO_COPY_UNAVAILABLE_MESSAGE;
        } else if (!existingIdentity && !(await client.isPortInUse())) {
          autoCopyUnavailableReason = '';
        }
      }
    }
    if (existingIdentity?.shutdownToken) {
      verifiedShutdownToken = existingIdentity.shutdownToken;
      serverLaunchMode = 'reused';
      await writeStartupLog('server-reused', {
        serverStatus: existingIdentity.server,
        logFile: getStartupLogPath(),
      });
      if (getAutoCopyEnabled()) {
        logAutoCopy('waiting', { reason: autoCopyUnavailableReason });
        onAutoCopyUnavailable(autoCopyUnavailableReason);
      }
      setState('online');
      return getState();
    }
    if (existingIdentity?.kind === 'legacy') {
      setState('error', LEGACY_SERVER_ERROR);
      throw new Error(LEGACY_SERVER_ERROR);
    }
    if (existingIdentity?.kind === 'current') {
      const error = 'SnapOverLAN is running, but its secure local shutdown control is unavailable.';
      setState('error', error);
      throw new Error(error);
    }
    if (await client.isPortInUse()) {
      const error = `Port ${port} is already in use by another application.`;
      setState('error', error);
      throw new Error(error);
    }

    const isPackaged = electronApp.isPackaged;
    const nodePath = isPackaged ? process.execPath : process.env.npm_node_execpath || process.env.NODE || 'node';
    const runtimeDataRoot = isPackaged ? path.join(electronApp.getPath('userData'), 'data') : '';
    const logPath = getStartupLogPath();
    const childEnv = {
      ...process.env,
      SNAPOVERLAN_PARENT_PID: String(process.pid),
      SNAPOVERLAN_LOG_FILE: logPath,
      SNAPOVERLAN_SERVER_SOURCE: isPackaged ? 'electron-packaged-child' : 'electron-dev-child',
      PHOTO_GPT_PARENT_PID: String(process.pid),
      PHOTO_GPT_LOG_FILE: logPath,
      PHOTO_GPT_SERVER_SOURCE: isPackaged ? 'electron-packaged-child' : 'electron-dev-child',
    };
    if (isPackaged) {
      childEnv.ELECTRON_RUN_AS_NODE = '1';
      childEnv.SNAPOVERLAN_DATA_DIR = runtimeDataRoot;
      childEnv.SNAPOVERLAN_PACKAGED = '1';
      childEnv.PHOTO_GPT_DATA_DIR = runtimeDataRoot;
      childEnv.PHOTO_GPT_PACKAGED = '1';
    }

    await writeStartupLog('server-starting', {
      nodePath,
      serverPath,
      bindHost: '0.0.0.0',
      port,
      runtimeDataDir: runtimeDataRoot || path.join(projectRoot, 'data'),
      logFile: logPath,
    });

    const serverProcess = spawn(nodePath, [serverPath], {
      cwd: projectRoot,
      env: childEnv,
      stdio: isPackaged
        ? ['ignore', 'ignore', 'ignore', 'ipc']
        : ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    ownedServerProcess = serverProcess;
    autoCopyUnavailableReason = '';
    attachOwnedServerMessageListener(serverProcess);

    serverProcess.once('error', (error) => {
      detachOwnedServerMessageListener(serverProcess);
      if (ownedServerProcess === serverProcess) {
        ownedServerProcess = null;
        if (getAutoCopyEnabled()) autoCopyUnavailableReason = 'Auto-copy is waiting for the local server.';
        verifiedShutdownToken = '';
        setState('error', `Could not start the server: ${error.message}`);
      }
    });
    serverProcess.once('exit', (code, signal) => {
      detachOwnedServerMessageListener(serverProcess);
      if (ownedServerProcess !== serverProcess) return;
      ownedServerProcess = null;
      if (getAutoCopyEnabled()) autoCopyUnavailableReason = 'Auto-copy is waiting for the local server.';
      verifiedShutdownToken = '';
      if (serverState !== 'stopping' && !isQuitting()) {
        const error = `Server process exited unexpectedly (${signal || code}).`;
        console.error(error);
        setState('error', error);
        writeStartupLog('server-exited-early', { code, signal }).catch(() => {});
      }
    });

    const status = await waitForServer(serverProcess);
    if (!status) {
      if (ownedServerProcess === serverProcess) ownedServerProcess = null;
      if (serverProcess.exitCode === null) {
        serverProcess.kill();
        await waitForProcessExit(serverProcess, SERVER_FORCE_STOP_TIMEOUT_MS);
      }
      const portConflict = await client.isPortInUse();
      const error = portConflict
        ? `Port ${port} is already in use; SnapOverLAN did not start a second server.`
        : `The local server did not become ready at ${serverOrigin}.`;
      setState('error', error);
      throw new Error(error);
    }

    serverLaunchMode = 'started';
    verifiedShutdownToken = status.shutdownToken;
    await writeStartupLog('server-started', { serverStatus: status.server, logFile: logPath });
    setState('online');
    return getState();
  };

  const start = () => {
    if (serverOperation) {
      if (serverOperationType === 'start') return serverOperation;
      return serverOperation.then(() => start());
    }
    serverOperationType = 'start';
    const operation = startServerInternal()
      .catch((error) => {
        if (serverState !== 'error') setState('error', error.message || 'The server failed to start.');
        throw error;
      })
      .finally(() => {
        if (serverOperation === operation) {
          serverOperation = null;
          serverOperationType = '';
        }
      });
    serverOperation = operation;
    return serverOperation;
  };

  const stopServerInternal = async () => {
    const serverProcess = ownedServerProcess;
    const identity = serverProcess
      ? null
      : verifiedShutdownToken
        ? { kind: 'current', shutdownToken: verifiedShutdownToken }
        : await client.getServerIdentity();
    if (!identity && !serverProcess) {
      if (await client.isPortInUse()) {
        const error = `Port ${port} is in use by an application that is not a verified SnapOverLAN server.`;
        setState('error', error);
        throw new Error(error);
      }
      verifiedShutdownToken = '';
      serverLaunchMode = 'offline';
      setState('offline');
      return getState();
    }
    if (!serverProcess && identity?.kind === 'legacy') {
      setState('error', LEGACY_SERVER_ERROR);
      throw new Error(LEGACY_SERVER_ERROR);
    }
    if (!serverProcess && identity?.kind === 'current' && !identity.shutdownToken) {
      const error = 'SnapOverLAN is running, but its secure local shutdown control is unavailable.';
      setState('error', error);
      throw new Error(error);
    }

    setState('stopping');
    let exited = false;
    let forced = false;
    if (serverProcess?.connected) {
      try {
        serverProcess.send({ type: 'snapoverlan:shutdown' });
        exited = await waitForProcessExit(serverProcess, SERVER_STOP_TIMEOUT_MS);
      } catch (error) { console.warn('IPC server shutdown failed:', error); }
    } else if (identity?.shutdownToken) {
      try {
        await client.postServerShutdown(identity.shutdownToken);
        exited = await client.waitForPortRelease(SERVER_STOP_TIMEOUT_MS);
      } catch (error) { console.warn('Graceful server shutdown failed:', error); }
    }
    if (!exited && serverProcess?.exitCode === null) {
      console.warn('Forcing the owned SnapOverLAN server process to stop.');
      forced = true;
      serverProcess.kill();
      exited = await waitForProcessExit(serverProcess, SERVER_FORCE_STOP_TIMEOUT_MS);
    }
    if (ownedServerProcess === serverProcess) ownedServerProcess = null;
    if (!exited && (!serverProcess || serverProcess.exitCode === null)) {
      const error = serverProcess
        ? 'The owned server process did not stop cleanly.'
        : 'The reused SnapOverLAN server did not stop cleanly.';
      setState('error', error);
      throw new Error(error);
    }
    verifiedShutdownToken = '';
    serverLaunchMode = 'offline';
    setState('offline');
    await writeStartupLog('server-stopped', { forced }).catch(() => {});
    return getState();
  };

  const stop = () => {
    if (serverOperation) {
      if (serverOperationType === 'stop') return serverOperation;
      return serverOperation.then(() => stop());
    }
    serverOperationType = 'stop';
    const operation = stopServerInternal().finally(() => {
      if (serverOperation === operation) {
        serverOperation = null;
        serverOperationType = '';
      }
    });
    serverOperation = operation;
    return serverOperation;
  };

  const ensureOwnedForAutoCopy = async () => {
    if (ownedServerProcess) return true;
    if (serverLaunchMode !== 'reused' || !/^[a-f0-9]{64}$/.test(verifiedShutdownToken)) {
      autoCopyUnavailableReason = AUTO_COPY_UNAVAILABLE_MESSAGE;
      onStateChanged(getState());
      onAutoCopyUnavailable(autoCopyUnavailableReason);
      return false;
    }
    setState('starting');
    const stopped = await stopVerifiedReusedServerForAutoCopy({
      kind: 'current',
      shutdownToken: verifiedShutdownToken,
    });
    if (!stopped) {
      const remainingIdentity = await client.getServerIdentity();
      if (remainingIdentity?.shutdownToken) {
        verifiedShutdownToken = remainingIdentity.shutdownToken;
        serverLaunchMode = 'reused';
        autoCopyUnavailableReason = AUTO_COPY_UNAVAILABLE_MESSAGE;
        setState('online');
      } else if (!remainingIdentity && !(await client.isPortInUse())) {
        verifiedShutdownToken = '';
        serverLaunchMode = 'offline';
        autoCopyUnavailableReason = '';
        setState('offline');
        try {
          await start();
          return Boolean(ownedServerProcess);
        } catch {
          autoCopyUnavailableReason = 'Auto-copy is waiting for the local server.';
        }
      } else {
        autoCopyUnavailableReason = AUTO_COPY_UNAVAILABLE_MESSAGE;
        setState('error', autoCopyUnavailableReason);
      }
      onAutoCopyUnavailable(autoCopyUnavailableReason);
      return false;
    }
    verifiedShutdownToken = '';
    serverLaunchMode = 'offline';
    autoCopyUnavailableReason = '';
    setState('offline');
    try {
      await start();
      return Boolean(ownedServerProcess);
    } catch {
      autoCopyUnavailableReason = 'Auto-copy is waiting for the local server.';
      onStateChanged(getState());
      onAutoCopyUnavailable(AUTO_COPY_UNAVAILABLE_MESSAGE);
      return false;
    }
  };

  return {
    clearAutoCopyUnavailable: () => { autoCopyUnavailableReason = ''; },
    ensureOwnedForAutoCopy,
    getLaunchMode: () => serverLaunchMode,
    getOperation: () => serverOperation,
    getState,
    isOwnedProcess: (serverProcess) => ownedServerProcess === serverProcess,
    isRunning: () => serverLaunchMode !== 'offline' || Boolean(ownedServerProcess),
    start,
    stop,
  };
};

export { createServerManager };
