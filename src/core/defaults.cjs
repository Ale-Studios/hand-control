// Impostazioni predefinite. File "CommonJS" così lo leggono sia il processo
// principale di Electron sia i test; il renderer le riceve via IPC.

const DEFAULTS = {
  version: 1,
  camera: {
    deviceId: '',          // vuoto = fotocamera predefinita
    distance: 'near',      // near | mid | far  (vedi DISTANCE_PRESETS)
    mirror: true,          // anteprima a specchio (consigliato)
    delegate: 'auto',      // auto = scheda video (GPU) e, se non va, processore | GPU | CPU
  },
  control: {
    hand: 'any',           // any | right | left
    pointAt: 'knuckle',    // knuckle = nocca dell'indice (stabile) | tip = punta
    sensitivity: 1.0,      // 0.5..3: più alto = servono movimenti più piccoli
    smoothing: 0.5,        // 0..1: più alto = cursore più fermo ma più lento
    area: { cx: 0.5, cy: 0.5, w: 0.5, h: 0.45 }, // area attiva nella telecamera
    snap: 0.02,
    display: 0,            // quale schermo (0 = principale)
  },
  clicks: {
    pinchSensitivity: 1.0, // più alto = basta un pizzico meno stretto
    dragFreezeMs: 280,     // dopo il pizzico il cursore resta fermo per questo tempo (click preciso)
    confirmMs: 60,         // un gesto deve durare almeno questo per contare
  },
  scroll: {
    speed: 1.0,
    natural: true,         // mano su = contenuto su (come sul telefono)
  },
  safety: {
    activateHoldMs: 1600,  // mano aperta ferma per attivare
    pauseHoldMs: 900,      // mano aperta ferma per mettere in pausa
    lockHoldMs: 1000,      // pugno chiuso per il blocco di emergenza
    autoPauseSec: 20,      // mano non vista per tanto = pausa (0 = mai)
    realMouseWins: true,   // se muovi il mouse vero, la mano si ferma per un attimo
    killKey: 'CommandOrControl+Alt+K',
    pauseKey: 'CommandOrControl+Alt+P',
  },
  ui: {
    startCamera: true,
    showSkeleton: true,
    showArea: true,
  },
};

// Come usare la telecamera a diverse distanze.
//  size  → dimensione richiesta alla telecamera
//  roi   → 'full' = guarda tutta l'immagine; 'follow' = ingrandisce attorno alla mano
//  minSide → lato minimo (in frazione dell'altezza) del riquadro ingrandito
const DISTANCE_PRESETS = {
  near: { label: 'Vicino (fino a 1,5 m)', width: 1280, height: 720, roi: 'full', minSide: 1 },
  mid: { label: 'Medio (1,5 – 2,5 m)', width: 1920, height: 1080, roi: 'follow', minSide: 0.45 },
  far: { label: 'Lontano (2,5 – 4 m)', width: 1920, height: 1080, roi: 'follow', minSide: 0.25 },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/** Unisce `patch` dentro `base` (ricorsivo, ignora chiavi sconosciute). */
function merge(base, patch) {
  const out = clone(base);
  (function walk(dst, src, ref) {
    if (!src || typeof src !== 'object') return;
    for (const k of Object.keys(src)) {
      if (!(k in ref)) continue;
      if (ref[k] && typeof ref[k] === 'object' && !Array.isArray(ref[k])) {
        walk(dst[k], src[k], ref[k]);
      } else if (typeof src[k] === typeof ref[k]) {
        dst[k] = src[k];
      }
    }
  })(out, patch, DEFAULTS);
  return out;
}

module.exports = { DEFAULTS, DISTANCE_PRESETS, merge, clone };
