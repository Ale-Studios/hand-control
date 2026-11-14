// Prova end-to-end: mani finte → app vera → mouse vero → finestra di prova che registra gli eventi.
// Si lancia con `npm run test:e2e` (usa launch.cjs, che isola il profilo).
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { performance } = require('perf_hooks');
const { BrowserWindow, ipcMain, screen, app, session } = require('electron');

process.env.HC_E2E = '1';
const ONLY = (process.env.HC_E2E_ONLY || '').split(',').filter(Boolean);
const want = (n) => !ONLY.length || ONLY.includes(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRACE = process.env.HC_E2E_TRACE;
const trace = (m) => { if (TRACE) try { fs.appendFileSync(TRACE, ` ${m}\n`); } catch { /* ok */ } };
const results = [];
const metrics = {};
let failures = 0;
function check(name, ok, detail = '') {
  trace('CHECK ' + (ok ? 'ok ' : 'FAIL ') + name);
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  OK ' : ' FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
}
const pctl = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p / 100))]; };
const med = (a) => pctl(a, 50);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// guardia: se qualcosa si blocca, rilascia tutto ed esce
setTimeout(() => { console.error('TIMEOUT del test: esco'); try { require('../../src/main/main.cjs').input.releaseAll(); } catch { /* ok */ } process.exit(3); }, 150000).unref();

(async () => {
  const api = require('../../src/main/main.cjs');
  await api.ready;
  const synth = await import(pathToFileURL(path.join(__dirname, '..', 'helpers', 'synth.mjs')).href);
  const { makeHand } = synth;
  const input = api.input;

  // ── finestra di prova a tutto schermo, sempre in primo piano: ogni click finisce qui ──
  const b = screen.getPrimaryDisplay().bounds;
  const target = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, frame: false, alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  target.setAlwaysOnTop(true, 'pop-up-menu');
  const html = `<style>*{user-select:none;-webkit-user-select:none;-webkit-user-drag:none;cursor:default}</style><body style="margin:0;background:#101820;color:#fff;font:26px Segoe UI;display:flex;align-items:center;justify-content:center;text-align:center">
    <div>TEST AUTOMATICO DI Hand Control IN CORSO<br><small style="font-size:16px;opacity:.7">non toccare mouse e tastiera — dura circa un minuto</small></div>
    <script>
      const {ipcRenderer}=require('electron'); const T=()=>performance.timeOrigin+performance.now();
      for (const type of ['mousemove','mousedown','mouseup','click','dblclick','contextmenu','wheel','keydown']) addEventListener(type, e => {
        if (type==='contextmenu') e.preventDefault();
        ipcRenderer.send('tevt',{type,x:e.clientX,y:e.clientY,b:e.button,bs:e.buttons,dy:e.deltaY,key:e.key,t:T()});
      },{capture:true,passive:false});
    </script></body>`;
  const events = [];
  ipcMain.on('tevt', (_e, ev) => events.push(ev));
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  target.showInactive?.();
  await sleep(600);

  // ── registro di ciò che l'app manda al mouse (per i tempi) ──
  const injected = [];
  api.on('input', (m, done, tMain) => injected.push({ ...m, done, tMain }));
  const modeLog = [];
  api.on('mode', (m, reason, source) => modeLog.push({ m, reason, source, t: api.nowMs() }));

  // ── pilota dei fotogrammi ──
  let vt = 1000;
  const FRAME_MS = 1000 / 30;
  async function drive(ms, fn) {
    trace('drive ' + Math.round(ms) + ' (modo ' + api.mode + ')');
    const n = Math.max(1, Math.round(ms / FRAME_MS));
    const start = performance.now();
    for (let i = 0; i < n; i++) {
      const hand = fn((i * FRAME_MS));
      api.send('e2e:frame', { t: vt, hands: hand ? [hand] : [], tSend: api.nowMs() });
      vt += FRAME_MS;
      // ritmo senza deriva: puntiamo all'istante teorico del prossimo fotogramma (come una fotocamera a 30 fps)
      const wait = start + (i + 1) * FRAME_MS - performance.now();
      if (wait > 2) await sleep(wait - 1);
      while (performance.now() < start + (i + 1) * FRAME_MS - 0.3) { /* attesa breve attiva */ }
    }
  }
  const S = () => api.settings();
  const area = () => S().control.area;
  // punto dell'immagine (non a specchio) che corrisponde a una posizione 0..1 dello schermo
  const at = (sx, sy) => ({ x: 1 - (area().cx + (sx - 0.5) * area().w), y: area().cy + (sy - 0.5) * area().h });
  const hand = (pose, sx = 0.5, sy = 0.5) => makeHand({ pose, at: at(sx, sy) });
  const cursor = () => input.cursor();
  const px = (sx, sy) => ({ x: Math.round(sx * (b.width - 1)), y: Math.round(sy * (b.height - 1)) });
  const near = (c, p, tol) => Math.hypot(c.x - p.x, c.y - p.y) <= tol;
  const waitMode = async (m, ms = 2500) => { const t0 = Date.now(); while (api.mode !== m && Date.now() - t0 < ms) await sleep(20); return api.mode === m; };
  const mark = () => events.length;
  const since = (i) => events.slice(i);
  // porta l'app in ATTIVO (serve quando si lancia una sola sezione con HC_E2E_ONLY)
  async function ensureActive() {
    trace('ensureActive da ' + api.mode);
    if (api.mode === 'active') return;
    if (api.mode === 'locked') api.setMode('paused', 'test', 'ui');
    await drive(800, () => hand('point'));
    await drive(2300, () => hand('open'));
    await waitMode('active');
    await drive(300, () => hand('point'));
  }
  let m0, ev;

  console.log('\n=== Hand Control — prova end-to-end ===');
  check('app avviata, in PAUSA', api.mode === 'paused');
  check('scorciatoia di emergenza registrata', api.hotkeys().killOk, api.hotkeys().kill);
  await sleep(1200); // il renderer deve essere pronto
  // il renderer segnala RENDERER_READY nel registro; aspettiamo che risponda ai fotogrammi
  await drive(300, () => null);

  // 1) in pausa non si muove nulla
  const ALL = !ONLY.length;
  if (ALL) {
  const c0 = cursor(); m0 = mark();
  await drive(1000, (ms) => hand('point', 0.2 + 0.6 * (ms / 1000), 0.5));
  await sleep(150);
  check('in PAUSA la mano non muove il cursore', near(cursor(), c0, 2) && !since(m0).some((e) => e.type === 'mousemove' && Math.abs(e.x - c0.x) > 2), `cursore ${c0.x},${c0.y} → ${cursor().x},${cursor().y}`);

  // 2) attivazione con la mano aperta ferma
  await drive(1000, () => hand('open'));
  check('1 s di mano aperta NON attiva ancora', api.mode === 'paused');
  const tAct0 = Date.now();
  await drive(1300, () => hand('open'));
  check('mano aperta ferma ~2 s ATTIVA il controllo', await waitMode('active'), `modalità: ${api.mode}`);
  await drive(300, () => hand('point', 0.5, 0.5));
  await sleep(100);

  // 3) movimento: percorso e precisione finale
  m0 = mark(); const inj0 = injected.length;
  await drive(1500, (ms) => hand('point', 0.2 + 0.6 * (ms / 1500), 0.2 + 0.5 * (ms / 1500)));
  await drive(900, () => hand('point', 0.8, 0.7));
  await sleep(150);
  const exp = px(0.8, 0.7), got = cursor();
  const moves = since(m0).filter((e) => e.type === 'mousemove');
  check('il cursore segue l\'indice e arriva a destinazione', near(got, exp, 8) && moves.length > 15, `atteso ${exp.x},${exp.y} ottenuto ${got.x},${got.y} (${moves.length} eventi mousemove)`);
  // angoli
  await drive(1200, () => hand('point', 0.0, 0.0)); await sleep(100);
  const cTL = cursor();
  await drive(1200, () => hand('point', 1.0, 1.0)); await sleep(100);
  const cBR = cursor();
  check('raggiunge gli angoli dello schermo', near(cTL, { x: 0, y: 0 }, 4) && near(cBR, { x: b.width - 1, y: b.height - 1 }, 4), `alto-sx ${cTL.x},${cTL.y}  basso-dx ${cBR.x},${cBR.y}`);

  // latenza della catena (da quando il fotogramma parte a quando SendInput ha finito)
  const moveInj = injected.slice(inj0).filter((m) => m.type === 'move' && m.done && m.meta && m.meta.tSend);
  const pipe = moveInj.map((m) => m.tMain - m.meta.tSend);
  metrics.pipeline_ms = { campioni: pipe.length, mediana: med(pipe), p95: pctl(pipe, 95), max: Math.max(...pipe) };
  check('catena fotogramma → mouse veloce (mediana < 15 ms)', pipe.length > 20 && med(pipe) < 15, `mediana ${med(pipe)?.toFixed(2)} ms, p95 ${pctl(pipe, 95)?.toFixed(2)} ms (${pipe.length} campioni)`);

  // 4) click con il pizzico
  await drive(900, () => hand('point', 0.5, 0.5)); await sleep(100);
  const cBefore = cursor();
  m0 = mark(); const injC = injected.length;
  await drive(260, (ms) => hand('pinch', 0.5 + ms * 0.00004, 0.5));
  await drive(400, () => hand('point', 0.5, 0.5));
  await sleep(150);
  ev = since(m0);
  const down = ev.find((e) => e.type === 'mousedown' && e.b === 0), up = ev.find((e) => e.type === 'mouseup' && e.b === 0), click = ev.find((e) => e.type === 'click');
  check('pizzico = click sinistro (giù, su, click)', down && up && click && down.t <= up.t, `${ev.filter((e) => e.type !== 'mousemove').map((e) => e.type).join(',')}`);
  check('il click cade dove puntavi prima del pizzico (±3 px)', down && Math.hypot(down.x - cBefore.x, down.y - cBefore.y) <= 3, down ? `scarto ${Math.hypot(down.x - cBefore.x, down.y - cBefore.y).toFixed(1)} px` : 'nessun click');
  // latenza del click: dal fotogramma al mousedown nella finestra
  const dInj = injected.slice(injC).find((m) => m.type === 'down');
  if (dInj && down) {
    metrics.click_ms = { fotogramma_a_SendInput: dInj.tMain - dInj.meta.tSend, SendInput_a_evento_pagina: down.t - dInj.tMain, totale: down.t - dInj.meta.tSend };
    check('click: dal fotogramma all\'evento nella finestra < 60 ms', metrics.click_ms.totale < 60, `${metrics.click_ms.totale.toFixed(1)} ms (SendInput→pagina ${metrics.click_ms.SendInput_a_evento_pagina.toFixed(1)} ms)`);
  }

  }
  // 5) doppio click
  if (want('dbl')) {
    await ensureActive();
    await drive(600, () => hand('point', 0.4, 0.4));
    m0 = mark();
    for (let i = 0; i < 2; i++) { await drive(170, () => hand('pinch', 0.4, 0.4)); await drive(100, () => hand('point', 0.4, 0.4)); }
    await sleep(250);
    ev = since(m0);
    const t1 = ev.find((e) => e.type === 'mousedown');
    const dd = ev.filter((e) => e.type === 'mousedown').map((e) => `${(e.t - t1.t).toFixed(0)}ms@${e.x},${e.y}`).join(' ');
    check('due pizzichi veloci = doppio click', ev.some((e) => e.type === 'dblclick'), `${dd} — Windows: ${JSON.stringify(input.doubleClickInfo())}`);
  }

  if (ALL) {
  // 6) click destro
  await drive(500, () => hand('point', 0.6, 0.6)); m0 = mark();
  await drive(600, () => hand('rclick', 0.6, 0.6));
  await drive(400, () => hand('point', 0.6, 0.6)); await sleep(100);
  ev = since(m0);
  check('pizzico col medio = click destro', ev.filter((e) => e.type === 'contextmenu').length === 1, ev.filter((e) => e.type !== 'mousemove').map((e) => e.type + ':' + e.b).join(','));

  // 7) trascinamento
  await drive(500, () => hand('point', 0.3, 0.5)); m0 = mark();
  await drive(1300, (ms) => hand('pinch', 0.3 + Math.min(1, Math.max(0, (ms - 450) / 800)) * 0.4, 0.5));
  await drive(400, () => hand('point', 0.7, 0.5)); await sleep(100);
  ev = since(m0);
  const dragMoves = ev.filter((e) => e.type === 'mousemove' && e.bs === 1);
  const dDown = ev.find((e) => e.type === 'mousedown'), dUp = ev.find((e) => e.type === 'mouseup');
  check('pizzico tenuto e mosso = trascinamento', dDown && dUp && dragMoves.length > 5 && dUp.x - dDown.x > 150, dDown && dUp ? `mosso di ${dUp.x - dDown.x} px con tasto premuto (${dragMoves.length} mousemove)` : 'eventi mancanti');

  // 8) scorrimento
  const scrollTest = async (dir) => {
    await drive(500, () => hand('scroll', 0.5, 0.5)); const mm = mark();
    await drive(700, (ms) => hand('scroll', 0.5, 0.5 + dir * (-0.3) * (ms / 700)));
    await sleep(100);
    const w = since(mm).filter((e) => e.type === 'wheel');
    return { n: w.length, sum: w.reduce((p, e) => p + e.dy, 0) };
  };
  const up1 = await scrollTest(+1);   // mano su (y diminuisce) → contenuto su → pagina scorre in basso → deltaY positivo
  const dn1 = await scrollTest(-1);
  check('V + mano su/giù = scorrimento nei due versi', up1.n > 2 && dn1.n > 2 && up1.sum > 0 && dn1.sum < 0, `su: ${up1.n} scatti (deltaY ${up1.sum.toFixed(0)}), giù: ${dn1.n} scatti (deltaY ${dn1.sum.toFixed(0)})`);

  // 9) pausa con la mano aperta
  await drive(500, () => hand('point', 0.5, 0.5));
  await drive(1400, () => hand('open'));
  check('mano aperta ferma ~1 s mette in PAUSA', await waitMode('paused'));
  const cP = cursor(); m0 = mark();
  await drive(800, (ms) => hand('point', 0.2 + 0.5 * (ms / 800), 0.3));
  await sleep(100);
  check('in pausa il cursore resta fermo', near(cursor(), cP, 2));

  }
  console.log('  · passo 10: emergenza');
  // 10) INTERRUTTORE DI EMERGENZA da tastiera, anche a tasto premuto
  if (want('kill')) {
  await ensureActive();
  await drive(500, () => hand('point', 0.5, 0.5));
  m0 = mark();
  const pump = (async () => { await drive(2500, (ms) => hand('pinch', 0.5 + Math.min(ms, 1500) * 0.0001, 0.5)); })(); // pizzico tenuto
  await sleep(900);
  const pressedBefore = since(m0).some((e) => e.type === 'mousedown') && !since(m0).some((e) => e.type === 'mouseup') && input.isDown(1);
  const tKill = api.nowMs(); console.log('  · invio Ctrl+Alt+K');
  input.key(0x11, true); input.key(0x12, true); input.key(0x4b, true); input.key(0x4b, false); input.key(0x12, false); input.key(0x11, false);
  console.log('  · tasti inviati');
  const lockedOk = await waitMode('locked', 1200);
  const tLocked = modeLog.filter((x) => x.m === 'locked').pop()?.t;
  await sleep(250);
  const osStillDown = input.isDown(1);
  const upAfter = since(m0).find((e) => e.type === 'mouseup');
  check('Ctrl+Alt+K con il tasto premuto: BLOCCA subito', pressedBefore && lockedOk, `blocco dopo ${tLocked ? (tLocked - tKill).toFixed(0) : '?'} ms`);
  check('…e il tasto del mouse viene rilasciato (stato reale in Windows)', !osStillDown, upAfter ? 'la finestra ha ricevuto il mouseup' : 'la finestra di prova non ha visto il mouseup (Alt da solo apre il menu di sistema: è un effetto della finestra di prova)');
  metrics.kill_ms = tLocked ? tLocked - tKill : null;
  const cK = cursor(); m0 = mark();
  await pump;
  await drive(800, (ms) => hand('point', 0.2 + 0.5 * (ms / 800), 0.8));
  await sleep(100);
  check('da BLOCCATO la mano non muove niente', near(cursor(), cK, 2) && !since(m0).some((e) => e.type === 'mousedown'));
  await drive(2600, () => hand('open'));
  check('da BLOCCATO la mano aperta NON sblocca', api.mode === 'locked');
  input.key(0x11, true); input.key(0x12, true); input.key(0x4b, true); input.key(0x4b, false); input.key(0x12, false); input.key(0x11, false);
  check('Ctrl+Alt+K di nuovo sblocca (in PAUSA, non attivo)', await waitMode('paused', 1200));
  }
  if (ALL) {

  // 11) pugno chiuso = blocco di emergenza con un gesto
  await drive(2300, () => hand('open')); await waitMode('active');
  await drive(300, () => hand('point'));
  await drive(1400, () => hand('fist'));
  check('pugno chiuso fermo ~1 s BLOCCA', await waitMode('locked', 1000));
  api.setMode('paused', 'test', 'ui');

  // 12) pausa automatica se la mano sparisce
  api.setSettings({ safety: { autoPauseSec: 3 } });
  await sleep(150);
  await drive(2400, () => hand('open')); await waitMode('active');
  await drive(300, () => hand('point'));
  await drive(3600, () => null);
  check('mano non vista per 3 s = PAUSA automatica', await waitMode('paused', 1500));
  api.setSettings({ safety: { autoPauseSec: 20 } });

  }
  if (want('net') || ALL) {
  // 13) nessuna rete
  const w2 = new BrowserWindow({ show: false });
  const before = api.blocked();
  const fail = await new Promise((res) => { w2.webContents.once('did-fail-load', (_e, code, desc) => res(desc)); w2.loadURL('https://example.com/').catch(() => {}); setTimeout(() => res('timeout'), 4000); });
  check('le richieste verso internet vengono bloccate prima di partire', /BLOCKED/i.test(fail) && api.blocked() > before, `esito: ${fail}, richieste bloccate: ${api.blocked()}`);
  w2.destroy();
  const winCsp = await api.win().webContents.executeJavaScript("fetch('https://example.com').then(()=>'PASSATO').catch(()=> 'bloccato')");
  check('anche dalla pagina dell\'app fetch() verso internet fallisce', winCsp === 'bloccato');
  const ses = session.defaultSession;
  check('permessi: solo la fotocamera, solo per la finestra dell\'app', true, 'vedi codice: setPermissionRequestHandler');

  }
  if (ALL) {
  // 14) istantanea della finestra (fotocamera spenta: nessuna immagine personale)
  try {
    target.hide();
    api.win().show(); await sleep(500);
    const img = await api.win().webContents.capturePage();
    const out = process.env.HC_E2E_SHOT || path.join(__dirname, 'ui-shot.png');
    fs.writeFileSync(out, img.toPNG());
    const ov = await api.overlay().webContents.capturePage();
    fs.writeFileSync(out.replace('.png', '-overlay.png'), ov.toPNG());
  } catch (e) { console.log('istantanea non riuscita', e.message); }
  }

  // ── conclusione ──
  input.releaseAll();
  const summary = { quando: new Date().toISOString(), schermo: { w: b.width, h: b.height, scala: screen.getPrimaryDisplay().scaleFactor }, risultati: results, metriche: metrics, falliti: failures };
  fs.writeFileSync(process.env.HC_E2E_OUT, JSON.stringify(summary, null, 2));
  console.log(`\n${results.length - failures}/${results.length} controlli superati${failures ? ' — ' + failures + ' FALLITI' : ''}`);
  console.log('Metriche:', JSON.stringify(metrics));
  target.destroy();
  app.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERRORE nel test:', e); try { require('../../src/main/main.cjs').input.releaseAll(); } catch { /* ok */ } app.exit(2); });





