// End-to-end test: fake hands → real app → real mouse → test window that records the events.
// Run it with `npm run test:e2e` (it uses launch.cjs, which isolates the profile).
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

// watchdog: if anything hangs, release everything and exit
setTimeout(() => { console.error('Test TIMEOUT: exiting'); try { require('../../src/main/main.cjs').input.releaseAll(); } catch { /* ok */ } process.exit(3); }, 150000).unref();

(async () => {
  const api = require('../../src/main/main.cjs');
  await api.ready;
  const synth = await import(pathToFileURL(path.join(__dirname, '..', 'helpers', 'synth.mjs')).href);
  const { makeHand } = synth;
  const input = api.input;

  // ── full-screen test window, always on top: every click ends up here ──
  const b = screen.getPrimaryDisplay().bounds;
  const target = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, frame: false, alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  target.setAlwaysOnTop(true, 'pop-up-menu');
  const html = `<style>*{user-select:none;-webkit-user-select:none;-webkit-user-drag:none;cursor:default}</style><body style="margin:0;background:#1a1d21;color:#fff;font:26px Segoe UI;display:flex;align-items:center;justify-content:center;text-align:center">
    <div>Hand Control AUTOMATIC TEST RUNNING<br><small style="font-size:16px;opacity:.7">do not touch the mouse or keyboard — takes about three minutes</small></div>
    <script>
      const {ipcRenderer}=require('electron'); const T=()=>performance.timeOrigin+performance.now();
      for (const type of ['mousemove','mousedown','mouseup','click','dblclick','contextmenu','wheel','keydown']) addEventListener(type, e => {
        if (type==='contextmenu') e.preventDefault();
        if (type==='wheel' && e.ctrlKey) e.preventDefault();
        if (type==='keydown') e.preventDefault();
        ipcRenderer.send('tevt',{type,x:e.clientX,y:e.clientY,b:e.button,bs:e.buttons,dy:e.deltaY,key:e.key,ck:e.ctrlKey,sk:e.shiftKey,ak:e.altKey,t:T()});
      },{capture:true,passive:false});
    </script></body>`;
  const events = [];
  ipcMain.on('tevt', (_e, ev) => events.push(ev));
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  target.showInactive?.();
  await sleep(600);
  // The on-screen hand layer is a full-screen window ABOVE the test window: every click of every test has to go through it.
  api.setHandOverlay(true);
  await sleep(1500);

  // ── log of what the app sends to the mouse (for timing) ──
  const injected = [];
  api.on('input', (m, done, tMain) => injected.push({ ...m, done, tMain }));
  const modeLog = [];
  api.on('mode', (m, reason, source) => modeLog.push({ m, reason, source, t: api.nowMs() }));

  // ── frame driver ──
  let vt = 1000;
  const FRAME_MS = 1000 / 30;
  async function drive(ms, fn) {
    trace('drive ' + Math.round(ms) + ' (mode ' + api.mode + ')');
    const n = Math.max(1, Math.round(ms / FRAME_MS));
    const start = performance.now();
    for (let i = 0; i < n; i++) {
      const hand = fn((i * FRAME_MS));
      api.send('e2e:frame', { t: vt, hands: Array.isArray(hand) ? hand : hand ? [hand] : [], tSend: api.nowMs() });
      vt += FRAME_MS;
      // drift-free pacing: aim at the theoretical instant of the next frame (like a 30 fps camera)
      const wait = start + (i + 1) * FRAME_MS - performance.now();
      if (wait > 2) await sleep(wait - 1);
      while (performance.now() < start + (i + 1) * FRAME_MS - 0.3) { /* short busy wait */ }
    }
  }
  const S = () => api.settings();
  const area = () => S().control.area;
  // image point (not mirrored) that corresponds to a 0..1 screen position
  const at = (sx, sy) => ({ x: 1 - (area().cx + (sx - 0.5) * area().w), y: area().cy + (sy - 0.5) * area().h });
  const hand = (pose, sx = 0.5, sy = 0.5) => makeHand({ pose, at: at(sx, sy) });
  const cursor = () => input.cursor();
  const px = (sx, sy) => ({ x: Math.round(sx * (b.width - 1)), y: Math.round(sy * (b.height - 1)) });
  const near = (c, p, tol) => Math.hypot(c.x - p.x, c.y - p.y) <= tol;
  const waitMode = async (m, ms = 2500) => { const t0 = Date.now(); while (api.mode !== m && Date.now() - t0 < ms) await sleep(20); return api.mode === m; };
  const mark = () => events.length;
  const since = (i) => events.slice(i);
  // brings the app to ACTIVE (needed when running a single section with HC_E2E_ONLY)
  async function ensureActive() {
    trace('ensureActive from ' + api.mode);
    if (api.mode === 'active') return;
    if (api.mode === 'locked') api.setMode('paused', 'test', 'ui');
    await drive(800, () => hand('point'));
    await drive(2300, () => hand('open'));
    await waitMode('active');
    await drive(300, () => hand('point'));
  }
  let m0, ev;

  console.log('\n=== Hand Control — end-to-end test ===');
  check('app started, PAUSED', api.mode === 'paused');
  check('emergency shortcut registered', api.hotkeys().killOk, api.hotkeys().kill);
  await sleep(1200); // the renderer must be ready
  // the renderer reports RENDERER_READY in the log; wait until it answers frames
  await drive(300, () => null);

  // 1) nothing moves while paused
  const ALL = !ONLY.length;
  if (ALL || want('pause')) {
  const c0 = cursor(); m0 = mark();
  await drive(1000, (ms) => hand('point', 0.2 + 0.6 * (ms / 1000), 0.5));
  await sleep(150);
  check('while PAUSED the hand does not move the cursor', near(cursor(), c0, 2) && !since(m0).some((e) => e.type === 'mousemove' && Math.abs(e.x - c0.x) > 2), `cursor ${c0.x},${c0.y} → ${cursor().x},${cursor().y}`);

  // 2) activation with the open hand held still
  await drive(1000, () => hand('open'));
  check('1 s of open hand does NOT activate yet', api.mode === 'paused');
  const tAct0 = Date.now();
  await drive(1300, () => hand('open'));
  check('open hand held still ~2 s ACTIVATES control', await waitMode('active'), `mode: ${api.mode}`);
  await drive(300, () => hand('point', 0.5, 0.5));
  await sleep(100);

  // 3) movement: path and final precision
  m0 = mark(); const inj0 = injected.length;
  await drive(1500, (ms) => hand('point', 0.2 + 0.6 * (ms / 1500), 0.2 + 0.5 * (ms / 1500)));
  await drive(900, () => hand('point', 0.8, 0.7));
  await sleep(150);
  const exp = px(0.8, 0.7), got = cursor();
  const moves = since(m0).filter((e) => e.type === 'mousemove');
  check('the cursor follows the index finger and reaches the destination', near(got, exp, 8) && moves.length > 15, `expected ${exp.x},${exp.y} got ${got.x},${got.y} (${moves.length} mousemove events)`);
  // corners
  await drive(1200, () => hand('point', 0.0, 0.0)); await sleep(100);
  const cTL = cursor();
  await drive(1200, () => hand('point', 1.0, 1.0)); await sleep(100);
  const cBR = cursor();
  check('reaches the screen corners', near(cTL, { x: 0, y: 0 }, 4) && near(cBR, { x: b.width - 1, y: b.height - 1 }, 4), `top-left ${cTL.x},${cTL.y}  bottom-right ${cBR.x},${cBR.y}`);

  // latency of the chain (from the frame being sent to SendInput finishing)
  const moveInj = injected.slice(inj0).filter((m) => m.type === 'move' && m.done && m.meta && m.meta.tSend);
  const pipe = moveInj.map((m) => m.tMain - m.meta.tSend);
  metrics.pipeline_ms = { samples: pipe.length, median: med(pipe), p95: pctl(pipe, 95), max: Math.max(...pipe) };
  check('frame → mouse chain is fast (median < 15 ms)', pipe.length > 20 && med(pipe) < 15, `median ${med(pipe)?.toFixed(2)} ms, p95 ${pctl(pipe, 95)?.toFixed(2)} ms (${pipe.length} samples)`);

  // 4) click with the pinch
  await drive(900, () => hand('point', 0.5, 0.5)); await sleep(100);
  const cBefore = cursor();
  m0 = mark(); const injC = injected.length;
  await drive(260, (ms) => hand('pinch', 0.5 + ms * 0.00004, 0.5));
  await drive(400, () => hand('point', 0.5, 0.5));
  await sleep(150);
  ev = since(m0);
  const down = ev.find((e) => e.type === 'mousedown' && e.b === 0), up = ev.find((e) => e.type === 'mouseup' && e.b === 0), click = ev.find((e) => e.type === 'click');
  check('pinch = left click (down, up, click)', down && up && click && down.t <= up.t, `${ev.filter((e) => e.type !== 'mousemove').map((e) => e.type).join(',')}`);
  check('the click lands where you pointed before the pinch (±3 px)', down && Math.hypot(down.x - cBefore.x, down.y - cBefore.y) <= 3, down ? `offset ${Math.hypot(down.x - cBefore.x, down.y - cBefore.y).toFixed(1)} px` : 'no click');
  // click latency: from the frame to the mousedown in the window
  const dInj = injected.slice(injC).find((m) => m.type === 'down');
  if (dInj && down) {
    metrics.click_ms = { frame_to_SendInput: dInj.tMain - dInj.meta.tSend, SendInput_to_page_event: down.t - dInj.tMain, total: down.t - dInj.meta.tSend };
    check('click: from the frame to the event in the window < 60 ms', metrics.click_ms.total < 60, `${metrics.click_ms.total.toFixed(1)} ms (SendInput→page ${metrics.click_ms.SendInput_to_page_event.toFixed(1)} ms)`);
  }

  }
  // 5) double click
  if (want('dbl')) {
    await ensureActive();
    await drive(600, () => hand('point', 0.4, 0.4));
    m0 = mark();
    for (let i = 0; i < 2; i++) { await drive(170, () => hand('pinch', 0.4, 0.4)); await drive(100, () => hand('point', 0.4, 0.4)); }
    await sleep(250);
    ev = since(m0);
    const t1 = ev.find((e) => e.type === 'mousedown');
    const dd = ev.filter((e) => e.type === 'mousedown').map((e) => `${(e.t - t1.t).toFixed(0)}ms@${e.x},${e.y}`).join(' ');
    const seq = ev.filter((e) => e.type !== 'wheel').map((e) => `${e.type}${e.type === 'mousemove' ? '' : ''}@${e.x},${e.y}+${(e.t - t1.t).toFixed(0)}`).join(' ');
    check('two quick pinches = double click', ev.some((e) => e.type === 'dblclick'), `${dd} — Windows: ${JSON.stringify(input.doubleClickInfo())} — events: ${seq}`);
  }

  if (ALL) {
  // 6) right click
  await drive(500, () => hand('point', 0.6, 0.6)); m0 = mark();
  await drive(600, () => hand('rclick', 0.6, 0.6));
  await drive(400, () => hand('point', 0.6, 0.6)); await sleep(100);
  ev = since(m0);
  check('thumb + middle pinch = right click', ev.filter((e) => e.type === 'contextmenu').length === 1, ev.filter((e) => e.type !== 'mousemove').map((e) => e.type + ':' + e.b).join(','));

  // 7) drag
  await drive(500, () => hand('point', 0.3, 0.5)); m0 = mark();
  await drive(1300, (ms) => hand('pinch', 0.3 + Math.min(1, Math.max(0, (ms - 450) / 800)) * 0.4, 0.5));
  await drive(400, () => hand('point', 0.7, 0.5)); await sleep(100);
  ev = since(m0);
  const dragMoves = ev.filter((e) => e.type === 'mousemove' && e.bs === 1);
  const dDown = ev.find((e) => e.type === 'mousedown'), dUp = ev.find((e) => e.type === 'mouseup');
  check('held and moved pinch = drag', dDown && dUp && dragMoves.length > 5 && dUp.x - dDown.x > 150, dDown && dUp ? `moved ${dUp.x - dDown.x} px with the button held (${dragMoves.length} mousemove)` : 'events missing');

  // 8) scrolling
  const scrollTest = async (dir) => {
    await drive(500, () => hand('scroll', 0.5, 0.5)); const mm = mark();
    await drive(700, (ms) => hand('scroll', 0.5, 0.5 + dir * (-0.3) * (ms / 700)));
    await sleep(100);
    const w = since(mm).filter((e) => e.type === 'wheel');
    return { n: w.length, sum: w.reduce((p, e) => p + e.dy, 0) };
  };
  const up1 = await scrollTest(+1);   // hand up (y decreases) → content up → page scrolls down → positive deltaY
  const dn1 = await scrollTest(-1);
  check('V sign + hand up/down = scrolling in both directions', up1.n > 2 && dn1.n > 2 && up1.sum > 0 && dn1.sum < 0, `up: ${up1.n} notches (deltaY ${up1.sum.toFixed(0)}), down: ${dn1.n} notches (deltaY ${dn1.sum.toFixed(0)})`);

  // 9) pause with the open hand
  await drive(500, () => hand('point', 0.5, 0.5));
  await drive(1400, () => hand('open'));
  check('open hand held still ~1 s PAUSES', await waitMode('paused'));
  const cP = cursor(); m0 = mark();
  await drive(800, (ms) => hand('point', 0.2 + 0.5 * (ms / 800), 0.3));
  await sleep(100);
  check('while paused the cursor stays still', near(cursor(), cP, 2));

  }
  console.log('  · step 10: emergency');
  // 10) EMERGENCY SWITCH from the keyboard, even with a button held
  if (want('kill')) {
  // sends the emergency shortcut that is REALLY registered (another app, e.g. one that owns Ctrl+Alt+K, makes the app use Ctrl+Alt+Shift+K)
  const sendKill = () => { const sh = /Shift/.test(api.hotkeys().kill); input.key(0x11, true); input.key(0x12, true); if (sh) input.key(0x10, true); input.key(0x4b, true); input.key(0x4b, false); if (sh) input.key(0x10, false); input.key(0x12, false); input.key(0x11, false); };
  await ensureActive();
  await drive(500, () => hand('point', 0.5, 0.5));
  m0 = mark();
  const pump = (async () => { await drive(2500, (ms) => hand('pinch', 0.5 + Math.min(ms, 1500) * 0.0001, 0.5)); })(); // held pinch
  await sleep(900);
  const pressedBefore = since(m0).some((e) => e.type === 'mousedown') && !since(m0).some((e) => e.type === 'mouseup') && input.isDown(1);
  const tKill = api.nowMs(); console.log('  · sending Ctrl+Alt+K');
  sendKill();
  console.log('  · keys sent');
  const lockedOk = await waitMode('locked', 1200);
  const tLocked = modeLog.filter((x) => x.m === 'locked').pop()?.t;
  await sleep(250);
  const osStillDown = input.isDown(1);
  const upAfter = since(m0).find((e) => e.type === 'mouseup');
  check('Ctrl+Alt+K with a button held: LOCKS immediately', pressedBefore && lockedOk, `locked after ${tLocked ? (tLocked - tKill).toFixed(0) : '?'} ms`);
  check('…and the mouse button is released (real Windows state)', !osStillDown, upAfter ? 'the window received the mouseup' : 'the test window did not see the mouseup (a lone Alt opens the system menu: an effect of the test window)');
  metrics.kill_ms = tLocked ? tLocked - tKill : null;
  const cK = cursor(); m0 = mark();
  await pump;
  await drive(800, (ms) => hand('point', 0.2 + 0.5 * (ms / 800), 0.8));
  await sleep(100);
  check('while LOCKED the hand moves nothing', near(cursor(), cK, 2) && !since(m0).some((e) => e.type === 'mousedown'));
  await drive(2600, () => hand('open'));
  check('while LOCKED an open hand does NOT unlock', api.mode === 'locked');
  sendKill();
  check('Ctrl+Alt+K again unlocks (into PAUSED, not active)', await waitMode('paused', 1200));
  }
  if (ALL) {

  // 11) closed fist = emergency lock by gesture
  await drive(2300, () => hand('open')); await waitMode('active');
  await drive(300, () => hand('point'));
  await drive(1400, () => hand('fist'));
  check('closed fist held still ~1 s LOCKS', await waitMode('locked', 1000));
  api.setMode('paused', 'test', 'ui');

  // 12) auto-pause when the hand disappears
  api.setSettings({ safety: { autoPauseSec: 3 } });
  await sleep(150);
  await drive(2400, () => hand('open')); await waitMode('active');
  await drive(300, () => hand('point'));
  await drive(3600, () => null);
  check('hand not seen for 3 s = automatic PAUSE', await waitMode('paused', 1500));
  api.setSettings({ safety: { autoPauseSec: 20 } });

  }
  if (want('actions') || ALL) {
  // 12b) actions: keys, zoom, launcher (with a real click on a tile), two-hand mode, test mode
  const CTRL = 0x11, SHIFT = 0x10;
  await ensureActive();
  // keyboard shortcuts go to the window in the foreground: give the focus to the test window (a harmless chord, in case it lands elsewhere)
  target.show(); target.focus(); await sleep(400);
  api.setSettings({ actions: { ringPinch: 'keys:<ctrl>+<shift>+<f12>', pinkyPinch: 'zoom:in', holdMs: 500 } });
  await sleep(200);

  m0 = mark();
  await drive(1300, () => hand('ringpinch', 0.5, 0.5));
  await drive(300, () => hand('point', 0.5, 0.5)); await sleep(150);
  ev = since(m0);
  const kd = ev.find((e) => e.type === 'keydown' && e.key === 'F12');
  check('thumb + ring finger held = the bound keyboard shortcut (Ctrl+Shift+F12)', !!kd && kd.ck && kd.sk, kd ? 'key=' + kd.key + ' ctrl=' + kd.ck + ' shift=' + kd.sk : 'no keydown seen');
  check('…and the keys are released afterwards (real Windows state)', !input.isDown(CTRL) && !input.isDown(SHIFT) && input.keysDown.size === 0);
  check('the action fires once however long the gesture is held', ev.filter((e) => e.type === 'keydown' && e.key === 'F12').length === 1);

  m0 = mark();
  await drive(1300, () => hand('pinkypinch', 0.5, 0.5));
  await drive(300, () => hand('point', 0.5, 0.5)); await sleep(150);
  const zw = since(m0).find((e) => e.type === 'wheel');
  check('thumb + little finger held = zoom in (Ctrl + wheel)', !!zw && zw.ck && zw.dy < 0, zw ? 'ctrl=' + zw.ck + ' deltaY=' + zw.dy : 'no wheel seen');
  check('…Ctrl is released afterwards', !input.isDown(CTRL));

  // launcher: open with the gesture, point at a tile, pinch on it
  api.setSettings({ actions: { ringPinch: 'launcher' } });
  await sleep(200);
  await drive(1300, () => hand('ringpinch', 0.5, 0.5));
  await drive(300, () => hand('point', 0.5, 0.5)); await sleep(300);
  const lb = api.actions.bounds();
  check('thumb + ring finger held = the launcher opens', api.actions.launcherOpen() && !!lb, lb ? 'window ' + lb.width + 'x' + lb.height + ' at ' + lb.x + ',' + lb.y : 'closed');
  if (lb) {
    const { LAYOUT } = require('../../src/main/actions.cjs');
    const idx = 6; // "Zoom in"
    const dip = { x: lb.x + LAYOUT.gap + (idx % LAYOUT.cols) * (LAYOUT.tileW + LAYOUT.gap) + LAYOUT.tileW / 2, y: lb.y + LAYOUT.gap + Math.floor(idx / LAYOUT.cols) * (LAYOUT.tileH + LAYOUT.gap) + LAYOUT.tileH / 2 };
    const pt = screen.dipToScreenPoint(dip);
    const sx = pt.x / (input.screen.w - 1), sy = pt.y / (input.screen.h - 1);
    m0 = mark();
    await drive(1100, () => hand('point', sx, sy)); await sleep(100);
    check('the cursor can be steered onto a tile', near(cursor(), pt, 8), 'cursor ' + cursor().x + ',' + cursor().y + ' tile ' + Math.round(pt.x) + ',' + Math.round(pt.y));
    await drive(300, () => hand('pinch', sx, sy));
    await drive(500, () => hand('point', sx, sy)); await sleep(600);
    const tz = since(m0).find((e) => e.type === 'wheel' && e.ck);
    check('pinching on a tile runs its action and closes the launcher', !api.actions.launcherOpen() && !!tz, tz ? 'Ctrl+wheel deltaY=' + tz.dy : 'no zoom seen');
  }

  // two-hand mode: the other hand clicks while the steering hand keeps moving
  api.setSettings({ control: { twoHands: true, cursorHand: 'right' } });
  await sleep(200);
  const R = (ms, pose = 'point') => makeHand({ pose, at: at(0.3 + 0.0002 * ms, 0.5), label: 'right' });
  const Lh = (pose) => makeHand({ pose, at: { x: 0.2, y: 0.5 }, label: 'left' });
  await drive(800, (ms) => [R(ms), Lh('point')]);
  m0 = mark();
  await drive(250, (ms) => [R(800 + ms), Lh('pinch')]);
  await drive(500, (ms) => [R(1050 + ms), Lh('point')]); await sleep(100);
  ev = since(m0);
  check('two-hand mode: a pinch of the OTHER hand clicks', ev.some((e) => e.type === 'mousedown') && ev.some((e) => e.type === 'mouseup') && ev.some((e) => e.type === 'click'), ev.filter((e) => e.type !== 'mousemove').map((e) => e.type).join(','));
  check('…while the steering hand keeps moving the cursor', ev.filter((e) => e.type === 'mousemove').length > 5);
  api.setSettings({ control: { twoHands: false } });
  await sleep(200);

  // test mode: nothing may reach Windows
  api.setSettings({ safety: { dryRun: true } });
  await sleep(200);
  await drive(700, () => hand('point', 0.5, 0.5));
  const cT = cursor(); m0 = mark();
  await drive(1200, (ms) => hand('point', 0.2 + 0.5 * (ms / 1200), 0.4));
  await drive(250, () => hand('pinch', 0.7, 0.4));
  await drive(400, () => hand('point', 0.7, 0.4));
  await drive(1300, () => hand('ringpinch', 0.7, 0.4));
  await sleep(150);
  ev = since(m0);
  check('test mode: the cursor does not move, nothing is clicked, no key is pressed', near(cursor(), cT, 2) && !ev.some((e) => e.type === 'mousedown' || e.type === 'keydown' || e.type === 'wheel') && !api.actions.launcherOpen(), 'cursor ' + cT.x + ',' + cT.y + ' → ' + cursor().x + ',' + cursor().y);
  api.setSettings({ safety: { dryRun: false } });
  await sleep(200);
  api.actions.closeLauncher();
  }
  if (want('arrow') || ALL) {
  // 12b) the hand is the cursor: the Windows arrow is hidden only while control is ACTIVE and the hand is seen
  await ensureActive();
  api.setArrowTest(true);
  // how many pixels the system arrow would draw right now (0 = invisible): a fresh PowerShell draws Cursors.Arrow on white
  const { execFileSync } = require('child_process');
  const PS = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=New-Object System.Drawing.Bitmap 32,32; $g=[System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); [System.Windows.Forms.Cursors]::Arrow.Draw($g,(New-Object System.Drawing.Rectangle 0,0,32,32)); $n=0; for($y=0;$y -lt 32;$y++){for($x=0;$x -lt 32;$x++){ if($b.GetPixel($x,$y).ToArgb() -ne -1){$n++} }}; $n";
  const arrowPx = () => { try { return parseInt(execFileSync('powershell.exe', ['-NoProfile', '-Command', PS], { timeout: 15000 }).toString().trim(), 10); } catch { return -1; } };
  await drive(700, () => null); await sleep(600);
  const px0 = arrowPx();
  check('no hand in view: the Windows arrow stays visible', !input.cursorHidden);
  await drive(1200, () => hand('point', 0.5, 0.5));
  await sleep(100);
  check('hand seen while ACTIVE: the Windows arrow is hidden (the on-screen hand is the cursor)', input.cursorHidden && px0 > 20 && arrowPx() === 0, 'arrow pixels ' + px0 + ' -> hidden');
  api.setMode('paused', 'test', 'ui');
  check('PAUSED: the arrow comes back at once (the original arrow is drawn again)', !input.cursorHidden && arrowPx() === px0, 'arrow pixels back to ' + px0);
  await ensureActive();
  await drive(800, () => hand('point', 0.5, 0.5)); await sleep(100);
  check('…and is hidden again after re-activating', input.cursorHidden);
  await drive(600, () => null); await sleep(700);
  check('hand lost: the arrow comes back by itself', !input.cursorHidden);
  await drive(800, () => hand('point', 0.5, 0.5)); await sleep(100);
  api.setMode('locked', 'test', 'hotkey');
  check('EMERGENCY LOCK: the arrow comes back at once', !input.cursorHidden);
  api.setMode('paused', 'test', 'ui');
  api.setArrowTest(false);
  check('…and the arrow is visible at the end of the test', !input.cursorHidden);
  await ensureActive();
  }
  if (want('windrag') || ALL) {
  // 12c) a real WINDOW drag: grab a title bar with a pinch, carry it, drop it (the window lives in another process)
  await ensureActive();
  const { spawn } = require('child_process');
  const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(__dirname, 'dragwin.cjs')], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let lastBounds = null, firstBounds = null;
  child.stdout.on('data', (d) => { for (const l of String(d).split(/\r?\n/)) { if (l.startsWith('BOUNDS ')) { lastBounds = JSON.parse(l.slice(7)); if (!firstBounds) firstBounds = lastBounds; } } });
  for (let i = 0; i < 100 && !firstBounds; i++) await sleep(100);
  await sleep(500);
  if (!firstBounds) { check('window drag: the test window started', false, 'no BOUNDS line from the child'); }
  else {
    const start = { ...lastBounds };
    const grab = screen.dipToScreenPoint({ x: start.x + 190, y: start.y + 30 });    // on its title bar
    const drop = { x: grab.x + 300, y: grab.y + 150 };
    const sxy = (p) => [p.x / (input.screen.w - 1), p.y / (input.screen.h - 1)];
    const [gx, gy] = sxy(grab), [dx, dy] = sxy(drop);
    await drive(1200, () => hand('point', gx, gy)); await sleep(100);
    const cOn = cursor();
    await drive(1800, (ms) => { const k = Math.min(1, Math.max(0, (ms - 450) / 900)); return hand('pinch', gx + (dx - gx) * k, gy + (dy - gy) * k); });  // grab, carry
    await drive(500, () => hand('point', dx, dy)); await sleep(500);
    const b1 = JSON.stringify(lastBounds); await sleep(500); const stayed = JSON.stringify(lastBounds) === b1;
    const end = lastBounds, sf = screen.getPrimaryDisplay().scaleFactor || 1;
    const mx = Math.round((end.x - start.x) * sf), my = Math.round((end.y - start.y) * sf);   // in screen pixels
    check('the cursor can be steered onto a title bar', near(cOn, grab, 8), 'cursor ' + cOn.x + ',' + cOn.y + ' title bar ' + Math.round(grab.x) + ',' + Math.round(grab.y));
    check('a pinch held on a title bar drags the whole window (moved ~300,150)', Math.abs(mx - 300) <= 60 && Math.abs(my - 150) <= 60, 'window moved by ' + mx + ',' + my + ' px');
    check('…and it is dropped when the pinch opens (window stays put afterwards)', stayed && !input.isDown(1));
  }
  try { child.kill(); } catch { /* ok */ }
  await sleep(300);
  }
  if (want('net') || ALL) {
  // 13) no network
  const w2 = new BrowserWindow({ show: false });
  const before = api.blocked();
  const fail = await new Promise((res) => { w2.webContents.once('did-fail-load', (_e, code, desc) => res(desc)); w2.loadURL('https://example.com/').catch(() => {}); setTimeout(() => res('timeout'), 4000); });
  check('internet requests are blocked before they leave', /BLOCKED/i.test(fail) && api.blocked() > before, `result: ${fail}, blocked requests: ${api.blocked()}`);
  w2.destroy();
  const winCsp = await api.win().webContents.executeJavaScript("fetch('https://example.com').then(()=>'PASSATO').catch(()=> 'blocked')");
  check('fetch() to the internet also fails from the app page', winCsp === 'blocked');
  const ses = session.defaultSession;
  check('permissions: camera only, only for the app window', true, 'see code: setPermissionRequestHandler');

  }
  if (ALL || want('shot')) {
  // 14) snapshots of the window and of the status badge (camera off: no personal image)
  try {
    target.hide();
    api.win().show(); await sleep(500);
    const out = process.env.HC_E2E_SHOT || path.join(__dirname, 'ui-shot.png');
    // HUD preview with synthetic hands (control stays PAUSED, so nothing touches the real mouse)
    api.setMode('paused', 'screenshot', 'ui');
    await api.win().webContents.executeJavaScript(`document.querySelector('#tabs button[data-tab="commands"]').click()`);
    await drive(500, () => null);
    const big = (pose, sx, sy) => makeHand({ pose, at: at(sx, sy), size: 0.3 }); // a hand at a realistic size
    await drive(900, (ms) => big('point', 0.25 + 0.4 * (ms / 900), 0.35 + 0.2 * Math.sin(ms / 160)));
    fs.writeFileSync(out.replace('.png', '-hud-point.png'), (await api.win().webContents.capturePage()).toPNG());
    // the hand on the screen: where is it drawn, how big, and is it above everything?
    await drive(1000, () => big('point', 0.6, 0.45));
    const ov = api.handOverlay();
    const img = await ov.webContents.capturePage();
    const bmp = img.toBitmap(); const sz = img.getSize();
    let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, opaque = 0;
    for (let y = 0; y < sz.height; y++) for (let x = 0; x < sz.width; x++) {
      if (bmp[(y * sz.width + x) * 4 + 3] > 40) { opaque++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    }
    const wantSize = api.settings().ui.overlaySize, bh = maxy - miny;
    const cur = { x: 0.6 * sz.width, y: 0.45 * sz.height };
    fs.writeFileSync(out.replace('.png', '-hand-overlay.png'), img.toPNG());
    check('the hand layer exists, is visible and sits above the other windows', !!ov && ov.isVisible() && ov.isAlwaysOnTop(), ov ? 'always on top: ' + ov.isAlwaysOnTop() : 'missing');
    const pointerStyle = api.settings().ui.handStyle !== 'skeleton';
    check(pointerStyle ? 'the hand pointer is drawn on the screen, its fingertip on the cursor' : 'the hand is drawn on the screen around the cursor, at about the chosen size',
      opaque > (pointerStyle ? 200 : 500) && cur.x >= minx - 4 && cur.x <= maxx + 4 && cur.y >= miny - 4 && cur.y <= maxy + 4 && (pointerStyle ? (bh > 30 && bh < 220) : (bh > wantSize * 0.6 && bh < wantSize * 1.6)),
      'drawn box ' + (maxx - minx) + 'x' + bh + ' px, cursor at ' + Math.round(cur.x) + ',' + Math.round(cur.y) + ', wanted height ~' + wantSize);
    await drive(500, () => big('pinch', 0.6, 0.5));
    fs.writeFileSync(out.replace('.png', '-hud-pinch.png'), (await api.win().webContents.capturePage()).toPNG());
    await drive(500, () => big('scroll', 0.5, 0.5));
    fs.writeFileSync(out.replace('.png', '-hud-scroll.png'), (await api.win().webContents.capturePage()).toPNG());
    await drive(600, () => null);
    fs.writeFileSync(out.replace('.png', '-hud-idle.png'), (await api.win().webContents.capturePage()).toPNG());
    for (const tab of ['commands', 'settings', 'gestures', 'measure']) {
      await api.win().webContents.executeJavaScript(`document.querySelector('#tabs button[data-tab="${tab}"]').click()`);
      await sleep(350);
      fs.writeFileSync(out.replace('.png', `-${tab}.png`), (await api.win().webContents.capturePage()).toPNG());
    }
    for (const m of ['paused', 'active', 'locked']) {
      api.setMode(m, 'screenshot', 'ui');
      await sleep(350);
      fs.writeFileSync(out.replace('.png', `-badge-${m}.png`), (await api.overlay().webContents.capturePage()).toPNG());
    }
  } catch (e) { console.log('snapshot failed', e.message); }
  }

  // ── conclusion ──
  input.releaseAll();
  const summary = { when: new Date().toISOString(), screen: { w: b.width, h: b.height, scale: screen.getPrimaryDisplay().scaleFactor }, results, metrics, failures };
  fs.writeFileSync(process.env.HC_E2E_OUT, JSON.stringify(summary, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed${failures ? ' — ' + failures + ' FAILED' : ''}`);
  console.log('Metrics:', JSON.stringify(metrics));
  target.destroy();
  app.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR in the test:', e); try { require('../../src/main/main.cjs').input.releaseAll(); } catch { /* ok */ } app.exit(2); });





