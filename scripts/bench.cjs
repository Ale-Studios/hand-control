// Measures for ~20 seconds with the real camera (isolated profile, no interface to use).
//   npm run bench:camera
// Turns the camera on (you will see its light), records only NUMBERS (never an image) and quits.
// During the test move your hand in front of the camera: index finger, pinch, open hand, etc.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-bench-'));
for (const d of ['home', 'appdata', 'local', 'userdata', 'temp']) fs.mkdirSync(path.join(sandbox, d));
const env = {
  ...process.env,
  USERPROFILE: path.join(sandbox, 'home'), HOME: path.join(sandbox, 'home'),
  APPDATA: path.join(sandbox, 'appdata'), LOCALAPPDATA: path.join(sandbox, 'local'),
  TEMP: path.join(sandbox, 'temp'), TMP: path.join(sandbox, 'temp'),
  HC_USER_DATA: path.join(sandbox, 'userdata'),
};
delete env.ELECTRON_RUN_AS_NODE;
const extra = process.argv.slice(2);
const electron = require(path.join(root, 'node_modules', 'electron'));
console.log('Camera benchmark: ~10 s start-up + 20 s recording. Move your hand in front of the camera.');
const child = spawn(electron, [root, '--bench', ...extra], { env, stdio: 'inherit', cwd: root });
child.on('exit', (code) => {
  const dir = path.join(sandbox, 'userdata', 'measurements');
  if (process.env.HC_BENCH_KEEP && fs.existsSync(dir)) {
    const out = path.resolve(process.env.HC_BENCH_KEEP);
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(out, f));
  }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  process.exit(code ?? 0);
});
