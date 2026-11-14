// Copia MediaPipe (motore + file wasm) dentro src/renderer/vendor, così l'app
// non scarica NULLA da internet quando gira: tutto è in locale.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const dst = path.join(root, 'src', 'renderer', 'vendor');

if (!fs.existsSync(src)) {
  console.log('[vendor] @mediapipe/tasks-vision non installato: salto (esegui `npm install`).');
  process.exit(0);
}
fs.mkdirSync(path.join(dst, 'wasm'), { recursive: true });
fs.copyFileSync(path.join(src, 'vision_bundle.mjs'), path.join(dst, 'vision_bundle.mjs'));
for (const f of fs.readdirSync(path.join(src, 'wasm'))) {
  fs.copyFileSync(path.join(src, 'wasm', f), path.join(dst, 'wasm', f));
}
console.log('[vendor] MediaPipe copiato in src/renderer/vendor');
