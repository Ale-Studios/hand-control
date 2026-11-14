// Lancia il test end-to-end in un profilo ISOLATO: USERPROFILE, APPDATA e LOCALAPPDATA
// puntano a una cartella temporanea, così non si tocca nulla di personale.
//   npm run test:e2e
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-e2e-'));
for (const d of ['home', 'appdata', 'local', 'userdata', 'temp']) fs.mkdirSync(path.join(sandbox, d));

const env = {
  ...process.env,
  USERPROFILE: path.join(sandbox, 'home'),
  HOME: path.join(sandbox, 'home'),
  APPDATA: path.join(sandbox, 'appdata'),
  LOCALAPPDATA: path.join(sandbox, 'local'),
  TEMP: path.join(sandbox, 'temp'),
  TMP: path.join(sandbox, 'temp'),
  HC_E2E: '1',
  HC_USER_DATA: path.join(sandbox, 'userdata'),
  HC_E2E_OUT: process.env.HC_E2E_OUT || path.join(root, 'test', 'e2e', 'last-results.json'),
};
delete env.ELECTRON_RUN_AS_NODE;

const electron = require(path.join(root, 'node_modules', 'electron'));
console.log('Profilo isolato:', sandbox);
console.log('ATTENZIONE: per ~1 minuto una finestra a tutto schermo userà il mouse da sola. Non toccare mouse e tastiera.');
const child = spawn(electron, [path.join(__dirname, 'run.cjs'), ...process.argv.slice(2)], { env, stdio: 'inherit', cwd: root });
child.on('exit', (code) => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  process.exit(code ?? 1);
});
