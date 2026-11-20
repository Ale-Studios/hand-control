const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('handAPI', {
  onFrame: (cb) => ipcRenderer.on('hand:frame', (_e, p) => cb(p)),
  onConfig: (cb) => ipcRenderer.on('hand:config', (_e, c) => cb(c)),
});
