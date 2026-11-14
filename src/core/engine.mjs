// The gesture "brain". It receives the hand points (21 per frame) and decides what to do:
// move the cursor, press/release the button, scroll, pause, lock everything.
//
// It is pure code (no camera, no mouse): that is why it can be tested with fake hands.
// Only "events" come out (see emit).
//
// GESTURES
//   Index finger up ................... moves the cursor
//   Pinch thumb + index ............... left button (pinch = down, open = up;
//                                       held and moved = drag)
//   Pinch thumb + middle .............. right click
//   Index + middle up ("V" sign) ...... scroll (move the hand up/down)
//   Open hand held still .............. activate / pause
//   Closed fist held still ............ EMERGENCY LOCK

import { OneEuro, smoothingToParams } from './filters.mjs';
import { mapToScreen } from './mapping.mjs';
import { L, measure, worldFromImage } from './hand.mjs';

const EXT_ON = 1.55;       // a finger counts as "extended" above this ratio
const EXT_OFF = 1.35;      // ...and as "bent" below this one (hysteresis: no state flicker)
const PINCH_ON = 0.28;     // fingertip distance / hand size for a "pinch"
const PINCH_OFF = 1.5;     // to open the pinch you need 1.5x the threshold
const INDEX_BENT_MIN = 1.12; // in a pinch the index is slightly bent; in a fist it is fully closed
const STEADY_MAX = 0.10;   // how far the hand may move (frame fraction) during a "hold still"
const LOST_RELEASE_MS = 350;
const HAND_FLICKER_MS = 150;
const WHEEL_STEP = 40;     // wheel "clicks" are multiples of 40 (120 = one full notch)
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SNAP = 0.03; // screen fraction within which the 2nd click "sticks" to the 1st

export class GestureEngine {
  /**
   * @param getSettings () => current settings
   * @param emit (event) => void
   */
  constructor(getSettings, emit) {
    this.S = getSettings;
    this.emit = emit;
    this.mode = 'paused'; // paused | active | locked
    this.screen = { w: 1920, h: 1080 };
    this.fx = new OneEuro();
    this.fy = new OneEuro();
    this.fsy = new OneEuro({ minCutoff: 1.5, beta: 0.01 });
    this.reset();
  }

  setScreen(w, h) { this.screen = { w, h }; }

  /** Called by the main process when the mode changes (emergency key, button...). */
  setMode(mode, keepHold = false) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._releaseAll();
    if (!keepHold) { this.holdKind = null; this.holdLatched = false; }
    this.fx.reset(); this.fy.reset(); this.fsy.reset();
    this.scrollPrev = null;
  }

  reset() {
    this.pose = 'none';
    this.cand = 'none';
    this.candSince = 0;
    this.poseSince = 0;
    this.st = { ext: { index: false, middle: false, ring: false, pinky: false }, pI: false, pM: false };
    this.lastSeen = -Infinity;
    this.pressed = null;     // 'left' while the button is held
    this.pressT = 0;
    this.dragging = false;
    this.freezePos = null;
    this.lastClick = null;   // {x,y,t} of the last short click (for the double click)
    this.lastRightT = -Infinity;
    this.hist = [];
    this.ptr = { x: 0.5, y: 0.5 };
    this.holdKind = null; this.holdStart = 0; this.holdOrigin = null; this.holdLatched = false;
    this.scrollPrev = null; this.wheelAcc = 0;
    this.meta = null;
    this.hud = { handVisible: false, pose: 'none', mode: this.mode, holdKind: null, holdProgress: 0, anchor: null, screen: this.ptr, pressed: null };
    this.fx.reset(); this.fy.reset(); this.fsy.reset();
  }

  // ───────────────────────────── input ─────────────────────────────
  /** frame: { t (ms), hands: [{lm, wl, label}], meta? } */
  update(frame) {
    const S = this.S();
    const t = frame.t;
    this.meta = frame.meta || null;
    const hand = this._pick(frame.hands || [], S);

    if (!hand) return this._noHand(t, S);

    if (t - this.lastSeen > 250) this._resetTracking(); // hand came back after a gap: start clean
    this.lastSeen = t;

    const wl = hand.wl || worldFromImage(hand.lm);
    const m = measure(wl);
    const raw = this._classify(m, S);
    this._debounce(raw, t, S);

    const anchor = this._anchor(hand.lm, S);
    this._pointer(anchor, t, S);
    this._holds(hand, t, S);
    if (this.mode === 'active') this._act(hand, t, S);

    this.hud = {
      handVisible: true,
      pose: this.pose,
      rawPose: raw,
      mode: this.mode,
      holdKind: this.holdKind,
      holdProgress: this._holdProgress(S, t),
      anchor,
      screen: { ...this.ptr },
      pressed: this.pressed,
      measures: m,
    };
    return this.hud;
  }

  // ───────────────────────────── hand lost ─────────────────────────────
  _noHand(t, S) {
    const lost = t - this.lastSeen;
    if (lost > LOST_RELEASE_MS && this.pressed) this._releaseAll();
    if (lost > 250) {
      this.pose = 'none'; this.cand = 'none';
      this.holdKind = null; this.holdLatched = false;
      this.scrollPrev = null;
    }
    const lim = S.safety.autoPauseSec * 1000;
    if (this.mode === 'active' && lim > 0 && Number.isFinite(this.lastSeen) && lost > lim) {
      this._requestMode('paused', 'hand not seen for too long');
    }
    this.hud = { handVisible: lost < HAND_FLICKER_MS, pose: 'none', mode: this.mode, holdKind: null, holdProgress: 0, anchor: null, screen: { ...this.ptr }, pressed: this.pressed };
    return this.hud;
  }

  _resetTracking() {
    this.fx.reset(); this.fy.reset(); this.fsy.reset();
    this.hist = [];
    this.scrollPrev = null;
    this.holdKind = null; this.holdLatched = false;
    this.pose = 'none'; this.cand = 'none';
  }

  _pick(hands, S) {
    if (!hands.length) return null;
    let pool = hands;
    if (S.control.hand !== 'any') {
      pool = hands.filter((h) => h.label === S.control.hand);
      if (!pool.length) return null;
    }
    // the biggest hand in the image = the closest = the one in control
    const span = (h) => Math.hypot(h.lm[L.WRIST].x - h.lm[L.MIDDLE_MCP].x, h.lm[L.WRIST].y - h.lm[L.MIDDLE_MCP].y);
    return pool.reduce((a, b) => (span(b) > span(a) ? b : a));
  }

  // ───────────────────────────── pose recognition ─────────────────────────────
  _classify(m, S) {
    const st = this.st;
    for (const f of ['index', 'middle', 'ring', 'pinky']) {
      st.ext[f] = st.ext[f] ? m.ratio[f] > EXT_OFF : m.ratio[f] > EXT_ON;
    }
    const thr = PINCH_ON * S.clicks.pinchSensitivity;
    st.pI = st.pI ? m.pinchIndex < thr * PINCH_OFF : m.pinchIndex < thr;
    st.pM = st.pM ? m.pinchMiddle < thr * PINCH_OFF : m.pinchMiddle < thr;
    const e = st.ext;
    const idxBent = m.ratio.index > (st.pI ? 1.0 : INDEX_BENT_MIN);

    if (st.pI && idxBent && m.pinchIndex <= m.pinchMiddle) return 'pinch';
    if (st.pM && m.ratio.middle > 1.0 && m.pinchMiddle < m.pinchIndex && e.index) return 'rclick';
    if (e.index && e.middle && !e.ring && !e.pinky) return 'scroll';
    if (e.index && e.middle && e.ring && e.pinky) return 'open';
    if (!e.index && !e.middle && !e.ring && !e.pinky) return 'fist';
    if (e.index && !e.middle && !e.ring) return 'point';
    return 'other';
  }

  _debounce(raw, t, S) {
    if (raw !== this.cand) { this.cand = raw; this.candSince = t; }
    const need = this.pose === 'pinch' ? Math.min(S.clicks.confirmMs, 40) : S.clicks.confirmMs;
    if (this.pose !== this.cand && t - this.candSince >= need) {
      const prev = this.pose;
      this.pose = this.cand;
      this.poseSince = t;
      if (this.mode === 'active') this._onPoseChange(prev, this.pose, t, S);
    }
  }

  // ───────────────────────────── cursor ─────────────────────────────
  _anchor(lm, S) {
    const a = S.control.pointAt === 'tip'
      ? lm[L.INDEX_TIP]
      : { x: (lm[L.INDEX_MCP].x + lm[L.INDEX_PIP].x) / 2, y: (lm[L.INDEX_MCP].y + lm[L.INDEX_PIP].y) / 2 };
    return { u: S.camera.mirror ? 1 - a.x : a.x, v: a.y };
  }

  _pointer(anchor, t, S) {
    const c = S.control;
    const sc = mapToScreen(anchor.u, anchor.v, c.area, c.sensitivity, c.snap);
    const p = smoothingToParams(c.smoothing);
    this.fx.configure(p); this.fy.configure(p);
    // the filter works in pixels: the same amount of "jitter" weighs the same on every screen
    const x = this.fx.filter(sc.x * this.screen.w, t) / this.screen.w;
    const y = this.fy.filter(sc.y * this.screen.h, t) / this.screen.h;
    this.ptr = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    this.hist.push({ t, x: this.ptr.x, y: this.ptr.y });
    while (this.hist.length > 2 && t - this.hist[0].t > 700) this.hist.shift();
  }

  _histAt(tt) {
    let best = this.hist[0];
    for (const h of this.hist) { if (h.t <= tt) best = h; else break; }
    return best ? { x: best.x, y: best.y } : { ...this.ptr };
  }

  // ───────────────────────────── safety gestures ─────────────────────────────
  _holds(hand, t, S) {
    let kind = this.pose === 'open' ? 'toggle' : this.pose === 'fist' ? 'lock' : null;
    if (this.mode === 'locked') kind = null; // once locked, only keyboard / button unlock
    const w = hand.lm[L.WRIST];
    if (kind !== this.holdKind) {
      this.holdKind = kind; this.holdStart = t; this.holdOrigin = { x: w.x, y: w.y }; this.holdLatched = false;
    }
    if (!kind) return;
    if (Math.hypot(w.x - this.holdOrigin.x, w.y - this.holdOrigin.y) > STEADY_MAX) {
      // the hand is moving: the "hold still" restarts (so waving does not activate anything)
      this.holdStart = t; this.holdOrigin = { x: w.x, y: w.y };
    }
    if (this.holdLatched) return;
    if (t - this.holdStart >= this._holdNeed(S)) {
      this.holdLatched = true;
      if (kind === 'lock') this._requestMode('locked', 'closed-fist gesture');
      else this._requestMode(this.mode === 'active' ? 'paused' : 'active', 'open-hand gesture');
    }
  }

  _holdNeed(S) {
    if (this.holdKind === 'lock') return S.safety.lockHoldMs;
    return this.mode === 'active' ? S.safety.pauseHoldMs : S.safety.activateHoldMs;
  }

  _holdProgress(S, t) {
    if (!this.holdKind) return 0;
    if (this.holdLatched) return 1;
    return Math.min(1, (t - this.holdStart) / this._holdNeed(S));
  }

  _requestMode(mode, reason) {
    if (mode === this.mode) return;
    // Applied right away here (the main process is still the final judge).
    // keepHold: the hand stays open/closed after the gesture and must not start over.
    this.setMode(mode, true);
    this.emit({ type: 'mode-request', mode, reason, meta: this.meta });
  }

  // ───────────────────────────── actions (ACTIVE mode only) ─────────────────────────────
  _onPoseChange(prev, next, t, S) {
    if (prev === 'pinch' && this.pressed) this._release(t);
    if (next === 'pinch') this._press(t, S);
    if (next === 'rclick' && t - this.lastRightT > 350) {
      this.lastRightT = t;
      const f = this._histAt(this.candSince - 30);
      this.emit({ type: 'move', x: f.x, y: f.y, meta: this.meta });
      this.emit({ type: 'click', button: 'right', meta: this.meta });
    }
    if (next === 'scroll') { this.scrollPrev = null; this.wheelAcc = 0; }
  }

  _press(t, S) {
    let f = this._histAt(this.candSince - 30);
    // Double click: the second pinch "sticks" to the point of the first.
    if (this.lastClick && t - this.lastClick.t < DOUBLE_CLICK_MS
      && Math.hypot((f.x - this.lastClick.x) * this.screen.w, (f.y - this.lastClick.y) * this.screen.h) < DOUBLE_CLICK_SNAP * this.screen.w) {
      f = { x: this.lastClick.x, y: this.lastClick.y };
    }
    this.freezePos = f;
    this.emit({ type: 'move', x: f.x, y: f.y, meta: this.meta });
    this.emit({ type: 'down', button: 'left', meta: this.meta });
    this.pressed = 'left';
    this.pressT = t;
    this.dragging = false;
  }

  _release(t) {
    const wasDrag = this.dragging;
    const pos = wasDrag ? this.ptr : this.freezePos;
    if (!wasDrag && pos) this.lastClick = { x: pos.x, y: pos.y, t };
    this.emit({ type: 'up', button: 'left', meta: this.meta });
    this.pressed = null;
    this.dragging = false;
  }

  _releaseAll() {
    if (this.pressed) {
      this.emit({ type: 'up', button: this.pressed, meta: this.meta });
      this.pressed = null; this.dragging = false;
    }
  }

  _act(hand, t, S) {
    const pose = this.pose;
    if (pose === 'point') {
      this.emit({ type: 'move', x: this.ptr.x, y: this.ptr.y, meta: this.meta });
    } else if (pose === 'pinch' && this.pressed) {
      if (!this.dragging && t - this.pressT >= S.clicks.dragFreezeMs) this.dragging = true;
      if (this.dragging) this.emit({ type: 'move', x: this.ptr.x, y: this.ptr.y, meta: this.meta });
    } else if (pose === 'scroll') {
      this._scroll(hand, t, S);
    }
  }

  _scroll(hand, t, S) {
    const lm = hand.lm;
    const v = (lm[L.INDEX_TIP].y + lm[L.MIDDLE_TIP].y) / 2;
    const c = S.control;
    const sy = mapToScreen(0.5, v, c.area, c.sensitivity, 0).y * this.screen.h;
    const f = this.fsy.filter(sy, t);
    if (this.scrollPrev == null) { this.scrollPrev = f; return; }
    const dPx = f - this.scrollPrev;
    this.scrollPrev = f;
    if (Math.abs(dPx) < 0.4) return; // dead zone: a still hand does not scroll
    const dir = S.scroll.natural ? 1 : -1;
    // hand up (dPx<0) + natural = wheel down (negative): the content rises with the hand
    this.wheelAcc += dir * (dPx / this.screen.h) * 1200 * S.scroll.speed;
    const n = Math.trunc(this.wheelAcc / WHEEL_STEP) * WHEEL_STEP;
    if (n !== 0) {
      this.wheelAcc -= n;
      this.emit({ type: 'wheel', delta: n, meta: this.meta });
    }
  }
}
