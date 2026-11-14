// Crea l'app per Windows.
//   npm run build   → dist\win-unpacked\Hand Control.exe  (cartella pronta, senza installer)
//   npm run dist    → dist\Hand Control Setup x.y.z.exe   (installer NSIS)
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const installer = process.argv.includes('--installer');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`\nERRORE: "${cmd} ${args.join(' ')}" è fallito.`); process.exit(r.status || 1); }
};
run('node', ['scripts/vendor.cjs']);
run('node', ['scripts/gen-icon.cjs']);
run('npx', ['electron-builder', '--win', installer ? 'nsis' : 'dir', '--publish', 'never']);
console.log(installer ? '\nInstaller in dist\\' : '\nApp in dist\\win-unpacked\\Hand Control.exe');
