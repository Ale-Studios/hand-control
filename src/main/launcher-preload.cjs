const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('launcherAPI', {
  onTiles: (cb) => ipcRenderer.on('launcher:tiles', (_e, p) => cb(p)),
  choose: (i) => ipcRenderer.send('launcher:choose', i),
});
