// Safe bridge between the window and the main process: only these functions, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch, cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('hc', {
  getState: () => ipcRenderer.invoke('get-state'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setMode: (mode, reason, source) => ipcRenderer.send('mode:set', { mode, reason, source }),
  input: (m) => ipcRenderer.send('input', m),
  cameraState: (s) => ipcRenderer.send('camera:state', s),
  hud: (h) => ipcRenderer.send('hud', h),
  handFrame: (p) => ipcRenderer.send('hand:frame', p),
  log: (t) => ipcRenderer.send('log', t),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('window:quit'),
  saveMeasure: (o) => ipcRenderer.invoke('measure:save', o),
  openMeasures: () => ipcRenderer.send('measure:open-folder'),
  on: {
    mode: (cb) => on('mode', cb),
    settings: (cb) => on('settings', cb),
    screen: (cb) => on('screen', cb),
    log: (cb) => on('log', cb),
    ack: (cb) => on('ack', cb),
    hotkeys: (cb) => on('hotkeys', cb),
    blocked: (cb) => on('blocked', cb),
    realMouse: (cb) => on('real-mouse', cb),
    glass: (cb) => on('glass', cb),
    handOverlay: (cb) => on('hand-overlay', cb),
    e2eFrame: (cb) => on('e2e:frame', cb),
  },
  clock: () => performance.timeOrigin + performance.now(),
});
