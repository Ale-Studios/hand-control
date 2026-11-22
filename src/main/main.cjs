// Hand Control — main process.
// This is the SECURITY AUTHORITY: the mode (ACTIVE / PAUSED / LOCKED) lives here, and no
// mouse command gets through unless we are ACTIVE, whatever the camera window says.

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, nativeTheme, screen, session, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const { DEFAULTS, DISTANCE_PRESETS, ACTION_PRESETS, merge, enforceMinArea } = require('../core/defaults.cjs');
const { pngFor } = require('./icons.cjs');
const { Input } = require('./input.cjs');
const { Actions, parseAction } = require('./actions.cjs');

const argv = process.argv.slice(1);
const flag = (n) => argv.includes(n);
const E2E = process.env.HC_E2E === '1';
const BENCH = flag('--bench');
const flagVal = (n) => { const a = argv.find((x) => x.startsWith(n + '=')); return a ? a.split('=')[1] : ''; };
const DELEGATE = flagVal('--delegate').toUpperCase(); // for testing: --delegate=CPU | GPU

if (process.env.HC_USER_DATA) app.setPath('userData', process.env.HC_USER_DATA);

// The window may stay hidden in the tray and MUST keep following the hand:
// Chromium normally puts hidden windows to sleep; here we prevent that.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// On PCs with two graphics cards (Intel + NVIDIA) Windows usually gives Electron the weak one.
// We ask for the powerful one; set HC_GPU=default to turn this off.
if (process.env.HC_GPU !== 'default') app.commandLine.appendSwitch('force_high_performance_gpu');

// The app pages are served through an internal "hc://" protocol: it is a secure context
// (the camera needs one) and lets the wasm engine load without internet.
protocol.registerSchemesAsPrivileged([
  { scheme: 'hc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveLocalFiles() {
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const modelsDir = path.join(__dirname, '..', '..', 'assets', 'models');
  const coreDir = path.join(__dirname, '..', 'core');
  protocol.handle('hc', async (req) => {
    try {
      const u = new URL(req.url);
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      let root = rendererDir;
      if (rel.startsWith('models/')) { root = modelsDir; rel = rel.slice('models/'.length); }
      else if (rel.startsWith('core/')) { root = coreDir; rel = rel.slice('core/'.length); }
      const file = path.resolve(root, rel || 'index.html');
      const inside = path.relative(root, file);
      if (inside.startsWith('..') || path.isAbsolute(inside)) return new Response('forbidden', { status: 403 });
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

const api = new EventEmitter(); // for tests: api.on('input', ...)
api.state = {};
let resolveReady; api.ready = new Promise((r) => { resolveReady = r; });

const nowMs = () => performance.timeOrigin + performance.now();

// ─────────────────────────── settings ───────────────────────────
let settingsFile;
let settings = merge(DEFAULTS, {});
function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const v = Number(raw.version) || 1;
    if (v < 2) { // settings saved before simple mode: switch to it (one hand, palm steers, starts when the hand is seen)
      raw.control = { ...raw.control, pointAt: 'palm', twoHands: false };
      raw.safety = { ...raw.safety, autoActivate: true };
    }
    if (v < 4) { // see-through window background; the cursor on screen keeps its usual opacity
      const ui = raw.ui || {};
      raw.ui = { ...ui, windowOpacity: DEFAULTS.ui.windowOpacity, overlayOpacity: v === 3 && ui.overlayOpacity === 0.6 ? DEFAULTS.ui.overlayOpacity : ui.overlayOpacity };
      if (raw.ui.overlayOpacity === undefined) delete raw.ui.overlayOpacity;
    }
    if (v < 5) { // the fist now grabs and drags; "minimise the window" moves to thumb + little finger (if it was left at its default)
      const a = raw.actions || {};
      if (a.pinkyPinch === undefined || a.pinkyPinch === 'keys:<cmd>+<tab>') raw.actions = { ...a, pinkyPinch: 'window:minimize' };
    }
    raw.version = DEFAULTS.version;
    settings = merge(DEFAULTS, raw);
  } catch { settings = merge(DEFAULTS, {}); }
  settings.control.area = enforceMinArea(settings.control.area); // a saved area that is too small is enlarged
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (e) { addLog('Could not save settings: ' + e.message); }
}

// ─────────────────────────── state ───────────────────────────
const input = new Input();
const actions = new Actions({
  input,
  getSettings: () => settings,
  log: (t) => addLog(t),
  isDry: () => !!settings.safety.dryRun,
  isLocked: () => mode === 'locked',
  emit: (...a) => api.emit(...a),
});
let mode = 'paused';        // paused | active | locked
let cameraState = 'off';    // off | on | error
let handSeen = false;
let hud = { holdKind: null, holdProgress: 0, pose: 'none' };
let win = null, overlay = null, tray = null;
let quitting = false;
// Simple mode: control starts by itself when the hand is first seen. It is armed once per start, and again after an automatic
// pause (hand lost for too long, camera hiccup). A pause or lock that YOU asked for disarms it: then only the open hand wakes it.
let autoArmed = !E2E;
let lastInputAt = 0;
let lastHudAt = 0;
let blockedRequests = 0;
let killKeyOk = false, pauseKeyOk = false, killKeyUsed = '';
const logLines = [];

// Test mode ("dry run"): tell what would happen instead of doing it. Moves and scroll are summarised, not listed.
let dryMoves = 0, dryWheelAt = 0;
function dryNote(m) {
  if (m.type === 'move') { if (++dryMoves % 60 === 1) addLog('[test mode] the cursor would be moving'); return true; }
  if (m.type === 'wheel') { if (Date.now() - dryWheelAt > 800) { dryWheelAt = Date.now(); addLog(`[test mode] would scroll ${m.delta > 0 ? 'up' : 'down'}`); } return true; }
  addLog(`[test mode] would ${m.type === 'down' ? 'press' : m.type === 'up' ? 'release' : 'click'} the ${m.button || 'left'} button`);
  return true;
}

function addLog(text) {
  const line = { t: Date.now(), text };
  if (BENCH || flag('--verbose')) console.log('[log] ' + text);
  logLines.push(line);
  if (logLines.length > 80) logLines.shift();
  send('log', line);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function sendOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay-state', overlayState());
}
function overlayState() {
  return { mode, camera: cameraState, hand: handSeen, holdKind: hud.holdKind, holdProgress: hud.holdProgress, pose: hud.pose, dry: !!settings.safety.dryRun };
}

// ─────────────────────────── screen ───────────────────────────
function targetScreen() {
  const all = screen.getAllDisplays();
  const d = all[settings.control.display] || screen.getPrimaryDisplay();
  let r;
  try { r = screen.dipToScreenRect(null, d.bounds); } catch { r = d.bounds; }
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}
function applyScreen() {
  const r = targetScreen();
  input.setScreenRect(r);
  send('screen', { w: r.w, h: r.h });
  return r;
}

// ─────────────────────────── mode (the heart of safety) ───────────────────────────
/**
 * source: 'hotkey' | 'ui' | 'gesture' | 'auto'
 * Rules:
 *  - LOCKED can only be left from the keyboard or a button (never by a gesture), and leads to PAUSED;
 *  - leaving ACTIVE always releases the mouse buttons.
 */
function setMode(next, reason, source = 'ui') {
  if (!['paused', 'active', 'locked'].includes(next)) return mode;
  if (next === mode) return mode;
  if (mode === 'locked') {
    if (source === 'gesture' || source === 'auto') return mode;
    if (next === 'active') next = 'paused';
  }
  mode = next;
  if (next === 'active') autoArmed = false;
  else autoArmed = !E2E && next === 'paused' && /not seen|stopped delivering|camera/i.test(reason || ''); // (tests arm it by hand)
  if (mode !== 'active') { input.releaseAll(); actions.closeLauncher(); syncArrow(); }
  addLog(`Mode: ${label(mode)} — ${reason || source}`);
  send('mode', { mode, reason, source });
  refreshTray();
  sendOverlay();
  api.emit('mode', mode, reason, source);
  return mode;
}
const label = (m) => ({ active: 'ACTIVE', paused: 'PAUSED', locked: 'LOCKED' }[m]);

// ─────────────────────────── global shortcuts ───────────────────────────
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const tryReg = (accel, fn) => { try { return accel && globalShortcut.register(accel, fn); } catch { return false; } };
  const kill = () => setMode(mode === 'locked' ? 'paused' : 'locked', mode === 'locked' ? 'unlocked from keyboard' : 'EMERGENCY LOCK (keyboard)', 'hotkey');
  killKeyUsed = settings.safety.killKey;
  killKeyOk = tryReg(killKeyUsed, kill);
  if (!killKeyOk) {
    // Another app already owns the shortcut: try a nearby one so we are never left without.
    const alt = killKeyUsed.replace('Alt+', 'Alt+Shift+');
    if (tryReg(alt, kill)) { killKeyUsed = alt; killKeyOk = true; addLog(`Shortcut ${settings.safety.killKey} was already taken: using ${alt}`); }
  }
  pauseKeyOk = tryReg(settings.safety.pauseKey, () => {
    if (mode === 'locked') return;
    setMode(mode === 'active' ? 'paused' : 'active', mode === 'active' ? 'paused from keyboard' : 'activated from keyboard', 'hotkey');
  });
  if (!killKeyOk) addLog('WARNING: could not register the emergency shortcut. Use the red button or the tray menu.');
  send('hotkeys', hotkeyInfo());
}
const hotkeyInfo = () => ({ kill: killKeyUsed, killOk: killKeyOk, pause: settings.safety.pauseKey, pauseOk: pauseKeyOk });

// ─────────────────────────── windows ───────────────────────────
// See-through window: the window itself is transparent and the page paints a dark background with the chosen opacity
// (Settings → Opacity of the window background). Text, buttons and the camera view stay solid. (A system "acrylic" material
// is not used: it blurs what is behind and turns solid whenever the window is not active.) The tests use a solid window.
const SEE_THROUGH = !E2E;
const glassMode = () => (SEE_THROUGH ? 'clear' : 'none');

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 940, minHeight: 640,
    title: 'Hand Control',
    // frameless look: our own header is the title bar, with our own minimise / maximise / close buttons. (A transparent window has
    // no system frame, so the Windows buttons, the double-click on the title bar and the edge resizing are handled by the app.)
    titleBarStyle: 'hidden',
    transparent: SEE_THROUGH,
    backgroundColor: SEE_THROUGH ? '#00000000' : '#16181b',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    show: !(flag('--hidden') || E2E),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadURL('hc://app/index.html');
  applyTop();
  // The X closes the whole program like in any normal app. (The status badge, the launcher and the hand layer are windows
  // too, so "last window closed" would never happen on its own.) "Hide to tray" is a separate button.
  win.on('close', () => { quitting = true; app.quit(); });
  win.on('closed', () => { win = null; });
  const winState = () => send('win-state', { max: !!(win && !win.isDestroyed() && win.isMaximized()), see: SEE_THROUGH });
  win.on('maximize', winState); win.on('unmaximize', winState); win.on('restore', winState);
  win.on('maximize', applyTop); win.on('unmaximize', applyTop);
  // maximised = backdrop: when it gets the focus (a click on it, the taskbar) it goes straight back under the other apps
  win.on('focus', () => { if (win && !win.isDestroyed() && win.isMaximized()) setTimeout(sendToBack, 0); raiseOverlays(); });
  for (const ev of ['show', 'restore', 'maximize', 'unmaximize', 'always-on-top-changed']) win.on(ev, () => setTimeout(raiseOverlays, 0));
  win.webContents.on('did-finish-load', winState);
  // double-click on the title bar = maximise / restore (Windows does not do it for a frameless transparent window)
  if (SEE_THROUGH) win.hookWindowMessage(0x00A3 /* WM_NCLBUTTONDBLCLK */, () => setImmediate(toggleMaximize));
  if (flag('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  if (E2E || BENCH || flag('--verbose')) {
    // page messages show up in the terminal (handy to find out what is wrong)
    win.webContents.on('console-message', (_e, level, message, line, src) => {
      if (level >= 2 || /error|fail/i.test(message)) console.log(`[page${level >= 2 ? ' ERR' : ''}] ${message} (${String(src).split('/').pop()}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.log('[page] process gone:', d.reason));
  }
}

// ─────────────────────────── the hand on screen ───────────────────────────
// A transparent, click-through window over the controlled screen, ABOVE every other window (and above this app's own window).
// The hand skeleton, the reticle and the trail are drawn here, so you see your hand grabbing the folders.
let handOv = null;
let handOvForce = false; // tests switch it on by hand
const handOverlayWanted = () => (E2E ? handOvForce : !!settings.ui.handOverlay && cameraState === 'on');
function controlledDisplayBounds() {
  const all = screen.getAllDisplays();
  return (all[settings.control.display] || screen.getPrimaryDisplay()).bounds; // DIP
}
function handOverlayConfig() {
  return { size: settings.ui.overlaySize, opacity: settings.ui.overlayOpacity, color: settings.ui.hudColor, mirror: settings.camera.mirror, trail: settings.ui.trail, style: settings.ui.handStyle };
}
// The hand IS the cursor: the Windows arrow is hidden only while that is really true (control ACTIVE, hand seen, hand layer
// visible, not in test mode, physical mouse not in use). In every other case — pause, lock, hand lost, quit, crash recovery at
// the next start — the arrow is shown again, so you are never left without a pointer.
let arrowForce = false; // tests switch it on by hand
function syncArrow() {
  const want = (!E2E || arrowForce) && !!settings.ui.hideCursor && mode === 'active' && !settings.safety.dryRun && handSeen
    && !!handOv && !handOv.isDestroyed() && handOv.isVisible() && !input.suspended();
  if (want && !input.cursorHidden) input.hideSystemCursor();
  else if (!want && input.cursorHidden) input.showSystemCursor();
}
function syncHandOverlay() {
  const want = handOverlayWanted();
  const alive = handOv && !handOv.isDestroyed();
  if (!want) {
    if (alive) handOv.close();
    send('hand-overlay', false);
    return;
  }
  const b = controlledDisplayBounds();
  if (alive) {
    handOv.setBounds(b);
    handOv.webContents.send('hand:config', handOverlayConfig());
    send('hand-overlay', true);
    return;
  }
  handOv = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    hasShadow: false, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'handoverlay-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  const w = handOv;
  w.setIgnoreMouseEvents(true, { forward: false }); // NEVER intercepts a click or a key
  w.setAlwaysOnTop(true, 'screen-saver', 1);        // above everything, even the other overlays
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.loadURL('hc://app/handoverlay.html');
  w.webContents.once('did-finish-load', () => {
    if (w.isDestroyed()) return;
    w.webContents.send('hand:config', handOverlayConfig());
    w.showInactive();
    send('hand-overlay', true);
  });
  w.on('closed', () => { if (handOv === w) handOv = null; });
}
function toggleMaximize() {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  applyTop();
  send('win-state', { max: win.isMaximized(), see: SEE_THROUGH });
}
// Resizing from the edges of the window: the page reports which edge was grabbed, then the window follows the mouse until the
// left button is released.
let resizeTimer = null;
function startResize(edge) {
  if (!win || win.isDestroyed() || win.isMaximized() || resizeTimer || !/^(n|s|e|w|ne|nw|se|sw)$/.test(edge)) return;
  const b0 = win.getBounds(), p0 = screen.getCursorScreenPoint();
  const [minW, minH] = win.getMinimumSize();
  const t0 = Date.now();
  resizeTimer = setInterval(() => {
    // stop when the button is up (after a short grace, so a quick click is still read as "down"), or as a safety net after 2 min
    if (!win || win.isDestroyed() || (Date.now() - t0 > 80 && !input.isDown(0x01)) || Date.now() - t0 > 120000) {
      clearInterval(resizeTimer); resizeTimer = null; return;
    }
    const p = screen.getCursorScreenPoint(), dx = p.x - p0.x, dy = p.y - p0.y;
    let { x, y, width, height } = b0;
    if (edge.includes('e')) width = Math.max(minW, b0.width + dx);
    if (edge.includes('s')) height = Math.max(minH, b0.height + dy);
    if (edge.includes('w')) { width = Math.max(minW, b0.width - dx); x = b0.x + b0.width - width; }
    if (edge.includes('n')) { height = Math.max(minH, b0.height - dy); y = b0.y + b0.height - height; }
    win.setBounds({ x, y, width, height });
  }, 16);
}
// the main window: floats above the other apps when asked
// Normal size: the window floats above the other apps (if asked). Maximised: it becomes a see-through BACKDROP under every
// other app, so the windows you open appear on top of it (and clicking it does not bring it over them).
function applyTop() {
  if (!win || win.isDestroyed()) return;
  const max = win.isMaximized();
  win.setAlwaysOnTop(!max && !!settings.ui.alwaysOnTop, 'floating');
  if (max) sendToBack();
}
// The cursor layer and the status badge must stay above EVERY window, this app's own window included. Among "always on top"
// windows Windows puts the one just activated first, so they are put back on top when that happens (and once a second anyway).
function raiseOverlays() {
  for (const w of [handOv, overlay]) {
    if (w && !w.isDestroyed() && w.isVisible()) { try { w.moveTop(); } catch { /* closing */ } }
  }
}
function sendToBack() {
  if (!win || win.isDestroyed() || !win.isMaximized()) return;
  try { input.sendToBack(win.getNativeWindowHandle()); } catch (e) { console.warn('send to back', e); }
}
function createOverlay() {
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 300, H = 64;
  overlay = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - W) / 2), y: wa.y + 8, width: W, height: H,
    frame: false, transparent: true, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  overlay.setIgnoreMouseEvents(true, { forward: false }); // NEVER intercepts a click
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL('hc://app/overlay.html');
  overlay.webContents.once('did-finish-load', () => { overlay.showInactive(); sendOverlay(); });
  overlay.on('closed', () => { overlay = null; });
}

function createTray() {
  const img = (s) => nativeImage.createFromBuffer(pngFor(s, 32));
  tray = new Tray(img('paused'));
  tray.on('click', () => showWindow());
  refreshTray();
}
function refreshTray() {
  if (!tray) return;
  const img = nativeImage.createFromBuffer(pngFor(mode, 32));
  tray.setImage(img);
  tray.setToolTip(`Hand Control — ${label(mode)}${cameraState === 'on' ? ' — camera on' : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${label(mode)}`, enabled: false },
    { label: 'Show window', click: () => showWindow() },
    { type: 'separator' },
    { label: mode === 'active' ? 'Pause control' : 'Activate control', enabled: mode !== 'locked', click: () => setMode(mode === 'active' ? 'paused' : 'active', 'from tray menu', 'ui') },
    { label: mode === 'locked' ? 'Unlock (stays paused)' : '⛔ EMERGENCY LOCK', click: () => setMode(mode === 'locked' ? 'paused' : 'locked', mode === 'locked' ? 'unlocked from tray menu' : 'EMERGENCY LOCK (tray menu)', 'ui') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}
function showWindow() { if (win) { win.show(); win.focus(); } }

// ─────────────────────────── network lockdown and permissions ───────────────────────────
function lockDownSession() {
  const ses = session.defaultSession;
  // No internet, ever: anything that is not a local file is blocked (and counted).
  ses.webRequest.onBeforeRequest((details, cb) => {
    if (/^(hc|file|devtools|data|blob|chrome-extension):/i.test(details.url)) return cb({});
    blockedRequests++;
    send('blocked', blockedRequests);
    cb({ cancel: true });
  });
  const mine = (wc) => win && !win.isDestroyed() && wc === win.webContents;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    // only our window, only the camera (video, never the microphone)
    const types = (details && details.mediaTypes) || [];
    cb(mine(wc) && permission === 'media' && !types.includes('audio'));
  });
  ses.setPermissionCheckHandler((wc, permission) => mine(wc) && permission === 'media');
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (ev) => ev.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

// ─────────────────────────── IPC ───────────────────────────
const fromMain = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

function wireIpc() {
  ipcMain.handle('get-state', (e) => {
    if (!fromMain(e)) return null;
    const s = applyScreen();
    return {
      settings, defaults: DEFAULTS, mode, presets: DISTANCE_PRESETS, actionPresets: ACTION_PRESETS, screen: { w: s.w, h: s.h },
      hotkeys: hotkeyInfo(), log: logLines, blocked: blockedRequests,
      info: { handOverlay: handOverlayWanted(), glass: glassMode(), delegate: DELEGATE, version: app.getVersion(), e2e: E2E, bench: BENCH, userData: app.getPath('userData'), displays: screen.getAllDisplays().length },
    };
  });

  ipcMain.handle('settings:set', (e, patch) => {
    if (!fromMain(e)) return null;
    const before = settings;
    settings = merge(settings, patch);
    // actions typed into the settings must be valid; a bad one is put back to the previous value
    for (const k of ['ringPinch', 'pinkyPinch']) {
      if (parseAction(settings.actions[k]).error) { addLog(`Invalid action for ${k}: kept the previous one`); settings.actions[k] = before.actions[k]; }
    }
    if (settings.safety.dryRun !== before.safety.dryRun) { addLog(settings.safety.dryRun ? 'TEST MODE ON: nothing will be sent to the mouse or keyboard' : 'Test mode off'); sendOverlay(); }
    saveSettings();
    input.realMouseWins = settings.safety.realMouseWins;
    if (settings.safety.killKey !== before.safety.killKey || settings.safety.pauseKey !== before.safety.pauseKey) registerHotkeys();
    if (settings.control.display !== before.control.display) applyScreen();
    if (settings.ui.alwaysOnTop !== before.ui.alwaysOnTop) applyTop();
    if (settings.ui.handOverlay !== before.ui.handOverlay || settings.control.display !== before.control.display || settings.ui.overlaySize !== before.ui.overlaySize || settings.ui.overlayOpacity !== before.ui.overlayOpacity || settings.ui.hudColor !== before.ui.hudColor || settings.ui.trail !== before.ui.trail || settings.camera.mirror !== before.camera.mirror || settings.ui.handStyle !== before.ui.handStyle) syncHandOverlay();
    syncArrow();
    send('settings', settings);
    return settings;
  });

  ipcMain.on('mode:set', (e, m) => {
    if (!fromMain(e) || !m) return;
    setMode(m.mode, m.reason, m.source === 'gesture' ? 'gesture' : m.source === 'auto' ? 'auto' : 'ui');
  });

  // Mouse commands: ALWAYS filtered here. If we are not ACTIVE they vanish (except button releases).
  ipcMain.on('input', (e, m) => {
    if (!fromMain(e) || !m) return;
    lastInputAt = Date.now();
    const active = mode === 'active';
    const dry = !!settings.safety.dryRun; // test mode: say what would happen, touch nothing
    let done = false;
    switch (m.type) {
      case 'move':
        if (active) { done = dry ? dryNote(m) : input.moveNorm(+m.x, +m.y); if (done && input.winMove) input.moveGrabbedWindow(); }
        break;
      case 'down':
        if (!active) break;
        if (dry) { done = dryNote(m); break; }
        if (m.grab === 'fist') {
          // closed fist: move the whole window under the cursor (this app's own maximised backdrop is never grabbed)
          const skip = win && !win.isDestroyed() && win.isMaximized() ? win.getNativeWindowHandle().readBigUInt64LE() : null;
          const r = input.beginWindowMove(skip);
          if (r === 'moving') { addLog(`Fist: moving the window "${input.winMove.title}"`); done = true; break; }
          if (r === 'skip') { done = true; break; }
        }
        done = input.button(m.button === 'right' ? 'right' : 'left', true);
        break;
      case 'up':
        if (input.endWindowMove()) { done = true; break; }
        if (!dry) input.button(m.button === 'right' ? 'right' : 'left', false); else dryNote(m); done = true; break;
      case 'click': if (active) done = dry ? dryNote(m) : input.click(m.button === 'right' ? 'right' : 'left'); break;
      case 'wheel': if (active) done = dry ? dryNote(m) : input.wheel(+m.delta || 0); break;
      case 'action': if (active && (m.which === 'ring' || m.which === 'pinky')) done = actions.runGesture(m.which); break;
      default: return;
    }
    const tMain = nowMs();
    api.emit('input', m, done, tMain);
    if (m.ack) e.sender.send('ack', { seq: m.ack, tMain, type: m.type, done });
  });

  // a launcher tile was clicked (inside the launcher window; the action itself comes from the saved settings)
  ipcMain.on('launcher:choose', (e, i) => actions.chooseTile(i, e.sender));

  ipcMain.on('camera:state', (e, s) => {
    if (!fromMain(e)) return;
    cameraState = ['on', 'off', 'error'].includes(s) ? s : 'off';
    if (cameraState !== 'on') handSeen = false;
    addLog(cameraState === 'on' ? 'Camera on' : cameraState === 'off' ? 'Camera off' : 'Camera error');
    refreshTray(); sendOverlay(); syncHandOverlay();
  });

  // hand landmarks from the camera window → the on-screen hand layer
  ipcMain.on('hand:frame', (e, p) => {
    if (!fromMain(e) || !p) return;
    if (handOv && !handOv.isDestroyed() && handOv.isVisible()) handOv.webContents.send('hand:frame', p);
  });

  ipcMain.on('hud', (e, h) => {
    if (!fromMain(e) || !h) return;
    lastHudAt = Date.now();
    const changed = handSeen !== !!h.hand || hud.holdKind !== h.holdKind || Math.abs((hud.holdProgress || 0) - (h.holdProgress || 0)) > 0.04 || hud.pose !== h.pose;
    const wasSeen = handSeen;
    handSeen = !!h.hand;
    if (handSeen && !wasSeen && autoArmed && mode === 'paused' && settings.safety.autoActivate && !quitting) setMode('active', 'hand seen (simple mode)', 'auto');
    hud = { holdKind: h.holdKind || null, holdProgress: +h.holdProgress || 0, pose: h.pose || 'none' };
    if (changed) sendOverlay();
  });

  ipcMain.on('log', (e, text) => { if (fromMain(e)) { addLog(String(text).slice(0, 200)); api.emit('log', String(text)); } });
  ipcMain.on('window:hide', (e) => { if (fromMain(e) && win) { win.hide(); addLog('Window hidden: control keeps running from the system tray'); } });
  ipcMain.on('window:quit', (e) => { if (fromMain(e)) { quitting = true; app.quit(); } });
  ipcMain.on('window:ctl', (e, m) => {
    if (!fromMain(e) || !win || win.isDestroyed() || !m) return;
    if (m.what === 'min') win.minimize();
    else if (m.what === 'max') toggleMaximize();
    else if (m.what === 'resize') startResize(String(m.edge || ''));
  });

  ipcMain.handle('measure:save', (e, obj) => {
    if (!fromMain(e)) return null;
    const dir = path.join(app.getPath('userData'), 'measurements');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `measurement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(f, JSON.stringify(obj, null, 2)); // numbers only: never an image
    if (BENCH) console.log('[measurement] ' + f + '\n' + JSON.stringify(obj, null, 2));
    return f;
  });
  ipcMain.on('measure:open-folder', (e) => {
    if (!fromMain(e)) return;
    const dir = path.join(app.getPath('userData'), 'measurements');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
}

// ─────────────────────────── watchdog ───────────────────────────
// If the camera window freezes while a button is held, we release it ourselves.
function startWatchdog() {
  setInterval(() => {
    // The camera is on but no analysed frames arrive any more: pause, to be safe.
    if (cameraState === 'on' && mode === 'active' && Date.now() - lastHudAt > 5000 && lastHudAt > 0) {
      setMode('paused', 'the camera stopped delivering frames', 'auto');
    }
    if (input.buttons.size && Date.now() - lastInputAt > 1500) {
      input.releaseAll();
      addLog('Mouse button released by the watchdog (no signal from the camera)');
    }
  }, 400).unref();
}

// ─────────────────────────── self-test (npm run build / installer) ───────────────────────────
// `Hand Control.exe --selftest` checks that everything needed is inside the app, then exits.
async function selfTest() {
  const out = { koffi: false, mouse_api: false, hotkey: killKeyOk };
  try { const v = input.virtual(); out.koffi = true; out.mouse_api = v.w > 0 && v.h > 0; } catch (e) { out.error = String(e.message || e); }
  for (const [k, u] of [['page', 'hc://app/index.html'], ['gesture_engine', 'hc://app/core/engine.mjs'], ['mediapipe', 'hc://app/vendor/vision_bundle.mjs'], ['wasm', 'hc://app/vendor/wasm/vision_wasm_internal.wasm'], ['model', 'hc://app/models/hand_landmarker.task']]) {
    try { const r = await session.defaultSession.fetch(u); out[k] = r.ok && (await r.arrayBuffer()).byteLength > 100; } catch { out[k] = false; }
  }
  const ok = Object.entries(out).every(([k, v]) => k === 'error' || v === true || k === 'hotkey');
  console.log('[selftest] ' + JSON.stringify(out));
  app.exit(ok ? 0 : 1);
}

// ─────────────────────────── startup ───────────────────────────
const gotLock = E2E ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    loadSettings();
    serveLocalFiles();
    input.realMouseWins = settings.safety.realMouseWins && !E2E;
    input.onRealMouse = () => { addLog('Physical mouse in use: hand control pauses for a moment'); send('real-mouse', Date.now()); };
    lockDownSession();
    wireIpc();
    applyScreen();
    createWindow();
    createOverlay();
    if (!E2E) createTray();
    registerHotkeys();
    startWatchdog();
    if (!E2E) input.showSystemCursor(); // a previous run may have been killed while the arrow was hidden
    setInterval(syncArrow, 250);
    setInterval(raiseOverlays, 1000);
    process.on('exit', () => { try { input.showSystemCursor(); } catch { /* ok */ } });
    if (BENCH) {
      setTimeout(() => app.getGPUInfo('basic')
        .then((i) => console.log('[gpu] ' + JSON.stringify((i.gpuDevice || []).map((d) => ({ name: d.deviceString, active: !!d.active })))))
        .catch(() => {}), 8000);
    }
    screen.on('display-metrics-changed', () => { applyScreen(); syncHandOverlay(); });
    addLog('Hand Control started — PAUSED. Hold an open hand still to activate.');
    Object.defineProperty(api, 'mode', { get: () => mode, enumerable: true });
    Object.assign(api, {
      handOverlay: () => handOv, setHandOverlay: (on) => { handOvForce = !!on; syncHandOverlay(); },
      setArrowTest: (on) => { arrowForce = !!on; syncArrow(); }, syncArrow, armAuto: () => { autoArmed = true; },
      setMode, input, actions, settings: () => settings, setSettings: (p) => { settings = merge(settings, p); send('settings', settings); },
      win: () => win, overlay: () => overlay, send, hotkeys: hotkeyInfo, blocked: () => blockedRequests,
      nowMs, userData: () => app.getPath('userData'), cameraState: () => cameraState, handSeen: () => handSeen,
    });
    resolveReady(api);
    if (flag('--selftest')) setTimeout(selfTest, 800);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    try { input.releaseAll(); } catch { /* already released */ }
    try { input.showSystemCursor(); } catch { /* ok */ }
    globalShortcut.unregisterAll();
  });
}

module.exports = api;
