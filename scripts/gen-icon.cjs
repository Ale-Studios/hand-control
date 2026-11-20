// Generates the app icon (assets/icon.png + build/icon.ico) without external tools.
const fs = require('fs');
const path = require('path');
const { pngFor, icoFrom } = require('../src/main/icons.cjs');

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, data: pngFor('brand', size) }));
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), pngFor('brand', 256));
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), icoFrom(pngs));
console.log('Icons written to assets/icon.png and build/icon.ico');
