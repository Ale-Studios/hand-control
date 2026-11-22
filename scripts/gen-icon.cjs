// Generates the app icon from assets/icon.svg: assets/icon.png (256 px, window icon) and build/icon.ico (16-256 px,
// exe / installer / shortcuts). The SVG is drawn by Electron itself, so no external tool is needed:
//   npm run icon        (= electron scripts/gen-icon.cjs)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { icoFrom } = require('../src/main/icons.cjs');

const root = path.join(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
app.setPath('userData', path.join(require('os').tmpdir(), 'hc-gen-icon-' + process.pid));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(root, 'assets', 'icon.svg'), 'utf8');
  const w = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const pngs = [];
  for (const size of SIZES) {
    const html = `<body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`;
    w.setContentSize(size, size);
    await w.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await new Promise((r) => setTimeout(r, 250));
    const img = (await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size, quality: 'best' });
    pngs.push({ size, data: img.toPNG() });
  }
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), pngs.find((p) => p.size === 256).data);
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), icoFrom(pngs));
  console.log('Icons written to assets/icon.png and build/icon.ico from assets/icon.svg');
  app.quit();
});
