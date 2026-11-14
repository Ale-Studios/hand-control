// Launches the end-to-end test in an ISOLATED profile: USERPROFILE, APPDATA and LOCALAPPDATA
// point to a temporary folder, so nothing personal is touched.
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
console.log('Isolated profile:', sandbox);
console.log('WARNING: for ~3 minutes a full-screen window will use the mouse by itself. Do not touch the mouse or keyboard.');
const child = spawn(electron, [path.join(__dirname, 'run.cjs'), ...process.argv.slice(2)], { env, stdio: 'inherit', cwd: root });
child.on('exit', (code) => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  process.exit(code ?? 1);
});
