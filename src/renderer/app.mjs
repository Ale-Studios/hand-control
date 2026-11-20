// Hand Control — main window: wires the camera, the gestures and the interface together.
import { GestureEngine } from 'hc://app/core/engine.mjs';
import { areaFromCorners, mapToScreen, MIN_AREA } from 'hc://app/core/mapping.mjs';
import { median } from 'hc://app/core/filters.mjs';
import { Tracker } from './tracker.mjs';
import { HudRenderer } from './hud.mjs';

const hc = window.hc;
const $ = (id) => document.getElementById(id);

// ───────────────────────── state ─────────────────────────
let S = null;            // current settings
let DEFAULTS = null;
let PRESETS = {};
let ACTION_PRESETS = [];
let handOverlayOn = false; // the on-screen hand layer exists (the main process tells us)
let mode = 'paused';
let screenSize = { w: 1920, h: 1080 };
let info = {};
let cameraOn = false;
let cameraError = '';
let lastFrame = null;
let lastHud = null;
let engine = null;
let tracker = null;

const POSE_EN = {
  none: 'No hand', point: 'Pointing', pinch: 'Click (pinch)', rclick: 'Right click', ringpinch: 'Action 1 (ring)', pinkypinch: 'Action 2 (pinky)',
  scroll: 'Scrolling', open: 'Open hand', fist: 'Fist', other: '—',
};
const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

// ───────────────────────── helpers ─────────────────────────
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function patchFor(path, value) {
  const keys = path.split('.'); const root = {}; let cur = root;
  keys.forEach((k, i) => { if (i === keys.length - 1) cur[k] = value; else { cur[k] = {}; cur = cur[k]; } });
  return root;
}
function setLocal(path, value) {
  const keys = path.split('.'); let cur = S;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
  cur[keys[keys.length - 1]] = value;
}
const pct = (arr, p) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = (v, d = 1, unit = '') => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d) + unit);
const niceKey = (k) => String(k).replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ');

// ───────────────────────── log and status ─────────────────────────
function addLogLine(line) {
  const el = $('log');
  const d = document.createElement('div');
  const t = new Date(line.t);
  d.textContent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}  ${line.text}`;
  el.appendChild(d);
  while (el.children.length > 60) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function refreshStatus() {
  const chip = $('statusChip');
  let key = mode, text;
  if (!cameraOn) { key = mode === 'locked' ? 'locked' : 'off'; text = mode === 'locked' ? 'LOCKED' : 'CAMERA OFF'; }
  else if (mode === 'locked') text = 'LOCKED';
  else if (mode === 'paused') text = 'PAUSED';
  else if (lastHud && lastHud.handVisible) text = S.safety.dryRun ? 'ACTIVE · TEST MODE' : 'ACTIVE';
  else { key = 'nohand'; text = 'ACTIVE — NO HAND SEEN'; }
  chip.className = 'chip ' + key;
  $('statusText').textContent = text;

  const t = $('btnToggle');
  t.textContent = mode === 'active' ? '⏸ Pause' : '▶ Activate';
  t.disabled = mode === 'locked' || !cameraOn;
  $('btnKill').textContent = mode === 'locked' ? '🔓 Unlock (stays paused)' : '⛔ EMERGENCY LOCK';
  $('btnCam').textContent = cameraOn ? 'Turn camera off' : 'Turn camera on';
  $('camOff').className = 'camOff' + (cameraOn || (info.e2e && stat.totalFrames > 0) ? ' hidden' : '');
  $('camOff').textContent = cameraError || 'Camera off';

  const b = $('banner');
  const color = { paused: 'var(--yellow)', active: 'var(--green)', locked: 'var(--red)' }[mode];
  b.style.setProperty('--c', color);
  if (!cameraOn) b.textContent = '';
  else if (mode === 'locked') b.textContent = 'LOCKED — gestures are ignored';
  else if (!lastHud || !lastHud.handVisible) b.textContent = mode === 'paused' ? 'PAUSED — show your hand' : 'Hand not seen';
  else if (mode === 'paused') b.textContent = 'PAUSED — hold an open hand still for ~2 s to activate';
  else b.textContent = POSE_EN[lastHud.pose] || '';
}

function refreshHold() {
  const w = $('holdWrap');
  const h = lastHud;
  if (!h || !h.holdKind || h.holdProgress < 0.04 || mode === 'locked') { w.className = 'holdWrap'; return; }
  w.className = 'holdWrap on';
  const col = h.holdKind === 'lock' ? 'var(--red)' : mode === 'active' ? 'var(--yellow)' : 'var(--green)';
  w.style.setProperty('--c', col);
  $('holdBar').style.width = Math.round(h.holdProgress * 100) + '%';
  $('holdText').textContent = h.holdProgress >= 1
    ? (h.holdKind === 'lock' ? 'LOCKED' : mode === 'active' ? 'ACTIVE' : 'PAUSED')
    : h.holdKind === 'lock' ? 'Fist… emergency lock' : mode === 'active' ? 'Hold still… pause' : 'Hold still… activation';
}

// ───────────────────────── statistics ─────────────────────────
const stat = {
  frameTimes: [],         // frame instants (for fps)
  infer: [],              // recognition ms
  det: [],                // 1/0: hand seen
  lag: [],                // ms camera→app
  lat: [],                // ms photo→cursor moved (total)
  latParts: [],           // {cam, proc, ipc}
  acks: new Map(),
  seq: 0,
  totalFrames: 0,
};
const keep = (a, n) => { while (a.length > n) a.shift(); };

hc.on.ack((a) => {
  const p = stat.acks.get(a.seq);
  if (!p) return;
  stat.acks.delete(a.seq);
  if (a.type !== 'move' || !a.done || p.tCap == null) return;
  const total = a.tMain - p.tCap;
  if (total < 0 || total > 5000) return;
  stat.lat.push(total); keep(stat.lat, 300);
  const part = { total, cam: p.tStart - p.tCap, proc: p.tDone - p.tStart, ipc: a.tMain - p.tDone };
  stat.latParts.push(part); keep(stat.latParts, 300);
  if (rec.active) rec.parts.push(part);
});

function refreshStats() {
  const now = performance.now();
  stat.frameTimes = stat.frameTimes.filter((t) => now - t < 1000);
  $('sFps').textContent = cameraOn ? String(stat.frameTimes.length) : '—';
  $('sInfer').textContent = cameraOn && stat.infer.length ? fmt(mean(stat.infer.slice(-30)), 0, ' ms') : '—';
  const l = stat.lat.slice(-60);
  $('sLat').textContent = l.length ? fmt(median(l), 0, ' ms') : '—';
  const d = stat.det.slice(-90);
  $('sDet').textContent = d.length ? Math.round((100 * d.reduce((a, b) => a + b, 0)) / d.length) + '%' : '—';
  $('sPose').textContent = lastHud ? POSE_EN[lastHud.pose] || '—' : '—';
  if (!$('tab-measure').hidden) renderLive();
}

function renderLive() {
  const parts = stat.latParts.slice(-100);
  const rows = [
    ['Frames per second', $('sFps').textContent],
    ['Recognition (mean)', $('sInfer').textContent],
    ['Camera → app', fmt(median(parts.map((p) => p.cam)), 0, ' ms')],
    ['Processing', fmt(median(parts.map((p) => p.proc)), 0, ' ms')],
    ['App → mouse (IPC + SendInput)', fmt(median(parts.map((p) => p.ipc)), 1, ' ms')],
    ['TOTAL hand → cursor', fmt(median(parts.map((p) => p.total)), 0, ' ms')],
    ['… 95th percentile', fmt(pct(parts.map((p) => p.total), 95), 0, ' ms')],
    ['Engine', tracker ? tracker.delegate : '—'],
  ];
  $('live').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}

// ───────────────────────── gesture events → mouse ─────────────────────────
function onEngineEvent(e) {
  if (e.type === 'mode-request') {
    hc.setMode(e.mode, e.reason, 'gesture');
    return;
  }
  // during calibration and tests we do not move the real mouse (except releasing)
  if ((cal.active || jitter.active) && e.type !== 'up') return;
  const m = { type: e.type };
  if (e.type === 'move') { m.x = e.x; m.y = e.y; }
  else if (e.type === 'down' || e.type === 'up' || e.type === 'click') m.button = e.button;
  else if (e.type === 'wheel') m.delta = e.delta;
  else if (e.type === 'action') m.which = e.which;
  if (e.meta) m.meta = { tSend: e.meta.tSend, tCap: e.meta.tCapEpoch };
  if (e.type === 'move' && (++stat.seq % 5 === 0)) {
    m.ack = stat.seq;
    const mt = e.meta || {};
    stat.acks.set(stat.seq, { tCap: mt.tCapEpoch ?? mt.tSend, tStart: mt.tStartEpoch ?? mt.tSend, tDone: mt.tDoneEpoch ?? mt.tSend });
    if (stat.acks.size > 200) stat.acks.delete(stat.acks.keys().next().value);
  }
  if (rec.active) rec.events[e.type] = (rec.events[e.type] || 0) + 1;
  hc.input(m);
  if (info.bench && e.type === 'click') hc.log('click');
}

// ───────────────────────── one frame ─────────────────────────
let lastHudSend = 0;
function onFrame(frame) {
  lastFrame = frame;
  stat.totalFrames++;
  benchTick();
  const hud = engine.update(frame);
  lastHud = hud;
  const now = performance.now();
  stat.frameTimes.push(now);
  const mt = frame.meta || {};
  if (mt.inferMs != null) { stat.infer.push(mt.inferMs); keep(stat.infer, 300); }
  if (mt.captureLagMs != null) { stat.lag.push(mt.captureLagMs); keep(stat.lag, 300); }
  stat.det.push(frame.hands.length ? 1 : 0); keep(stat.det, 300);

  if (now - lastHudSend > 100) {
    lastHudSend = now;
    hc.hud({ hand: hud.handVisible, holdKind: hud.holdKind, holdProgress: hud.holdProgress, pose: hud.pose });
  }
  if (cal.active) calFeed(hud, frame.t);
  if (rec.active) recFeed(frame, hud);
  if (jitter.active) jitterFeed(hud);
  if (handOverlayOn) sendHandToScreen(frame, hud);
  draw(frame, hud);
  refreshHold();
}

// ───────────────────────── the hand on the screen (over every window) ─────────────────────────
function sendHandToScreen(frame, hud) {
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const hands = (frame.hands || []).map((h) => h.lm.map((p) => [r4(p.x), r4(p.y)]));
  const payload = {
    hands,
    aspect: frame.meta && frame.meta.W ? frame.meta.W / frame.meta.H : 16 / 9,
    hud: {
      handVisible: hud.handVisible, mode: hud.mode, pressed: !!hud.pressed, anchor: hud.anchor, screen: hud.screen,
      steerIndex: hud.steerIndex, poseName: POSE_EN[hud.pose] || '',
    },
  };
  if (hud.helperIndex >= 0 && frame.hands[hud.helperIndex]) {
    // the helper hand is drawn where it really points: its knuckle goes through the same mapping as the cursor
    const lm = frame.hands[hud.helperIndex].lm;
    const ax = (lm[5].x + lm[6].x) / 2, ay = (lm[5].y + lm[6].y) / 2;
    const u = S.camera.mirror ? 1 - ax : ax;
    const sc = mapToScreen(u, ay, S.control.area, S.control.sensitivity, S.control.snap);
    payload.helper = { lm: hands[hud.helperIndex], anchor: { u, v: ay }, screen: sc };
  }
  hc.handFrame(payload);
}

// ───────────────────────── preview ─────────────────────────
const video = $('video');
const ov = $('overlay');
const octx = ov.getContext('2d');
const hudr = new HudRenderer();
function draw(frame, hud) {
  if (document.hidden) return;
  let W = video.videoWidth, H = video.videoHeight;
  if (!W) { if (!info.e2e) return; W = 1280; H = 720; } // tests draw on an empty canvas
  if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
  hudr.draw(octx, W, H, { frame, hud, S, mode, screen: screenSize, poseName: hud ? POSE_EN[hud.pose] : '', helperPoseName: hud && hud.helperPose ? POSE_EN[hud.helperPose] || hud.helperPose : '', px: W / Math.max(1, ov.clientWidth) });
}

// ───────────────────────── camera ─────────────────────────
async function startCamera() {
  cameraError = '';
  if (!tracker) {
    tracker = new Tracker(video, {
      onFrame,
      onStatus: (state, msg) => {
        if (state === 'on') { cameraOn = true; hc.cameraState('on'); }
        else if (state === 'error') { cameraOn = false; cameraError = msg; hc.cameraState('error'); hc.setMode('paused', 'camera error', 'auto'); }
        else if (state === 'off') { cameraOn = false; hc.cameraState('off'); }
        if (msg) hc.log(msg);
        refreshStatus();
      },
    });
  }
  const preset = PRESETS[S.camera.distance] || PRESETS.near;
  const ok = await tracker.start({ deviceId: S.camera.deviceId, preset, numHands: S.control.hand === 'any' ? 1 : 2, delegate: info.delegate || S.camera.delegate });
  if (ok) {
    const cams = await Tracker.listCameras();
    fillCameraSelect(cams);
    // Safety net: if the graphics card produces no frame within 15 s, switch to the processor.
    const framesBefore = stat.totalFrames;
    clearTimeout(startCamera._t);
    startCamera._t = setTimeout(() => {
      if (cameraOn && stat.totalFrames === framesBefore && tracker.delegate === 'GPU') {
        hc.log('The graphics card is not responding: switching to the processor');
        S.camera.delegate = 'CPU';
        hc.setSettings({ camera: { delegate: 'CPU' } });
        startCamera();
      }
    }, 15000);
  }
  refreshStatus();
}
async function stopCamera() {
  if (tracker) await tracker.stop();
  cameraOn = false; lastHud = null; lastFrame = null;
  hc.cameraState('off');
  hc.setMode('paused', 'camera turned off', 'ui');
  octx.clearRect(0, 0, ov.width, ov.height);
  refreshStatus();
}

// ───────────────────────── settings form ─────────────────────────
const SCHEMA = () => [
  { g: 'Camera' },
  { id: 'camera.deviceId', type: 'camera', label: 'Which camera', restart: true },
  { id: 'camera.distance', type: 'select', label: 'Distance from the camera', restart: true,
    options: Object.entries(PRESETS).map(([k, v]) => [k, v.label]),
    help: 'The farther you are, the more the app zooms in around your hand (needs a 1080p camera).' },
  { id: 'camera.delegate', type: 'select', label: 'Compute engine', restart: true, options: [['auto', 'Automatic (graphics card, then processor)'], ['GPU', 'Graphics card (GPU)'], ['CPU', 'Processor (CPU)']], help: 'If you see few frames per second, try changing this.' },
  { id: 'ui.hudColor', type: 'select', label: 'HUD colour', options: [['ice', 'Ice'], ['amber', 'Amber'], ['mint', 'Mint']] },
  { id: 'ui.videoDim', type: 'range', min: 0.1, max: 1, step: 0.05, label: 'Camera image brightness', fmt: (v) => Math.round(v * 100) + '%', help: 'Lower = the HUD stands out more (and less of you is shown on screen).' },
  { id: 'ui.glass', type: 'select', label: 'Window glass effect', options: [['acrylic', 'Acrylic (see-through, blurred)'], ['mica', 'Mica (subtle)'], ['none', 'Off (solid)']], help: 'Windows 11 only.' },
  { id: 'ui.tint', type: 'range', min: 0.1, max: 0.9, step: 0.05, label: 'Glass tint', fmt: (v) => Math.round(v * 100) + '%', help: 'Lower = more see-through. Raise it if the text is hard to read over a bright background.' },
  { id: 'ui.trail', type: 'check', label: 'Show the pointer trail' },
  { id: 'ui.handOverlay', type: 'check', label: 'Draw my hand on the screen, above every window', help: 'A transparent layer that never blocks your clicks. It also shows the hand when this window is hidden.' },
  { id: 'ui.overlaySize', type: 'range', min: 120, max: 500, step: 10, label: 'Size of the hand on screen', fmt: (v) => v + ' px' },
  { id: 'ui.overlayOpacity', type: 'range', min: 0.3, max: 1, step: 0.05, label: 'Opacity of the hand on screen', fmt: (v) => Math.round(v * 100) + '%' },
  { id: 'ui.alwaysOnTop', type: 'check', label: 'Keep this window above the other apps (it is transparent)' },
  { id: 'ui.showSkeleton', type: 'check', label: 'Show the hand skeleton' },
  { id: 'ui.showArea', type: 'check', label: 'Show the active area' },
  { g: 'Cursor' },
  { id: 'control.sensitivity', type: 'range', min: 0.5, max: 3, step: 0.05, label: 'Sensitivity', fmt: (v) => v.toFixed(2) + '×', help: 'Higher = smaller movements are enough.' },
  { id: 'control.smoothing', type: 'range', min: 0, max: 1, step: 0.02, label: 'Jitter smoothing', fmt: (v) => Math.round(v * 100) + '%', help: 'Higher = steadier cursor, but a little slower to follow you.' },
  { id: 'control.area.w', type: 'range', min: 0.28, max: 1, step: 0.01, label: 'Active area — width', fmt: (v) => Math.round(v * 100) + '%' },
  { id: 'control.area.h', type: 'range', min: 0.28, max: 1, step: 0.01, label: 'Active area — height', fmt: (v) => Math.round(v * 100) + '%' },
  { id: 'control.area.cx', type: 'range', min: 0.1, max: 0.9, step: 0.01, label: 'Active area — horizontal position', fmt: (v) => Math.round(v * 100) + '%' },
  { id: 'control.area.cy', type: 'range', min: 0.1, max: 0.9, step: 0.01, label: 'Active area — vertical position', fmt: (v) => Math.round(v * 100) + '%' },
  { id: 'control.pointAt', type: 'select', label: 'Point that moves the cursor', options: [['knuckle', 'Index knuckle (steady)'], ['palm', 'Centre of the palm (steadiest)'], ['tip', 'Index fingertip (most natural)']], help: 'The palm does not move when your fingers do, so clicks land where you aimed.' },
  { id: 'control.twoHands', type: 'check', label: 'Two-hand mode: one hand steers, the other clicks, drags and scrolls', help: 'Lets you click without stopping the hand that points.' },
  { id: 'control.cursorHand', type: 'select', label: 'Steering hand (two-hand mode)', options: [['right', 'Right'], ['left', 'Left']], help: 'If it picks the wrong hand with your camera, choose the other one.' },
  { id: 'control.hand', type: 'select', label: 'Controlling hand (one-hand mode)', restart: true, options: [['any', 'Any (the closest one)'], ['right', 'Right only'], ['left', 'Left only']] },
  ...(info.displays > 1 ? [{ id: 'control.display', type: 'select', label: 'Screen to control', numeric: true, options: Array.from({ length: info.displays }, (_, i) => [i, 'Screen ' + (i + 1)]) }] : []),
  { g: 'Clicks' },
  { id: 'clicks.pinchSensitivity', type: 'range', min: 0.6, max: 1.8, step: 0.05, label: 'Pinch sensitivity', fmt: (v) => v.toFixed(2) + '×', help: 'Higher = a looser pinch is enough.' },
  { id: 'clicks.dragFreezeMs', type: 'range', min: 100, max: 700, step: 10, label: 'Cursor held still after a pinch', fmt: (v) => v + ' ms', help: 'More precise clicks; after this time, moving your hand drags.' },
  { id: 'clicks.confirmMs', type: 'range', min: 20, max: 160, step: 5, label: 'Minimum gesture duration', fmt: (v) => v + ' ms', help: 'Higher = fewer accidental clicks, but less responsive.' },
  { g: 'Actions' },
  { id: 'actions.ringPinch', type: 'select', label: 'Thumb + ring finger, held', options: ACTION_PRESETS, help: 'Keep the index finger up and touch thumb and ring finger for half a second.' },
  { id: 'actions.pinkyPinch', type: 'select', label: 'Thumb + little finger, held', options: ACTION_PRESETS },
  { id: 'actions.holdMs', type: 'range', min: 300, max: 1500, step: 50, label: 'Hold time for these gestures', fmt: (v) => v + ' ms', help: 'Longer = fewer actions by accident.' },
  { g: 'Scrolling' },
  { id: 'scroll.speed', type: 'range', min: 0.3, max: 3, step: 0.1, label: 'Speed', fmt: (v) => v.toFixed(1) + '×' },
  { id: 'scroll.natural', type: 'check', label: '"Natural" scrolling (hand up = content up)' },
  { g: 'Safety' },
  { id: 'safety.activateHoldMs', type: 'range', min: 800, max: 3500, step: 100, label: 'Time to ACTIVATE (open hand held still)', fmt: (v) => (v / 1000).toFixed(1) + ' s', help: 'Longer = harder to activate by accident.' },
  { id: 'safety.pauseHoldMs', type: 'range', min: 500, max: 3000, step: 100, label: 'Time to PAUSE', fmt: (v) => (v / 1000).toFixed(1) + ' s' },
  { id: 'safety.lockHoldMs', type: 'range', min: 500, max: 3000, step: 100, label: 'Fist time for the EMERGENCY LOCK', fmt: (v) => (v / 1000).toFixed(1) + ' s' },
  { id: 'safety.autoPauseSec', type: 'range', min: 0, max: 120, step: 5, label: 'Auto-pause when the hand is not seen', fmt: (v) => (v === 0 ? 'never' : v + ' s') },
  { id: 'safety.realMouseWins', type: 'check', label: 'If I move the physical mouse, hand control pauses for a moment' },
  { id: 'safety.dryRun', type: 'check', label: 'Test mode: show what would happen, without touching the mouse or keyboard', help: 'Nothing is sent to Windows: the log tells what each gesture WOULD do.' },
];

let formBuilt = false;
function buildForm() {
  const root = $('settingsForm');
  root.innerHTML = '';
  for (const f of SCHEMA()) {
    if (f.g) { const g = document.createElement('div'); g.className = 'group'; g.textContent = f.g; root.appendChild(g); continue; }
    const wrap = document.createElement('div'); wrap.className = 'set' + (f.type === 'check' ? ' check' : '');
    const val = getPath(S, f.id);
    if (f.type === 'range') {
      wrap.innerHTML = `<label><span>${f.label}</span><em></em></label><input type="range" min="${f.min}" max="${f.max}" step="${f.step}"><div class="help">${f.help || ''}</div>`;
      const inp = wrap.querySelector('input'), em = wrap.querySelector('em');
      inp.value = val; em.textContent = f.fmt(+val);
      inp.addEventListener('input', () => { const v = +inp.value; em.textContent = f.fmt(v); changeSetting(f, v); });
      f.el = inp; f.em = em;
    } else if (f.type === 'check') {
      wrap.innerHTML = `<label><input type="checkbox"> <span>${f.label}</span></label>`;
      const inp = wrap.querySelector('input'); inp.checked = !!val;
      inp.addEventListener('change', () => changeSetting(f, inp.checked));
    } else {
      const sel = document.createElement('select');
      if (f.type === 'camera') sel.innerHTML = '<option value="">Default</option>';
      else for (const [v, l] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); }
      wrap.innerHTML = `<label><span>${f.label}</span></label>`; wrap.appendChild(sel);
      if (f.help) { const h = document.createElement('div'); h.className = 'help'; h.textContent = f.help; wrap.appendChild(h); }
      if (f.id.startsWith('actions.') && !f.options.some(([v]) => v === val)) { const o = document.createElement('option'); o.value = val; o.textContent = 'Custom: ' + val; sel.appendChild(o); }
      sel.value = val;
      sel.addEventListener('change', () => changeSetting(f, f.numeric ? +sel.value : sel.value));
      if (f.type === 'camera') cameraSelect = sel;
    }
    root.appendChild(wrap);
  }
  formBuilt = true;
}
let cameraSelect = null;
function fillCameraSelect(cams) {
  if (!cameraSelect) return;
  cameraSelect.innerHTML = '<option value="">Default</option>' + cams.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
  cameraSelect.value = S.camera.deviceId || '';
}
let patchTimer = null; let pendingPatch = {};
function changeSetting(f, value) {
  setLocal(f.id, value);
  if (f.id.startsWith('ui.')) applyUi();
  deepMerge(pendingPatch, patchFor(f.id, value));
  clearTimeout(patchTimer);
  patchTimer = setTimeout(async () => {
    const p = pendingPatch; pendingPatch = {};
    await hc.setSettings(p);
    if (f.restart && cameraOn) startCamera();
    if (f.id === 'camera.mirror') applyMirror();
  }, 150);
}
function deepMerge(a, b) { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object') { a[k] = a[k] || {}; deepMerge(a[k], b[k]); } else a[k] = b[k]; } }
function applyMirror() { $('viewport').classList.toggle('nomirror', !S.camera.mirror); applyUi(); }
function applyUi() {
  document.documentElement.dataset.hud = S.ui.hudColor;
  $('viewport').style.setProperty('--vdim', String(S.ui.videoDim));
  document.documentElement.style.setProperty('--tint', String(S.ui.tint));
}
function setGlass(g) { document.documentElement.classList.toggle('glass', g !== 'none'); }

function syncFormFromSettings() {
  if (!formBuilt) return;
  // simplest: rebuild (settings rarely change from outside)
  buildForm();
}

// ───────────────────────── calibration ─────────────────────────
const cal = { active: false, step: 0, pts: [], samples: [] };
const CAL_STEPS = [
  { title: '1/2 — TOP-LEFT corner', sub: 'Reach out as is comfortable and point your index finger at the top-left corner of the screen. Hold still.' },
  { title: '2/2 — BOTTOM-RIGHT corner', sub: 'Now point at the bottom-right corner of the screen. Hold still.' },
];
function calStart() {
  if (!cameraOn) return;
  cal.active = true; cal.step = 0; cal.pts = []; cal.samples = [];
  $('calibBox').hidden = false; calShow();
  hc.log('Area calibration: started');
}
function calShow(msg) {
  const s = CAL_STEPS[cal.step];
  $('calibTitle').textContent = msg ? msg : s.title;
  $('calibSub').textContent = msg ? '' : s.sub;
  $('calibFill').style.width = '0%';
}
function calStop() { cal.active = false; $('calibBox').hidden = true; }
function calFeed(hud, t) {
  if (!hud.handVisible || !hud.anchor) { cal.samples = []; $('calibFill').style.width = '0%'; return; }
  const p = { t, u: hud.anchor.u, v: hud.anchor.v };
  const first = cal.samples[0];
  if (first && Math.hypot(p.u - first.u, p.v - first.v) > 0.035) cal.samples = [];
  cal.samples.push(p);
  const dur = p.t - cal.samples[0].t;
  $('calibFill').style.width = Math.min(100, (dur / 1500) * 100) + '%';
  if (dur >= 1500) {
    cal.pts.push({ u: median(cal.samples.map((s) => s.u)), v: median(cal.samples.map((s) => s.v)) });
    cal.samples = []; cal.step++;
    if (cal.step < 2) { calShow(); return; }
    const [a, b] = cal.pts;
    if (Math.abs(a.u - b.u) < 0.06 || Math.abs(a.v - b.v) < 0.04) {
      $('calibTitle').textContent = 'The two points are too close together';
      $('calibSub').textContent = 'Move your arm more between one corner and the other. Try again.';
      setTimeout(calStop, 2500); hc.log('Calibration failed: points too close');
      return;
    }
    const area = areaFromCorners(a, b);
    // sensitivity 1 = exact area; we save it as the area and reset sensitivity to 1
    S.control.area = area; S.control.sensitivity = 1;
    hc.setSettings({ control: { area, sensitivity: 1 } });
    syncFormFromSettings();
    // measured spread (with the margin) smaller than the minimum area → the area was enlarged
    const small = Math.abs(b.u - a.u) * 1.12 < MIN_AREA || Math.abs(b.v - a.v) * 1.12 < MIN_AREA;
    $('calibTitle').textContent = 'Done! Active area set';
    $('calibSub').textContent = small
      ? 'You moved your arm very little, so I used the minimum area. For better precision, reach further between the two corners and calibrate again.'
      : 'The bracketed rectangle in the preview is your area.';
    setTimeout(calStop, small ? 5000 : 2200);
    hc.log('Calibration completed');
  }
}

// ───────────────────────── measurements ─────────────────────────
const rec = { active: false, t0: 0, frames: 0, infer: [], lag: [], det: [], poses: {}, events: {}, parts: [], roiSizes: [] };
function recStart() {
  if (!cameraOn) return;
  Object.assign(rec, { active: true, t0: performance.now(), frames: 0, infer: [], lag: [], det: [], poses: {}, events: {}, parts: [], roiSizes: [] });
  $('btnRec').disabled = true;
  const tick = setInterval(() => {
    const left = 20 - (performance.now() - rec.t0) / 1000;
    $('recStatus').textContent = left > 0 ? `recording… ${Math.ceil(left)} s` : '';
    if (left <= 0) { clearInterval(tick); recEnd(); }
  }, 250);
  $('measureOut').textContent = 'Recording: use the gestures normally (move, pinch, scroll) for 20 seconds.';
}
function recFeed(frame, hud) {
  rec.frames++;
  const mt = frame.meta || {};
  if (mt.inferMs != null) rec.infer.push(mt.inferMs);
  if (mt.captureLagMs != null) rec.lag.push(mt.captureLagMs);
  rec.det.push(frame.hands.length ? 1 : 0);
  rec.poses[hud.pose] = (rec.poses[hud.pose] || 0) + 1;
  if (mt.roi) rec.roiSizes.push(Math.round(mt.roi.w) + 'x' + Math.round(mt.roi.h));
}
const dist1 = (a) => ({ mean: mean(a), p50: pct(a, 50), p95: pct(a, 95), max: a.length ? Math.max(...a) : null });
async function recEnd() {
  rec.active = false;
  $('btnRec').disabled = false;
  const dur = (performance.now() - rec.t0) / 1000;
  const total = rec.parts.map((p) => p.total);
  const result = {
    type: 'recording', when: new Date().toISOString(), duration_s: +dur.toFixed(1),
    camera: { resolution: `${video.videoWidth}x${video.videoHeight}`, distance: S.camera.distance, engine: tracker && tracker.delegate },
    frames: rec.frames, mean_fps: +(rec.frames / dur).toFixed(1),
    hand_seen_percent: rec.det.length ? +(100 * mean(rec.det)).toFixed(1) : null,
    recognition_ms: dist1(rec.infer),
    camera_to_app_ms: dist1(rec.lag),
    total_hand_to_cursor_ms: { samples: total.length, ...dist1(total), note: 'from the camera photo to the moved cursor; does not include display lag' },
    parts_ms: { camera_to_app: median(rec.parts.map((p) => p.cam)), processing: median(rec.parts.map((p) => p.proc)), ipc_and_mouse: median(rec.parts.map((p) => p.ipc)) },
    gestures_counted: rec.poses, events_sent: rec.events,
    settings: { sensitivity: S.control.sensitivity, smoothing: S.control.smoothing, area: S.control.area },
  };
  if (info.bench) setTimeout(() => hc.quit(), 1500);
  await showResult('20-second recording', result, [
    `Frames per second: ${result.mean_fps}`,
    `Hand seen in ${fmt(result.hand_seen_percent, 0)}% of frames`,
    `Recognition: mean ${fmt(result.recognition_ms.mean, 1)} ms, 95th pct ${fmt(result.recognition_ms.p95, 1)} ms`,
    `Total hand→cursor delay: median ${fmt(result.total_hand_to_cursor_ms.p50, 0)} ms, 95th pct ${fmt(result.total_hand_to_cursor_ms.p95, 0)} ms (${total.length} samples)`,
    `   of which camera→app ${fmt(result.parts_ms.camera_to_app, 0)} ms, processing ${fmt(result.parts_ms.processing, 0)} ms, mouse ${fmt(result.parts_ms.ipc_and_mouse, 1)} ms`,
    `Gestures: ${Object.entries(rec.poses).map(([k, v]) => `${POSE_EN[k] || k} ${v}`).join(', ')}`,
  ]);
}
async function showResult(title, obj, lines) {
  let path = '';
  try { path = await hc.saveMeasure(obj); } catch { /* not fatal */ }
  $('measureOut').textContent = `${title}\n${lines.join('\n')}\n\n${path ? 'Saved to: ' + path : ''}`;
}

// jitter test
const jitter = { active: false, raw: [], out: [], t0: 0 };
function jitterStart() {
  if (!cameraOn) return;
  Object.assign(jitter, { active: true, raw: [], out: [], t0: performance.now() });
  $('measureOut').textContent = 'Hold your hand still, index finger extended, for 5 seconds…';
  $('btnJitter').disabled = true;
}
function jitterFeed(hud) {
  if (!hud.handVisible || !hud.anchor) return;
  const sc = mapToScreen(hud.anchor.u, hud.anchor.v, S.control.area, S.control.sensitivity, S.control.snap);
  jitter.raw.push({ x: sc.x * screenSize.w, y: sc.y * screenSize.h });
  jitter.out.push({ x: hud.screen.x * screenSize.w, y: hud.screen.y * screenSize.h });
  if (performance.now() - jitter.t0 > 5000) jitterEnd();
}
const sd2 = (pts) => {
  if (pts.length < 2) return null;
  const mx = mean(pts.map((p) => p.x)), my = mean(pts.map((p) => p.y));
  return Math.sqrt(mean(pts.map((p) => (p.x - mx) ** 2 + (p.y - my) ** 2)));
};
async function jitterEnd() {
  jitter.active = false; $('btnJitter').disabled = false;
  const r = sd2(jitter.raw), o = sd2(jitter.out);
  const result = { type: 'jitter', when: new Date().toISOString(), samples: jitter.raw.length, raw_jitter_px: r, smoothed_jitter_px: o, reduction: r && o ? r / o : null, smoothing: S.control.smoothing, sensitivity: S.control.sensitivity };
  await showResult('Jitter test', result, jitter.raw.length < 20
    ? ['Too few samples: the hand was not seen long enough. Try again.']
    : [`Samples: ${jitter.raw.length}`, `Raw jitter (standard deviation): ${fmt(r, 1)} px on screen`, `After smoothing: ${fmt(o, 1)} px`, `Reduction: ${fmt(result.reduction, 1)}×`, 'Goal: below ~3 px when still.']);
}

// precision test (targets to click with a pinch)
const prec = { active: false, i: 0, targets: [], results: [], t0: 0, misses: 0 };
async function precStart() {
  if (mode !== 'active') { $('measureOut').textContent = 'Activate control first (hold an open hand still for ~2 s), then try again: the targets are clicked with a pinch.'; return; }
  try { await document.documentElement.requestFullscreen(); } catch { /* carry on in a window */ }
  prec.active = true; prec.i = 0; prec.results = []; prec.misses = 0;
  const xs = [0.12, 0.5, 0.88], ys = [0.18, 0.5, 0.82];
  prec.targets = []; for (const y of ys) for (const x of xs) prec.targets.push({ x, y });
  prec.targets.sort(() => Math.random() - 0.5);
  $('precision').hidden = false;
  precNext();
}
function precNext() {
  if (prec.i >= prec.targets.length) return precEnd(false);
  const t = prec.targets[prec.i];
  const el = $('target');
  el.style.left = t.x * innerWidth + 'px'; el.style.top = t.y * innerHeight + 'px';
  $('precText').textContent = `Target ${prec.i + 1} of ${prec.targets.length} — point and pinch`;
  prec.t0 = performance.now(); prec.misses = 0;
}
document.addEventListener('mousedown', (e) => {
  if (!prec.active) return;
  if (e.target && e.target.id === 'precStop') return;
  const t = prec.targets[prec.i]; const cx = t.x * innerWidth, cy = t.y * innerHeight;
  const err = Math.hypot(e.clientX - cx, e.clientY - cy);
  const ms = performance.now() - prec.t0;
  const hit = err <= 28;
  if (hit || prec.misses >= 2) { prec.results.push({ hit, err, ms, misses: prec.misses }); prec.i++; precNext(); }
  else prec.misses++;
});
async function precEnd(aborted) {
  prec.active = false; $('precision').hidden = true;
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* ok */ } }
  const r = prec.results; const hits = r.filter((x) => x.hit);
  const result = {
    type: 'precision', when: new Date().toISOString(), aborted, targets: r.length,
    hit: hits.length, error_px: dist1(r.map((x) => x.err)), time_ms: dist1(hits.map((x) => x.ms)),
    stray_clicks: r.reduce((a, x) => a + x.misses, 0), target_radius_px: 28,
    settings: { sensitivity: S.control.sensitivity, smoothing: S.control.smoothing, area: S.control.area, freeze_ms: S.clicks.dragFreezeMs },
  };
  await showResult('Precision test', result, r.length ? [
    `Targets hit: ${hits.length} of ${r.length}`,
    `Mean click error: ${fmt(result.error_px.mean, 1)} px (median ${fmt(result.error_px.p50, 1)}, worst ${fmt(result.error_px.max, 0)})`,
    `Time to hit: median ${fmt(result.time_ms.p50 / 1000, 1)} s, 95th pct ${fmt(result.time_ms.p95 / 1000, 1)} s`,
    `Stray clicks: ${result.stray_clicks}`,
  ] : ['No targets hit.']);
}

// ───────────────────────── e2e (only when the test launches the app) ─────────────────────────
function wireE2E() {
  hc.on.e2eFrame((f) => {
    // the test sends fake hands: exactly the same path as real gestures
    const frame = { t: f.t, hands: f.hands || [], meta: { tCapEpoch: f.tSend, tStartEpoch: f.tSend, tDoneEpoch: f.tSend, tSend: f.tSend } };
    onFrame(frame);
  });
}

// ───────────────────────── startup ─────────────────────────
async function init() {
  const st = await hc.getState();
  S = st.settings; DEFAULTS = st.defaults; PRESETS = st.presets; ACTION_PRESETS = st.actionPresets || []; mode = st.mode; screenSize = st.screen; info = st.info;
  $('ver').textContent = 'v' + info.version;
  engine = new GestureEngine(() => S, onEngineEvent);
  engine.setScreen(screenSize.w, screenSize.h);
  engine.setMode(mode);
  $('blocked').textContent = st.blocked;
  st.log.forEach(addLogLine);
  showHotkeys(st.hotkeys);
  buildForm(); applyMirror(); setGlass(info.glass);

  hc.on.mode((m) => { mode = m.mode; engine.setMode(mode); refreshStatus(); refreshHold(); });
  hc.on.settings((s) => { S = s; syncFormFromSettings(); applyMirror(); });
  hc.on.glass(setGlass);
  hc.on.handOverlay((on) => { handOverlayOn = !!on; });
  handOverlayOn = !!info.handOverlay;
  hc.on.screen((s) => { screenSize = s; engine.setScreen(s.w, s.h); });
  hc.on.log(addLogLine);
  hc.on.hotkeys(showHotkeys);
  hc.on.blocked((n) => { $('blocked').textContent = n; });
  hc.on.realMouse(() => { const n = $('mouseNote'); n.hidden = false; clearTimeout(n._t); n._t = setTimeout(() => { n.hidden = true; }, 2500); });

  // buttons
  $('btnToggle').onclick = () => hc.setMode(mode === 'active' ? 'paused' : 'active', mode === 'active' ? 'paused from the button' : 'activated from the button', 'ui');
  $('btnKill').onclick = () => hc.setMode(mode === 'locked' ? 'paused' : 'locked', mode === 'locked' ? 'unlocked from the button' : 'EMERGENCY LOCK (button)', 'ui');
  $('btnHide').onclick = () => hc.hide();
  $('btnQuit').onclick = () => hc.quit();
  $('btnCam').onclick = () => (cameraOn ? stopCamera() : startCamera());
  $('btnCalib').onclick = calStart;
  $('calibCancel').onclick = () => { calStop(); hc.log('Calibration cancelled'); };
  $('btnRec').onclick = recStart;
  $('btnJitter').onclick = jitterStart;
  $('btnPrec').onclick = precStart;
  $('precStop').onclick = () => precEnd(true);
  $('btnOpenMeasures').onclick = () => hc.openMeasures();
  $('btnReset').onclick = async () => {
    S = await hc.setSettings(JSON.parse(JSON.stringify(DEFAULTS)));
    syncFormFromSettings(); applyMirror();
    if (cameraOn) startCamera();
  };
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + b.dataset.tab; });
    if (b.dataset.tab === 'measure') renderLive();
  }));
  // Esc closes the precision test
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && prec.active) precEnd(true); });

  setInterval(() => { refreshStats(); refreshStatus(); }, 250);
  refreshStatus();

  if (info.e2e) { wireE2E(); hc.log('RENDERER_READY'); return; }
  if (S.ui.startCamera) startCamera();
}
let benchArmed = false;
function benchTick() {
  // the first GPU run is slow (it compiles programs): recording starts 8 s after the first frame
  if (info.bench && !benchArmed) { benchArmed = true; setTimeout(recStart, 8000); }
}
function showHotkeys(h) {
  $('hkKill').textContent = niceKey(h.kill) + (h.killOk ? ' ✔' : ' ✖ (unavailable)');
  $('hkPause').textContent = niceKey(h.pause) + (h.pauseOk ? ' ✔' : ' ✖');
}

init().catch((e) => { console.error(e); document.body.insertAdjacentHTML('afterbegin', '<pre style="color:#f88">Startup error: ' + (e && e.message) + '</pre>'); });
