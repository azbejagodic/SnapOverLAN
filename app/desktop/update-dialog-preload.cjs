const { contextBridge, ipcRenderer } = require('electron');

const UPDATE_DIALOG_ACTION_CHANNEL = 'snapoverlan:update-dialog-action';
const ALLOWED_ACTIONS = new Set(['later', 'restart']);

contextBridge.exposeInMainWorld('snapOverLanUpdateDialog', Object.freeze({
  chooseAction(action) {
    if (!ALLOWED_ACTIONS.has(action)) return false;
    ipcRenderer.send(UPDATE_DIALOG_ACTION_CHANNEL, action);
    return true;
  },
}));
