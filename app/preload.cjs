const { contextBridge, ipcRenderer } = require('electron');

const MAX_IMAGE_COPY_BYTES = 32 * 1024 * 1024;
const BATCH_ID_PATTERN = /^batch_[a-zA-Z0-9_-]+$/;
const copyImageBytes = (imageBytes) => {
  if (
    Object.prototype.toString.call(imageBytes) !== '[object ArrayBuffer]'
    || imageBytes.byteLength <= 0
    || imageBytes.byteLength > MAX_IMAGE_COPY_BYTES
  ) {
    return Promise.reject(new TypeError('Expected non-empty image bytes.'));
  }
  return ipcRenderer.invoke('image:copy', imageBytes);
};

contextBridge.exposeInMainWorld('snapOverLAN', Object.freeze({
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
  copyImageBytes,
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
