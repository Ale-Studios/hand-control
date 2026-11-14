// Misura per 20 secondi con la fotocamera vera (profilo isolato, nessuna interfaccia da usare).
//   npm run bench:camera
// Accende la fotocamera (si vede la lucina), registra solo NUMERI (nessuna immagine) e si chiude.
// Durante la prova muovi la mano davanti alla fotocamera: indice, pizzico, mano aperta, ecc.
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
console.log('Misura con la fotocamera: 3 s di avvio + 20 s di registrazione. Muovi la mano davanti alla fotocamera.');
const child = spawn(electron, [root, '--bench', ...extra], { env, stdio: 'inherit', cwd: root });
child.on('exit', (code) => {
  const dir = path.join(sandbox, 'userdata', 'misure');
  if (process.env.HC_BENCH_KEEP && fs.existsSync(dir)) {
    const out = path.resolve(process.env.HC_BENCH_KEEP);
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(out, f));
  }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  process.exit(code ?? 0);
});
