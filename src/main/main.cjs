// Hand Control — processo principale.
// Qui sta l'AUTORITÀ sulla sicurezza: la modalità (ATTIVO / PAUSA / BLOCCATO) vive
// qui, e nessun comando del mouse passa se non siamo ATTIVI, qualunque cosa dica
// la finestra con la fotocamera.

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen, session, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const { DEFAULTS, DISTANCE_PRESETS, merge } = require('../core/defaults.cjs');
const { pngFor } = require('./icons.cjs');
const { Input } = require('./input.cjs');

const argv = process.argv.slice(1);
const flag = (n) => argv.includes(n);
const E2E = process.env.HC_E2E === '1';
const BENCH = flag('--bench');

if (process.env.HC_USER_DATA) app.setPath('userData', process.env.HC_USER_DATA);

// La finestra può restare nascosta nella barra e DEVE continuare a seguire la mano:
// Chromium di solito "addormenta" le finestre nascoste; qui lo impediamo.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Le pagine dell'app vengono servite da un protocollo interno "hc://": è un contesto sicuro
// (serve alla fotocamera) e permette al motore wasm di caricarsi senza internet.
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
      if (inside.startsWith('..') || path.isAbsolute(inside)) return new Response('vietato', { status: 403 });
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' } });
    } catch {
      return new Response('non trovato', { status: 404 });
    }
  });
}

const api = new EventEmitter(); // per i test: api.on('input', ...)
api.state = {};
let resolveReady; api.ready = new Promise((r) => { resolveReady = r; });

const nowMs = () => performance.timeOrigin + performance.now();

// ─────────────────────────── impostazioni ───────────────────────────
let settingsFile;
let settings = merge(DEFAULTS, {});
function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try { settings = merge(DEFAULTS, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch { settings = merge(DEFAULTS, {}); }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (e) { addLog('Non riesco a salvare le impostazioni: ' + e.message); }
}

// ─────────────────────────── stato ───────────────────────────
const input = new Input();
let mode = 'paused';        // paused | active | locked
let cameraState = 'off';    // off | on | error
let handSeen = false;
let hud = { holdKind: null, holdProgress: 0, pose: 'none' };
let win = null, overlay = null, tray = null;
let quitting = false;
let lastInputAt = 0;
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

// ─────────────────────────── schermo ───────────────────────────
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

// ─────────────────────────── modalità (il cuore della sicurezza) ───────────────────────────
/**
 * source: 'hotkey' | 'ui' | 'gesture' | 'auto'
 * Regole:
 *  - da BLOCCATO si esce solo da tastiera o pulsante (mai con un gesto), e si arriva in PAUSA;
 *  - uscire da ATTIVO rilascia sempre i tasti del mouse.
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
  addLog(`Modalità: ${label(mode)} — ${reason || source}`);
  send('mode', { mode, reason, source });
  refreshTray();
  sendOverlay();
  api.emit('mode', mode, reason, source);
  return mode;
}
const label = (m) => ({ active: 'ATTIVO', paused: 'IN PAUSA', locked: 'BLOCCATO' }[m]);

// ─────────────────────────── scorciatoie globali ───────────────────────────
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const tryReg = (accel, fn) => { try { return accel && globalShortcut.register(accel, fn); } catch { return false; } };
  const kill = () => setMode(mode === 'locked' ? 'paused' : 'locked', mode === 'locked' ? 'sbloccato da tastiera' : 'BLOCCO DI EMERGENZA (tastiera)', 'hotkey');
  killKeyUsed = settings.safety.killKey;
  killKeyOk = tryReg(killKeyUsed, kill);
  if (!killKeyOk) {
    // Un'altra app ha già preso la scorciatoia: ne proviamo una vicina, per non restare senza.
    const alt = killKeyUsed.replace('Alt+', 'Alt+Shift+');
    if (tryReg(alt, kill)) { killKeyUsed = alt; killKeyOk = true; addLog(`La scorciatoia ${settings.safety.killKey} era già usata: uso ${alt}`); }
  }
  pauseKeyOk = tryReg(settings.safety.pauseKey, () => {
    if (mode === 'locked') return;
    setMode(mode === 'active' ? 'paused' : 'active', mode === 'active' ? 'pausa da tastiera' : 'attivato da tastiera', 'hotkey');
  });
  if (!killKeyOk) addLog('ATTENZIONE: non sono riuscito a registrare la scorciatoia di emergenza. Usa il pulsante rosso o il gesto del pugno.');
  send('hotkeys', hotkeyInfo());
}
const hotkeyInfo = () => ({ kill: killKeyUsed, killOk: killKeyOk, pause: settings.safety.pauseKey, pauseOk: pauseKeyOk });

// ─────────────────────────── finestre ───────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 940, minHeight: 640,
    title: 'Hand Control',
    backgroundColor: '#0f1420',
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
    // i messaggi della pagina compaiono nel terminale (utile per capire cosa non va)
    win.webContents.on('console-message', (_e, level, message, line, src) => {
      if (level >= 2 || /errore|error|fail/i.test(message)) console.log(`[pagina${level >= 2 ? ' ERR' : ''}] ${message} (${String(src).split('/').pop()}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.log('[pagina] processo terminato:', d.reason));
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
  overlay.setIgnoreMouseEvents(true, { forward: false }); // non intercetta MAI un click
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
  tray.setToolTip(`Hand Control — ${label(mode)}${cameraState === 'on' ? ' — fotocamera accesa' : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Stato: ${label(mode)}`, enabled: false },
    { label: 'Mostra la finestra', click: () => showWindow() },
    { type: 'separator' },
    { label: mode === 'active' ? 'Metti in pausa' : 'Attiva il controllo', enabled: mode !== 'locked', click: () => setMode(mode === 'active' ? 'paused' : 'active', 'dal menu', 'ui') },
    { label: mode === 'locked' ? 'Sblocca (resta in pausa)' : '⛔ BLOCCO DI EMERGENZA', click: () => setMode(mode === 'locked' ? 'paused' : 'locked', mode === 'locked' ? 'sbloccato dal menu' : 'BLOCCO DI EMERGENZA (menu)', 'ui') },
    { type: 'separator' },
    { label: 'Esci', click: () => { quitting = true; app.quit(); } },
  ]));
}
function showWindow() { if (win) { win.show(); win.focus(); } }

// ─────────────────────────── sicurezza di rete e permessi ───────────────────────────
function lockDownSession() {
  const ses = session.defaultSession;
  // Niente internet, mai: tutto ciò che non è un file locale viene bloccato (e contato).
  ses.webRequest.onBeforeRequest((details, cb) => {
    if (/^(hc|file|devtools|data|blob|chrome-extension):/i.test(details.url)) return cb({});
    blockedRequests++;
    send('blocked', blockedRequests);
    cb({ cancel: true });
  });
  const mine = (wc) => win && !win.isDestroyed() && wc === win.webContents;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    // solo la nostra finestra, solo la fotocamera (video, niente microfono)
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
      info: { version: app.getVersion(), e2e: E2E, bench: BENCH, userData: app.getPath('userData'), displays: screen.getAllDisplays().length },
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
    send('settings', settings);
    return settings;
  });

  ipcMain.on('mode:set', (e, m) => {
    if (!fromMain(e) || !m) return;
    setMode(m.mode, m.reason, m.source === 'gesture' ? 'gesture' : m.source === 'auto' ? 'auto' : 'ui');
  });

  // Comandi del mouse: SEMPRE filtrati qui. Se non siamo ATTIVI, spariscono (tranne il rilascio dei tasti).
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
    addLog(cameraState === 'on' ? 'Fotocamera accesa' : cameraState === 'off' ? 'Fotocamera spenta' : 'Errore fotocamera');
    refreshTray(); sendOverlay();
  });

  ipcMain.on('hud', (e, h) => {
    if (!fromMain(e) || !h) return;
    const changed = handSeen !== !!h.hand || hud.holdKind !== h.holdKind || Math.abs((hud.holdProgress || 0) - (h.holdProgress || 0)) > 0.04 || hud.pose !== h.pose;
    handSeen = !!h.hand;
    hud = { holdKind: h.holdKind || null, holdProgress: +h.holdProgress || 0, pose: h.pose || 'none' };
    if (changed) sendOverlay();
  });

  ipcMain.on('log', (e, text) => { if (fromMain(e)) { addLog(String(text).slice(0, 200)); api.emit('log', String(text)); } });
  ipcMain.on('window:hide', (e) => { if (fromMain(e) && win) { win.hide(); addLog('Finestra nascosta: il controllo continua nella barra delle applicazioni'); } });
  ipcMain.on('window:quit', (e) => { if (fromMain(e)) { quitting = true; app.quit(); } });

  ipcMain.handle('measure:save', (e, obj) => {
    if (!fromMain(e)) return null;
    const dir = path.join(app.getPath('userData'), 'misure');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `misura-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(f, JSON.stringify(obj, null, 2)); // solo numeri: nessuna immagine
    if (BENCH) console.log('[misura] ' + f + '\n' + JSON.stringify(obj, null, 2));
    return f;
  });
  ipcMain.on('measure:open-folder', (e) => {
    if (!fromMain(e)) return;
    const dir = path.join(app.getPath('userData'), 'misure');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
}

// ─────────────────────────── guardia ───────────────────────────
// Se la finestra con la fotocamera si blocca mentre un tasto è premuto, lo rilasciamo noi.
function startWatchdog() {
  setInterval(() => {
    if (input.buttons.size && Date.now() - lastInputAt > 1500) {
      input.releaseAll();
      addLog('Tasto del mouse rilasciato dalla guardia (nessun segnale dalla fotocamera)');
    }
  }, 400).unref();
}

// ─────────────────────────── avvio ───────────────────────────
const gotLock = E2E ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    loadSettings();
    serveLocalFiles();
    input.realMouseWins = settings.safety.realMouseWins && !E2E;
    input.onRealMouse = () => { addLog('Mouse vero in uso: la mano si ferma per un attimo'); send('real-mouse', Date.now()); };
    lockDownSession();
    wireIpc();
    applyScreen();
    createWindow();
    createOverlay();
    if (!E2E) createTray();
    registerHotkeys();
    startWatchdog();
    screen.on('display-metrics-changed', () => applyScreen());
    addLog('Hand Control avviato — IN PAUSA. Mano aperta ferma per attivare.');
    Object.defineProperty(api, 'mode', { get: () => mode, enumerable: true });
    Object.assign(api, {
      setMode, input, settings: () => settings, setSettings: (p) => { settings = merge(settings, p); send('settings', settings); },
      win: () => win, overlay: () => overlay, send, hotkeys: hotkeyInfo, blocked: () => blockedRequests,
      nowMs, userData: () => app.getPath('userData'), cameraState: () => cameraState, handSeen: () => handSeen,
    });
    resolveReady(api);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    try { input.releaseAll(); } catch { /* già libero */ }
    globalShortcut.unregisterAll();
  });
}

module.exports = api;
