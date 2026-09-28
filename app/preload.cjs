const { contextBridge, ipcRenderer } = require('electron');

const BATCH_ID_PATTERN = /^batch_[a-zA-Z0-9_-]+$/;

contextBridge.exposeInMainWorld('snapOverLAN', Object.freeze({
  serverRequest: (resourcePath, method = 'GET') => ipcRenderer.invoke('server:request', resourcePath, method),
  getServerState: () => ipcRenderer.invoke('server:get-state'),
  retryServer: () => ipcRenderer.invoke('server:retry'),
  getBackgroundMode: () => ipcRenderer.invoke('background:get'),
  setBackgroundMode: (enabled) => ipcRenderer.invoke('background:set', Boolean(enabled)),
  downloadBatch: (batchId) => {
    if (typeof batchId !== 'string' || !BATCH_ID_PATTERN.test(batchId)) {
      return Promise.reject(new TypeError('Expected a valid batch id.'));
    }
    return ipcRenderer.invoke('batch:download', batchId);
  },
  onDesktopStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:state-changed', listener);
    return () => ipcRenderer.removeListener('desktop:state-changed', listener);
  },
  onAutoCopyResult: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('desktop:auto-copy-result', listener);
    return () => ipcRenderer.removeListener('desktop:auto-copy-result', listener);
  },
}));
