// Hand Control — finestra principale: collega fotocamera, gesti e interfaccia.
import { GestureEngine } from 'hc://app/core/engine.mjs';
import { areaFromCorners, mapToScreen } from 'hc://app/core/mapping.mjs';
import { median } from 'hc://app/core/filters.mjs';
import { Tracker } from './tracker.mjs';

const hc = window.hc;
const $ = (id) => document.getElementById(id);

// ───────────────────────── stato ─────────────────────────
let S = null;            // impostazioni correnti
let DEFAULTS = null;
let PRESETS = {};
let mode = 'paused';
let screenSize = { w: 1920, h: 1080 };
let info = {};
let cameraOn = false;
let cameraError = '';
let lastFrame = null;
let lastHud = null;
let engine = null;
let tracker = null;

const POSE_IT = {
  none: 'Nessuna mano', point: 'Puntamento', pinch: 'Click (pizzico)', rclick: 'Click destro',
  scroll: 'Scorrimento', open: 'Mano aperta', fist: 'Pugno', other: '—',
};
const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

// ───────────────────────── utilità ─────────────────────────
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

// ───────────────────────── registro e stato ─────────────────────────
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
  if (!cameraOn) { key = mode === 'locked' ? 'locked' : 'off'; text = mode === 'locked' ? 'BLOCCATO' : 'FOTOCAMERA SPENTA'; }
  else if (mode === 'locked') text = 'BLOCCATO';
  else if (mode === 'paused') text = 'IN PAUSA';
  else if (lastHud && lastHud.handVisible) text = 'ATTIVO';
  else { key = 'nohand'; text = 'ATTIVO — MANO NON VISTA'; }
  chip.className = 'chip ' + key;
  $('statusText').textContent = text;

  const t = $('btnToggle');
  t.textContent = mode === 'active' ? '⏸ Metti in pausa' : '▶ Attiva';
  t.disabled = mode === 'locked' || !cameraOn;
  $('btnKill').textContent = mode === 'locked' ? '🔓 Sblocca (resta in pausa)' : '⛔ BLOCCO DI EMERGENZA';
  $('btnCam').textContent = cameraOn ? 'Spegni la fotocamera' : 'Accendi la fotocamera';
  $('camOff').className = 'camOff' + (cameraOn ? ' hidden' : '');
  $('camOff').textContent = cameraError || 'Fotocamera spenta';

  const b = $('banner');
  const color = { paused: 'var(--yellow)', active: 'var(--green)', locked: 'var(--red)' }[mode];
  b.style.setProperty('--c', color);
  if (!cameraOn) b.textContent = '';
  else if (mode === 'locked') b.textContent = 'BLOCCATO — i gesti sono ignorati';
  else if (!lastHud || !lastHud.handVisible) b.textContent = mode === 'paused' ? 'IN PAUSA — mostra la mano' : 'Mano non vista';
  else if (mode === 'paused') b.textContent = 'IN PAUSA — mano aperta ferma ~2 s per attivare';
  else b.textContent = POSE_IT[lastHud.pose] || '';
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
    ? (h.holdKind === 'lock' ? 'BLOCCATO' : mode === 'active' ? 'ATTIVO' : 'IN PAUSA')
    : h.holdKind === 'lock' ? 'Pugno… blocco di emergenza' : mode === 'active' ? 'Tieni ferma… pausa' : 'Tieni ferma… attivazione';
}

// ───────────────────────── statistiche ─────────────────────────
const stat = {
  frameTimes: [],         // istanti dei fotogrammi (per i fps)
  infer: [],              // ms di riconoscimento
  det: [],                // 1/0: mano vista
  lag: [],                // ms fotocamera→app
  lat: [],                // ms foto→cursore spostato (totale)
  latParts: [],           // {cam, proc, ipc}
  acks: new Map(),
  seq: 0,
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
  $('sPose').textContent = lastHud ? POSE_IT[lastHud.pose] || '—' : '—';
  if (!$('tab-misure').hidden) renderLive();
}

function renderLive() {
  const parts = stat.latParts.slice(-100);
  const rows = [
    ['Immagini al secondo', $('sFps').textContent],
    ['Riconoscimento (medio)', $('sInfer').textContent],
    ['Fotocamera → app', fmt(median(parts.map((p) => p.cam)), 0, ' ms')],
    ['Elaborazione', fmt(median(parts.map((p) => p.proc)), 0, ' ms')],
    ['App → mouse (IPC+SendInput)', fmt(median(parts.map((p) => p.ipc)), 1, ' ms')],
    ['TOTALE mano → cursore', fmt(median(parts.map((p) => p.total)), 0, ' ms')],
    ['… 95° percentile', fmt(pct(parts.map((p) => p.total), 95), 0, ' ms')],
    ['Motore', tracker ? tracker.delegate : '—'],
  ];
  $('live').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}

// ───────────────────────── eventi dei gesti → mouse ─────────────────────────
function onEngineEvent(e) {
  if (e.type === 'mode-request') {
    hc.setMode(e.mode, e.reason, 'gesture');
    return;
  }
  // durante calibrazione e prove non muoviamo il mouse vero (tranne rilasciare)
  if ((cal.active || jitter.active) && e.type !== 'up') return;
  const m = { type: e.type };
  if (e.type === 'move') { m.x = e.x; m.y = e.y; }
  else if (e.type === 'down' || e.type === 'up' || e.type === 'click') m.button = e.button;
  else if (e.type === 'wheel') m.delta = e.delta;
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

// ───────────────────────── un fotogramma ─────────────────────────
let lastHudSend = 0;
function onFrame(frame) {
  lastFrame = frame;
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
  if (!info.e2e) draw(frame, hud);
  refreshHold();
}

// ───────────────────────── anteprima ─────────────────────────
const video = $('video');
const ov = $('overlay');
const octx = ov.getContext('2d');
function draw(frame, hud) {
  if (document.hidden) return;
  const W = video.videoWidth, H = video.videoHeight;
  if (!W) return;
  if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
  octx.clearRect(0, 0, W, H);
  const lw = Math.max(2, W / 420);
  const mirror = S.camera.mirror;
  const toX = (u) => (mirror ? 1 - u : u) * W; // u è già "a specchio": torniamo alle coordinate immagine
  const roi = frame.meta && frame.meta.roi;
  if (roi && (roi.w < W * 0.98 || roi.h < H * 0.98)) {
    octx.setLineDash([lw * 3, lw * 3]); octx.strokeStyle = 'rgba(120,200,255,.55)'; octx.lineWidth = lw;
    octx.strokeRect(roi.x, roi.y, roi.w, roi.h); octx.setLineDash([]);
  }
  if (S.ui.showArea) {
    const a = S.control.area, g = Math.max(0.2, S.control.sensitivity);
    const w = a.w / g, h = a.h / g;
    const x0 = toX(a.cx - w / 2), x1 = toX(a.cx + w / 2);
    octx.strokeStyle = mode === 'active' ? 'rgba(34,197,94,.9)' : 'rgba(234,179,8,.9)';
    octx.lineWidth = lw * 1.4; octx.setLineDash([lw * 5, lw * 3]);
    octx.strokeRect(Math.min(x0, x1), (a.cy - h / 2) * H, Math.abs(x1 - x0), h * H);
    octx.setLineDash([]);
  }
  if (S.ui.showSkeleton) {
    frame.hands.forEach((hand, i) => {
      const main = hud && hud.handVisible && i === 0;
      octx.strokeStyle = main ? '#7fe9ff' : 'rgba(255,255,255,.35)'; octx.lineWidth = lw;
      for (const [p, q] of HAND_CONNECTIONS) {
        octx.beginPath(); octx.moveTo(hand.lm[p].x * W, hand.lm[p].y * H); octx.lineTo(hand.lm[q].x * W, hand.lm[q].y * H); octx.stroke();
      }
      octx.fillStyle = main ? '#37c6ff' : 'rgba(255,255,255,.5)';
      for (const p of hand.lm) { octx.beginPath(); octx.arc(p.x * W, p.y * H, lw * 1.4, 0, Math.PI * 2); octx.fill(); }
    });
  }
  if (hud && hud.anchor) {
    const x = toX(hud.anchor.u), y = hud.anchor.v * H;
    octx.beginPath(); octx.arc(x, y, lw * 5, 0, Math.PI * 2);
    octx.strokeStyle = hud.pressed ? '#ef4444' : mode === 'active' ? '#22c55e' : '#eab308'; octx.lineWidth = lw * 1.6; octx.stroke();
  }
}

// ───────────────────────── fotocamera ─────────────────────────
async function startCamera() {
  cameraError = '';
  if (!tracker) {
    tracker = new Tracker(video, {
      onFrame,
      onStatus: (state, msg) => {
        if (state === 'on') { cameraOn = true; hc.cameraState('on'); }
        else if (state === 'error') { cameraOn = false; cameraError = msg; hc.cameraState('error'); hc.setMode('paused', 'errore fotocamera', 'auto'); }
        else if (state === 'off') { cameraOn = false; hc.cameraState('off'); }
        if (msg) hc.log(msg);
        refreshStatus();
      },
    });
  }
  const preset = PRESETS[S.camera.distance] || PRESETS.near;
  const ok = await tracker.start({ deviceId: S.camera.deviceId, preset, numHands: S.control.hand === 'any' ? 1 : 2 });
  if (ok) {
    const cams = await Tracker.listCameras();
    fillCameraSelect(cams);
  }
  refreshStatus();
}
async function stopCamera() {
  if (tracker) await tracker.stop();
  cameraOn = false; lastHud = null; lastFrame = null;
  hc.cameraState('off');
  hc.setMode('paused', 'fotocamera spenta', 'ui');
  octx.clearRect(0, 0, ov.width, ov.height);
  refreshStatus();
}

// ───────────────────────── impostazioni (form) ─────────────────────────
const SCHEMA = () => [
  { g: 'Fotocamera' },
  { id: 'camera.deviceId', type: 'camera', label: 'Quale fotocamera', restart: true },
  { id: 'camera.distance', type: 'select', label: 'Distanza dalla fotocamera', restart: true,
    options: Object.entries(PRESETS).map(([k, v]) => [k, v.label]),
    help: 'Più sei lontano, più il programma ingrandisce attorno alla mano (serve una fotocamera 1080p).' },
  { id: 'ui.showSkeleton', type: 'check', label: 'Mostra lo scheletro della mano' },
  { id: 'ui.showArea', type: 'check', label: 'Mostra l\'area attiva' },
  { g: 'Cursore' },
  { id: 'control.sensitivity', type: 'range', min: 0.5, max: 3, step: 0.05, label: 'Sensibilità', fmt: (v) => v.toFixed(2) + '×', help: 'Più alta = bastano movimenti più piccoli.' },
  { id: 'control.smoothing', type: 'range', min: 0, max: 1, step: 0.02, label: 'Smorzamento del tremolio', fmt: (v) => Math.round(v * 100) + '%', help: 'Più alto = cursore più fermo, ma un po\' più lento a seguirti.' },
  { id: 'control.area.w', type: 'range', min: 0.15, max: 1, step: 0.01, label: 'Area attiva — larghezza', fmt: (v) => Math.round(v * 100) + '%' },
  { id: 'control.area.h', type: 'range', min: 0.15, max: 1, step: 0.01, label: 'Area attiva — altezza', fmt: (v) => Math.round(v * 100) + '%' },
  { id: 'control.area.cx', type: 'range', min: 0.1, max: 0.9, step: 0.01, label: 'Area attiva — posizione orizzontale', fmt: (v) => Math.round(v * 100) + '%' },
  { id: 'control.area.cy', type: 'range', min: 0.1, max: 0.9, step: 0.01, label: 'Area attiva — posizione verticale', fmt: (v) => Math.round(v * 100) + '%' },
  { id: 'control.pointAt', type: 'select', label: 'Punto che muove il cursore', options: [['knuckle', 'Nocca dell\'indice (più stabile)'], ['tip', 'Punta dell\'indice']] },
  { id: 'control.hand', type: 'select', label: 'Mano di controllo', restart: true, options: [['any', 'Qualsiasi (la più vicina)'], ['right', 'Solo destra'], ['left', 'Solo sinistra']] },
  ...(info.displays > 1 ? [{ id: 'control.display', type: 'select', label: 'Schermo da controllare', numeric: true, options: Array.from({ length: info.displays }, (_, i) => [i, 'Schermo ' + (i + 1)]) }] : []),
  { g: 'Click' },
  { id: 'clicks.pinchSensitivity', type: 'range', min: 0.6, max: 1.8, step: 0.05, label: 'Sensibilità del pizzico', fmt: (v) => v.toFixed(2) + '×', help: 'Più alta = basta un pizzico meno stretto.' },
  { id: 'clicks.dragFreezeMs', type: 'range', min: 100, max: 700, step: 10, label: 'Cursore fermo dopo il pizzico', fmt: (v) => v + ' ms', help: 'Click più preciso; oltre questo tempo, muovendo la mano, trascini.' },
  { id: 'clicks.confirmMs', type: 'range', min: 20, max: 160, step: 5, label: 'Durata minima di un gesto', fmt: (v) => v + ' ms', help: 'Più alto = meno click per sbaglio, ma meno pronto.' },
  { g: 'Scorrimento' },
  { id: 'scroll.speed', type: 'range', min: 0.3, max: 3, step: 0.1, label: 'Velocità', fmt: (v) => v.toFixed(1) + '×' },
  { id: 'scroll.natural', type: 'check', label: 'Scorrimento "naturale" (mano su = contenuto su)' },
  { g: 'Sicurezza' },
  { id: 'safety.activateHoldMs', type: 'range', min: 800, max: 3500, step: 100, label: 'Tempo per ATTIVARE (mano aperta ferma)', fmt: (v) => (v / 1000).toFixed(1) + ' s', help: 'Più lungo = più difficile attivare per sbaglio.' },
  { id: 'safety.pauseHoldMs', type: 'range', min: 500, max: 3000, step: 100, label: 'Tempo per mettere in PAUSA', fmt: (v) => (v / 1000).toFixed(1) + ' s' },
  { id: 'safety.lockHoldMs', type: 'range', min: 500, max: 3000, step: 100, label: 'Tempo del pugno per il BLOCCO', fmt: (v) => (v / 1000).toFixed(1) + ' s' },
  { id: 'safety.autoPauseSec', type: 'range', min: 0, max: 120, step: 5, label: 'Pausa automatica se non vedo la mano', fmt: (v) => (v === 0 ? 'mai' : v + ' s') },
  { id: 'safety.realMouseWins', type: 'check', label: 'Se muovi il mouse vero, la mano si ferma per un attimo' },
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
      if (f.type === 'camera') sel.innerHTML = '<option value="">Predefinita</option>';
      else for (const [v, l] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); }
      wrap.innerHTML = `<label><span>${f.label}</span></label>`; wrap.appendChild(sel);
      if (f.help) { const h = document.createElement('div'); h.className = 'help'; h.textContent = f.help; wrap.appendChild(h); }
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
  cameraSelect.innerHTML = '<option value="">Predefinita</option>' + cams.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
  cameraSelect.value = S.camera.deviceId || '';
}
let patchTimer = null; let pendingPatch = {};
function changeSetting(f, value) {
  setLocal(f.id, value);
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
function applyMirror() { $('viewport').classList.toggle('nomirror', !S.camera.mirror); }

function syncFormFromSettings() {
  if (!formBuilt) return;
  for (const f of SCHEMA()) {
    if (!f.id || !f.el) continue;
    f.el.value = getPath(S, f.id);
  }
  // più semplice: ricostruisce (le impostazioni cambiano di rado dall'esterno)
  buildForm();
}

// ───────────────────────── calibrazione ─────────────────────────
const cal = { active: false, step: 0, pts: [], samples: [] };
const CAL_STEPS = [
  { title: '1/2 — Angolo in ALTO a SINISTRA', sub: 'Allunga il braccio come ti viene comodo e punta con l\'indice l\'angolo in alto a sinistra dello schermo. Tieni fermo.' },
  { title: '2/2 — Angolo in BASSO a DESTRA', sub: 'Adesso punta l\'angolo in basso a destra dello schermo. Tieni fermo.' },
];
function calStart() {
  if (!cameraOn) return;
  cal.active = true; cal.step = 0; cal.pts = []; cal.samples = [];
  $('calibBox').hidden = false; calShow();
  hc.log('Calibrazione dell\'area: iniziata');
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
      $('calibTitle').textContent = 'I due punti sono troppo vicini';
      $('calibSub').textContent = 'Muovi di più il braccio tra un angolo e l\'altro. Riprova.';
      setTimeout(calStop, 2500); hc.log('Calibrazione fallita: punti troppo vicini');
      return;
    }
    // La telecamera vede l'angolo "basso a destra" in un punto con u maggiore e v maggiore: se no, i punti sono invertiti.
    const area = areaFromCorners(a, b);
    // sensibilità 1 = area esatta; la salviamo come area e riportiamo la sensibilità a 1
    S.control.area = area; S.control.sensitivity = 1;
    hc.setSettings({ control: { area, sensitivity: 1 } });
    syncFormFromSettings();
    $('calibTitle').textContent = 'Fatto! Area attiva impostata';
    $('calibSub').textContent = 'Il rettangolo tratteggiato nell\'anteprima è la tua area.';
    setTimeout(calStop, 2200);
    hc.log('Calibrazione completata');
  }
}

// ───────────────────────── misure ─────────────────────────
const rec = { active: false, t0: 0, frames: 0, infer: [], lag: [], det: [], poses: {}, events: {}, parts: [], roiSizes: [] };
function recStart() {
  if (!cameraOn) return;
  Object.assign(rec, { active: true, t0: performance.now(), frames: 0, infer: [], lag: [], det: [], poses: {}, events: {}, parts: [], roiSizes: [] });
  $('btnRec').disabled = true;
  const tick = setInterval(() => {
    const left = 20 - (performance.now() - rec.t0) / 1000;
    $('recStatus').textContent = left > 0 ? `registro… ${Math.ceil(left)} s` : '';
    if (left <= 0) { clearInterval(tick); recEnd(); }
  }, 250);
  $('measureOut').textContent = 'Registrazione in corso: usa i gesti normalmente (muovi, pizzica, scorri) per 20 secondi.';
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
const dist1 = (a) => ({ media: mean(a), p50: pct(a, 50), p95: pct(a, 95), max: a.length ? Math.max(...a) : null });
async function recEnd() {
  rec.active = false;
  $('btnRec').disabled = false;
  const dur = (performance.now() - rec.t0) / 1000;
  const total = rec.parts.map((p) => p.total);
  const result = {
    tipo: 'registrazione', quando: new Date().toISOString(), durata_s: +dur.toFixed(1),
    fotocamera: { risoluzione: `${video.videoWidth}x${video.videoHeight}`, distanza: S.camera.distance, motore: tracker && tracker.delegate },
    fotogrammi: rec.frames, fps_medi: +(rec.frames / dur).toFixed(1),
    mano_vista_percento: rec.det.length ? +(100 * mean(rec.det)).toFixed(1) : null,
    riconoscimento_ms: dist1(rec.infer),
    ritardo_fotocamera_app_ms: dist1(rec.lag),
    ritardo_totale_mano_cursore_ms: { campioni: total.length, ...dist1(total), nota: 'dalla foto della fotocamera al cursore spostato; non include il ritardo dello schermo' },
    parti_ms: { fotocamera_app: median(rec.parts.map((p) => p.cam)), elaborazione: median(rec.parts.map((p) => p.proc)), ipc_e_mouse: median(rec.parts.map((p) => p.ipc)) },
    gesti_contati: rec.poses, eventi_inviati: rec.events,
    impostazioni: { sensibilita: S.control.sensitivity, smorzamento: S.control.smoothing, area: S.control.area },
  };
  if (info.bench) setTimeout(() => hc.quit(), 1500);
  await showResult('Registrazione 20 s', result, [
    `Immagini al secondo: ${result.fps_medi}`,
    `Mano vista nel ${fmt(result.mano_vista_percento, 0)}% dei fotogrammi`,
    `Riconoscimento: medio ${fmt(result.riconoscimento_ms.media, 1)} ms, 95° perc. ${fmt(result.riconoscimento_ms.p95, 1)} ms`,
    `Ritardo totale mano→cursore: mediano ${fmt(result.ritardo_totale_mano_cursore_ms.p50, 0)} ms, 95° perc. ${fmt(result.ritardo_totale_mano_cursore_ms.p95, 0)} ms (${total.length} campioni)`,
    `   di cui fotocamera→app ${fmt(result.parti_ms.fotocamera_app, 0)} ms, elaborazione ${fmt(result.parti_ms.elaborazione, 0)} ms, mouse ${fmt(result.parti_ms.ipc_e_mouse, 1)} ms`,
    `Gesti: ${Object.entries(rec.poses).map(([k, v]) => `${POSE_IT[k] || k} ${v}`).join(', ')}`,
  ]);
}
async function showResult(title, obj, lines) {
  let path = '';
  try { path = await hc.saveMeasure(obj); } catch { /* non fatale */ }
  $('measureOut').textContent = `${title}\n${lines.join('\n')}\n\n${path ? 'Salvato in: ' + path : ''}`;
}

// test tremolio
const jitter = { active: false, raw: [], out: [], t0: 0 };
function jitterStart() {
  if (!cameraOn) return;
  Object.assign(jitter, { active: true, raw: [], out: [], t0: performance.now() });
  $('measureOut').textContent = 'Tieni la mano ferma, indice teso, per 5 secondi…';
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
  const result = { tipo: 'tremolio', quando: new Date().toISOString(), campioni: jitter.raw.length, tremolio_grezzo_px: r, tremolio_dopo_smorzamento_px: o, riduzione: r && o ? r / o : null, smorzamento: S.control.smoothing, sensibilita: S.control.sensitivity };
  await showResult('Test tremolio', result, jitter.raw.length < 20
    ? ['Troppi pochi campioni: la mano non è stata vista abbastanza. Riprova.']
    : [`Campioni: ${jitter.raw.length}`, `Tremolio grezzo (deviazione standard): ${fmt(r, 1)} px sullo schermo`, `Dopo lo smorzamento: ${fmt(o, 1)} px`, `Riduzione: ${fmt(result.riduzione, 1)}×`, 'Obiettivo: sotto ~3 px da fermi.']);
}

// prova di precisione (bersagli da cliccare con il pizzico)
const prec = { active: false, i: 0, targets: [], results: [], t0: 0, misses: 0 };
async function precStart() {
  if (mode !== 'active') { $('measureOut').textContent = 'Prima attiva il controllo (mano aperta ferma ~2 s), poi riprova: i bersagli si cliccano con il pizzico.'; return; }
  try { await document.documentElement.requestFullscreen(); } catch { /* si prosegue anche in finestra */ }
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
  $('precText').textContent = `Bersaglio ${prec.i + 1} di ${prec.targets.length} — punta e fai il pizzico`;
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
    tipo: 'precisione', quando: new Date().toISOString(), interrotta: aborted, bersagli: r.length,
    centrati: hits.length, errore_px: dist1(r.map((x) => x.err)), tempo_ms: dist1(hits.map((x) => x.ms)),
    click_a_vuoto: r.reduce((a, x) => a + x.misses, 0), raggio_bersaglio_px: 28,
    impostazioni: { sensibilita: S.control.sensitivity, smorzamento: S.control.smoothing, area: S.control.area, congelamento_ms: S.clicks.dragFreezeMs },
  };
  await showResult('Prova di precisione', result, r.length ? [
    `Bersagli centrati: ${hits.length} su ${r.length}`,
    `Errore medio del click: ${fmt(result.errore_px.media, 1)} px (mediano ${fmt(result.errore_px.p50, 1)}, peggiore ${fmt(result.errore_px.max, 0)})`,
    `Tempo per colpire: mediano ${fmt(result.tempo_ms.p50 / 1000, 1)} s, 95° perc. ${fmt(result.tempo_ms.p95 / 1000, 1)} s`,
    `Click a vuoto: ${result.click_a_vuoto}`,
  ] : ['Nessun bersaglio colpito.']);
}

// ───────────────────────── e2e (solo quando lo lancia il test) ─────────────────────────
function wireE2E() {
  hc.on.e2eFrame((f) => {
    // il test manda mani finte: stesso identico percorso dei gesti veri
    const frame = { t: f.t, hands: f.hands || [], meta: { tCapEpoch: f.tSend, tStartEpoch: f.tSend, tDoneEpoch: f.tSend, tSend: f.tSend } };
    onFrame(frame);
  });
}

// ───────────────────────── avvio ─────────────────────────
async function init() {
  const st = await hc.getState();
  S = st.settings; DEFAULTS = st.defaults; PRESETS = st.presets; mode = st.mode; screenSize = st.screen; info = st.info;
  $('ver').textContent = 'v' + info.version;
  engine = new GestureEngine(() => S, onEngineEvent);
  engine.setScreen(screenSize.w, screenSize.h);
  engine.setMode(mode);
  $('blocked').textContent = st.blocked;
  st.log.forEach(addLogLine);
  showHotkeys(st.hotkeys);
  buildForm(); applyMirror();

  hc.on.mode((m) => { mode = m.mode; engine.setMode(mode); refreshStatus(); refreshHold(); });
  hc.on.settings((s) => { S = s; syncFormFromSettings(); applyMirror(); });
  hc.on.screen((s) => { screenSize = s; engine.setScreen(s.w, s.h); });
  hc.on.log(addLogLine);
  hc.on.hotkeys(showHotkeys);
  hc.on.blocked((n) => { $('blocked').textContent = n; });
  hc.on.realMouse(() => { const n = $('mouseNote'); n.hidden = false; clearTimeout(n._t); n._t = setTimeout(() => { n.hidden = true; }, 2500); });

  // pulsanti
  $('btnToggle').onclick = () => hc.setMode(mode === 'active' ? 'paused' : 'active', mode === 'active' ? 'pausa dal pulsante' : 'attivato dal pulsante', 'ui');
  $('btnKill').onclick = () => hc.setMode(mode === 'locked' ? 'paused' : 'locked', mode === 'locked' ? 'sbloccato dal pulsante' : 'BLOCCO DI EMERGENZA (pulsante)', 'ui');
  $('btnHide').onclick = () => hc.hide();
  $('btnCam').onclick = () => (cameraOn ? stopCamera() : startCamera());
  $('btnCalib').onclick = calStart;
  $('calibCancel').onclick = () => { calStop(); hc.log('Calibrazione annullata'); };
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
    if (b.dataset.tab === 'misure') renderLive();
  }));
  // Esc chiude la prova di precisione
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && prec.active) precEnd(true); });

  setInterval(() => { refreshStats(); refreshStatus(); }, 250);
  refreshStatus();

  if (info.e2e) { wireE2E(); hc.log('RENDERER_READY'); return; }
  if (S.ui.startCamera) startCamera();
  if (info.bench) setTimeout(() => { recStart(); }, 3000);
}
function showHotkeys(h) {
  $('hkKill').textContent = niceKey(h.kill) + (h.killOk ? ' ✔' : ' ✖ (non disponibile)');
  $('hkPause').textContent = niceKey(h.pause) + (h.pauseOk ? ' ✔' : ' ✖');
}

init().catch((e) => { console.error(e); document.body.insertAdjacentHTML('afterbegin', '<pre style="color:#f88">Errore di avvio: ' + (e && e.message) + '</pre>'); });
