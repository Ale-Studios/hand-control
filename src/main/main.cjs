// Hand Control — main process.
// This is the SECURITY AUTHORITY: the mode (ACTIVE / PAUSED / LOCKED) lives here, and no
// mouse command gets through unless we are ACTIVE, whatever the camera window says.

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, nativeTheme, screen, session, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const { DEFAULTS, DISTANCE_PRESETS, merge, enforceMinArea } = require('../core/defaults.cjs');
const { pngFor } = require('./icons.cjs');
const { Input } = require('./input.cjs');

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
  try { settings = merge(DEFAULTS, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch { settings = merge(DEFAULTS, {}); }
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
let mode = 'paused';        // paused | active | locked
let cameraState = 'off';    // off | on | error
let handSeen = false;
let hud = { holdKind: null, holdProgress: 0, pose: 'none' };
let win = null, overlay = null, tray = null;
let quitting = false;
let lastInputAt = 0;
let lastHudAt = 0;
let blockedRequests = 0;
let killKeyOk = false, pauseKeyOk = false, killKeyUsed = '';
const logLines = [];

function addLog(text) {
  const line = { t: Date.now(), text };
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
  return { mode, camera: cameraState, hand: handSeen, holdKind: hud.holdKind, holdProgress: hud.holdProgress, pose: hud.pose };
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
  if (mode !== 'active') input.releaseAll();
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
  if (!killKeyOk) addLog('WARNING: could not register the emergency shortcut. Use the red button or the fist gesture.');
  send('hotkeys', hotkeyInfo());
}
const hotkeyInfo = () => ({ kill: killKeyUsed, killOk: killKeyOk, pause: settings.safety.pauseKey, pauseOk: pauseKeyOk });

// ─────────────────────────── windows ───────────────────────────
// Glass effect (Windows 11): the window background becomes a translucent system material.
const glassMode = () => (E2E ? 'none' : settings.ui.glass);
function applyGlass() {
  if (!win || win.isDestroyed()) return;
  const g = glassMode();
  try {
    win.setBackgroundMaterial(g === 'none' ? 'none' : g);
    win.setBackgroundColor(g === 'none' ? '#16181b' : '#00000000');
  } catch { /* older Windows: no material, the opaque theme is used */ }
  send('glass', g);
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  const g = glassMode();
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 940, minHeight: 640,
    title: 'Hand Control',
    // frameless look: our own header is the title bar; Windows still draws the minimise/maximise/close buttons on top of it
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#cfd6de', height: 46 },
    backgroundColor: g === 'none' ? '#16181b' : '#00000000',
    ...(g !== 'none' ? { backgroundMaterial: g } : {}),
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
  win.on('close', () => { quitting = true; });
  win.on('closed', () => { win = null; });
  if (flag('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  if (E2E || BENCH || flag('--verbose')) {
    // page messages show up in the terminal (handy to find out what is wrong)
    win.webContents.on('console-message', (_e, level, message, line, src) => {
      if (level >= 2 || /error|fail/i.test(message)) console.log(`[page${level >= 2 ? ' ERR' : ''}] ${message} (${String(src).split('/').pop()}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.log('[page] process gone:', d.reason));
  }
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
      settings, defaults: DEFAULTS, mode, presets: DISTANCE_PRESETS, screen: { w: s.w, h: s.h },
      hotkeys: hotkeyInfo(), log: logLines, blocked: blockedRequests,
      info: { glass: glassMode(), delegate: DELEGATE, version: app.getVersion(), e2e: E2E, bench: BENCH, userData: app.getPath('userData'), displays: screen.getAllDisplays().length },
    };
  });

  ipcMain.handle('settings:set', (e, patch) => {
    if (!fromMain(e)) return null;
    const before = settings;
    settings = merge(settings, patch);
    saveSettings();
    input.realMouseWins = settings.safety.realMouseWins;
    if (settings.safety.killKey !== before.safety.killKey || settings.safety.pauseKey !== before.safety.pauseKey) registerHotkeys();
    if (settings.control.display !== before.control.display) applyScreen();
    if (settings.ui.glass !== before.ui.glass) applyGlass();
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
    let done = false;
    switch (m.type) {
      case 'move': if (active) done = input.moveNorm(+m.x, +m.y); break;
      case 'down': if (active) done = input.button(m.button === 'right' ? 'right' : 'left', true); break;
      case 'up': input.button(m.button === 'right' ? 'right' : 'left', false); done = true; break;
      case 'click': if (active) done = input.click(m.button === 'right' ? 'right' : 'left'); break;
      case 'wheel': if (active) done = input.wheel(+m.delta || 0); break;
      default: return;
    }
    const tMain = nowMs();
    api.emit('input', m, done, tMain);
    if (m.ack) e.sender.send('ack', { seq: m.ack, tMain, type: m.type, done });
  });

  ipcMain.on('camera:state', (e, s) => {
    if (!fromMain(e)) return;
    cameraState = ['on', 'off', 'error'].includes(s) ? s : 'off';
    if (cameraState !== 'on') handSeen = false;
    addLog(cameraState === 'on' ? 'Camera on' : cameraState === 'off' ? 'Camera off' : 'Camera error');
    refreshTray(); sendOverlay();
  });

  ipcMain.on('hud', (e, h) => {
    if (!fromMain(e) || !h) return;
    lastHudAt = Date.now();
    const changed = handSeen !== !!h.hand || hud.holdKind !== h.holdKind || Math.abs((hud.holdProgress || 0) - (h.holdProgress || 0)) > 0.04 || hud.pose !== h.pose;
    handSeen = !!h.hand;
    hud = { holdKind: h.holdKind || null, holdProgress: +h.holdProgress || 0, pose: h.pose || 'none' };
    if (changed) sendOverlay();
  });

  ipcMain.on('log', (e, text) => { if (fromMain(e)) { addLog(String(text).slice(0, 200)); api.emit('log', String(text)); } });
  ipcMain.on('window:hide', (e) => { if (fromMain(e) && win) { win.hide(); addLog('Window hidden: control keeps running from the system tray'); } });
  ipcMain.on('window:quit', (e) => { if (fromMain(e)) { quitting = true; app.quit(); } });

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
    if (BENCH) {
      setTimeout(() => app.getGPUInfo('basic')
        .then((i) => console.log('[gpu] ' + JSON.stringify((i.gpuDevice || []).map((d) => ({ name: d.deviceString, active: !!d.active })))))
        .catch(() => {}), 8000);
    }
    screen.on('display-metrics-changed', () => applyScreen());
    addLog('Hand Control started — PAUSED. Hold an open hand still to activate.');
    Object.defineProperty(api, 'mode', { get: () => mode, enumerable: true });
    Object.assign(api, {
      setMode, input, settings: () => settings, setSettings: (p) => { settings = merge(settings, p); send('settings', settings); },
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
    globalShortcut.unregisterAll();
  });
}

module.exports = api;
