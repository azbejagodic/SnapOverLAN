const { contextBridge, ipcRenderer } = require('electron');

const MAX_IMAGE_COPY_BYTES = 32 * 1024 * 1024;
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
