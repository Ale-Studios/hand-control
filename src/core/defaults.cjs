// Default settings. A CommonJS file so both Electron's main process and the tests can read it;
// the renderer receives them over IPC.

const DEFAULTS = {
  version: 1,
  camera: {
    deviceId: '',          // empty = default camera
    distance: 'near',      // near | mid | far  (see DISTANCE_PRESETS)
    mirror: true,          // mirrored preview (recommended)
    delegate: 'auto',      // auto = graphics card (GPU), falling back to the processor | GPU | CPU
  },
  control: {
    hand: 'any',           // any | right | left
    pointAt: 'knuckle',    // knuckle = index knuckle (steady) | tip = fingertip | palm = centre of the palm (most steady)
    twoHands: false,       // two-hand mode: one hand steers, the other clicks / drags / scrolls
    cursorHand: 'right',   // which hand steers in two-hand mode (right | left)
    sensitivity: 1.0,      // 0.5..3: higher = smaller movements are enough
    smoothing: 0.5,        // 0..1: higher = steadier cursor but slower
    area: { cx: 0.5, cy: 0.5, w: 0.5, h: 0.45 }, // active area inside the camera frame
    snap: 0.02,
    display: 0,            // which screen (0 = primary)
  },
  clicks: {
    pinchSensitivity: 1.0, // higher = a looser pinch is enough
    dragFreezeMs: 280,     // after the pinch the cursor stays still for this long (precise click)
    confirmMs: 60,         // a gesture must last at least this long to count
  },
  scroll: {
    speed: 1.0,
    natural: true,         // hand up = content up (like a phone)
  },
  safety: {
    activateHoldMs: 1600,  // open hand held still to activate
    pauseHoldMs: 900,      // open hand held still to pause
    lockHoldMs: 1000,      // closed fist for the emergency lock
    autoPauseSec: 20,      // hand not seen for this long = pause (0 = never)
    realMouseWins: true,   // if you move the physical mouse, hand control stops for a moment
    dryRun: false,         // test mode: show what would happen without touching the mouse or keyboard
    killKey: 'CommandOrControl+Alt+K',
    pauseKey: 'CommandOrControl+Alt+P',
  },
  actions: {
    holdMs: 500,                          // how long an action gesture is held before it fires
    ringPinch: 'launcher',                // thumb + ring finger
    pinkyPinch: 'keys:<cmd>+<tab>',       // thumb + little finger
    // The launcher tiles: [name, action]. Actions: open:TARGET | keys:COMBO | zoom:in | zoom:out | media:NAME | launcher | none
    tiles: [
      ['Files', 'open:explorer'],
      ['Search', 'keys:<cmd>+s'],
      ['Keyboard', 'open:osk'],
      ['Task view', 'keys:<cmd>+<tab>'],
      ['Desktop', 'keys:<cmd>+d'],
      ['Screenshot', 'keys:<cmd>+<shift>+s'],
      ['Zoom in', 'zoom:in'],
      ['Zoom out', 'zoom:out'],
      ['Play / pause', 'media:playpause'],
    ],
  },
  ui: {
    startCamera: true,
    showSkeleton: true,
    showArea: true,
    videoDim: 0.55,        // camera image brightness behind the HUD (0.1 = almost black, 1 = full)
    hudColor: 'ice',       // ice | amber | mint
    trail: true,           // fading trail behind the pointer
    glass: 'acrylic',      // window material (Windows 11): none | mica | acrylic
    tint: 0.45,            // darkness of the glass (lower = more see-through, higher = easier to read)
  },
};

// Ready-made actions for the two action gestures (the Settings tab shows them in a list).
const ACTION_PRESETS = [
  ['launcher', 'Open the launcher (big tiles)'],
  ['keys:<cmd>+<tab>', 'Task view (switch windows)'],
  ['keys:<cmd>+d', 'Show desktop'],
  ['keys:<cmd>+s', 'Search'],
  ['keys:<cmd>+<shift>+s', 'Screenshot'],
  ['zoom:in', 'Zoom in'],
  ['zoom:out', 'Zoom out'],
  ['keys:<alt>+<left>', 'Back'],
  ['keys:<alt>+<right>', 'Forward'],
  ['keys:<ctrl>+w', 'Close tab'],
  ['keys:<ctrl>+t', 'New tab'],
  ['media:playpause', 'Play / pause'],
  ['media:volup', 'Volume up'],
  ['media:voldown', 'Volume down'],
  ['media:mute', 'Mute'],
  ['open:osk', 'On-screen keyboard'],
  ['open:explorer', 'File Explorer'],
  ['none', 'Nothing'],
];

// How to use the camera at different distances.
//  width/height → size requested from the camera
//  roi          → 'full' = look at the whole frame; 'follow' = zoom in around the hand
//  minSide      → minimum side (as a fraction of the frame height) of the zoomed crop
const DISTANCE_PRESETS = {
  near: { label: 'Near (up to 1.5 m)', width: 1280, height: 720, roi: 'full', minSide: 1 },
  mid: { label: 'Medium (1.5 – 2.5 m)', width: 1920, height: 1080, roi: 'follow', minSide: 0.45 },
  far: { label: 'Far (2.5 – 4 m)', width: 1920, height: 1080, roi: 'follow', minSide: 0.25 },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/** Merges `patch` into `base` (recursive, ignores unknown keys). */
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

/** Smallest allowed active area (same rule as in mapping.mjs): smaller areas magnify the camera noise too much. */
const MIN_AREA = 0.28;
function enforceMinArea(a) {
  const w = Math.min(1, Math.max(MIN_AREA, a.w));
  const h = Math.min(1, Math.max(MIN_AREA, a.h));
  return { cx: Math.min(1 - w / 2, Math.max(w / 2, a.cx)), cy: Math.min(1 - h / 2, Math.max(h / 2, a.cy)), w, h };
}

module.exports = { DEFAULTS, DISTANCE_PRESETS, ACTION_PRESETS, merge, clone, enforceMinArea, MIN_AREA };
