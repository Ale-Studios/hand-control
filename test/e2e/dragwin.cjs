// A tiny separate Electron app with ONE draggable window (a title bar you can grab). The end-to-end test starts it as a
// child process and drags it with a "pinch": a real window drag. It must be a separate process, because while a window is
// being moved, Windows runs a modal loop in the thread that owns it.
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.setPath('userData', process.env.DRAGWIN_DATA || path.join(require('os').tmpdir(), 'hc-dragwin-' + process.pid));
app.whenReady().then(() => {
  const w = new BrowserWindow({
    title: 'HC dragwin', x: 500, y: 300, width: 380, height: 240, frame: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: { sandbox: true },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  const html = '<title>HC dragwin</title><body style="margin:0;background:#1a2230;color:#cfd6de;font:16px Segoe UI;user-select:none">'
    + '<div style="height:64px;background:#33415a;-webkit-app-region:drag;display:flex;align-items:center;padding-left:16px">title bar (drag me)</div>'
    + '<div style="padding:16px">test window</div></body>';
  const out = () => console.log('BOUNDS ' + JSON.stringify(w.getBounds()));
  w.on('move', out); w.on('moved', out);
  w.webContents.once('did-finish-load', () => { w.show(); out(); });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  setTimeout(() => app.quit(), 90000); // never stays around
});
app.on('window-all-closed', () => app.quit());
