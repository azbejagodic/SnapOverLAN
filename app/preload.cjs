const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapOverLAN', Object.freeze({
  getServerState: () => ipcRenderer.invoke('server:get-state'),
  retryServer: () => ipcRenderer.invoke('server:retry'),
  getBackgroundMode: () => ipcRenderer.invoke('background:get'),
  setBackgroundMode: (enabled) => ipcRenderer.invoke('background:set', Boolean(enabled)),
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
