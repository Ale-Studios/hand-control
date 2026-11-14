const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlayAPI', {
  onState: (cb) => ipcRenderer.on('overlay-state', (_e, s) => cb(s)),
});
