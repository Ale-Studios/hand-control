// The gesture "brain". It receives the hand points (21 per frame) and decides what to do:
// move the cursor, press/release the button, scroll, run actions, pause, lock everything.
//
// It is pure code (no camera, no mouse): that is why it can be tested with fake hands.
// Only "events" come out (see emit).
//
// GESTURES (the "steering" hand; with two-hand mode the other hand can do the pinches and scrolling)
//   Index finger up ................... moves the cursor
//   Pinch thumb + index ............... left button (pinch = down, open = up; held and moved = drag)
//   Pinch thumb + middle .............. right click
//   Index + middle up ("V" sign) ...... scroll (move the hand up/down)
//   Pinch thumb + ring, held .......... action 1 (by default: the launcher)
//   Pinch thumb + pinky, held ......... action 2 (by default: task view)
//   Open hand held still .............. activate / pause
//   Closed fist held still ............ EMERGENCY LOCK

import { OneEuro, smoothingToParams } from './filters.mjs';
import { mapToScreen } from './mapping.mjs';
import { L, PALM_POINTS, measure, worldFromImage } from './hand.mjs';

const EXT_ON = 1.55;       // a finger counts as "extended" above this ratio
const EXT_OFF = 1.35;      // ...and as "bent" below this one (hysteresis: no state flicker)
const PINCH_ON = 0.28;     // fingertip distance / hand size for a "pinch"
const PINCH_OFF = 1.5;     // to open the pinch you need 1.5x the threshold
const INDEX_BENT_MIN = 1.12; // in a pinch the index is slightly bent; in a fist it is fully closed
const STEADY_MAX = 0.10;   // how far the hand may move (frame fraction) during a "hold still"
const REF_W = 1280, REF_H = 720; // reference image size for the pointer filter
const LOST_RELEASE_MS = 350;
const HAND_FLICKER_MS = 150;
const WHEEL_STEP = 40;     // wheel "clicks" are multiples of 40 (120 = one full notch)
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SNAP = 0.03; // screen fraction within which the 2nd click "sticks" to the 1st
const CLICK_STICK_PX = 24;       // after a click the cursor stays put unless the hand moves more than this (screen pixels)
const ACTION_HOLD_MS = 500;

/** Pose memory of one hand. */
function newTracker() {
  return {
    pose: 'none', cand: 'none', candSince: 0, poseSince: 0, lastSeen: -Infinity, fired: false,
    st: { ext: { index: false, middle: false, ring: false, pinky: false }, pI: false, pM: false, pR: false, pP: false },
  };
}

/** Raw pose of one frame, with hysteresis kept in tr.st. */
function classify(tr, m, S) {
  const st = tr.st;
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    st.ext[f] = st.ext[f] ? m.ratio[f] > EXT_OFF : m.ratio[f] > EXT_ON;
  }
  const thr = PINCH_ON * S.clicks.pinchSensitivity;
  const hys = (on, v) => (on ? v < thr * PINCH_OFF : v < thr);
  st.pI = hys(st.pI, m.pinchIndex);
  st.pM = hys(st.pM, m.pinchMiddle);
  st.pR = hys(st.pR, m.pinchRing);
  st.pP = hys(st.pP, m.pinchPinky);
  const e = st.ext;
  const idxBent = m.ratio.index > (st.pI ? 1.0 : INDEX_BENT_MIN);
  const nearest = Math.min(m.pinchIndex, m.pinchMiddle, m.pinchRing, m.pinchPinky);

  if (st.pI && idxBent && m.pinchIndex <= nearest) return 'pinch';
  if (st.pM && m.ratio.middle > 1.0 && m.pinchMiddle <= nearest && e.index) return 'rclick';
  // action gestures: the index stays up, so they cannot be confused with a fist or a normal pinch
  if (st.pR && e.index && m.pinchRing <= nearest) return 'ringpinch';
  if (st.pP && e.index && m.pinchPinky <= nearest) return 'pinkypinch';
  if (e.index && e.middle && !e.ring && !e.pinky) return 'scroll';
  if (e.index && e.middle && e.ring && e.pinky) return 'open';
  if (!e.index && !e.middle && !e.ring && !e.pinky) return 'fist';
  if (e.index && !e.middle && !e.ring) return 'point';
  return 'other';
}

/** Commits a pose once it has lasted long enough. Returns the previous pose if it changed, else null. */
function debounce(tr, raw, t, S) {
  if (raw !== tr.cand) { tr.cand = raw; tr.candSince = t; }
  const need = tr.pose === 'pinch' ? Math.min(S.clicks.confirmMs, 40) : S.clicks.confirmMs;
  if (tr.pose !== tr.cand && t - tr.candSince >= need) {
    const prev = tr.pose;
    tr.pose = tr.cand;
    tr.poseSince = t;
    tr.fired = false;
    return prev;
  }
  return null;
}

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
    this.scrollMain = { f: new OneEuro({ minCutoff: 1.5, beta: 0.01 }), prev: null, acc: 0 };
    this.scrollHelper = { f: new OneEuro({ minCutoff: 1.5, beta: 0.01 }), prev: null, acc: 0 };
    this.reset();
  }

  setScreen(w, h) { this.screen = { w, h }; }

  /** Called by the main process when the mode changes (emergency key, button...). */
  setMode(mode, keepHold = false) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._releaseAll();
    if (!keepHold) { this.holdKind = null; this.holdLatched = false; }
    this.fx.reset(); this.fy.reset();
    this._resetScroll();
  }

  reset() {
    this.main = newTracker();
    this.helper = newTracker();
    this.pressed = null;     // 'left' while the button is held
    this.pressOwner = null;  // 'main' | 'helper': which hand holds the button
    this.pressT = 0;
    this.dragging = false;
    this.freezePos = null;
    this.lastClick = null;   // {x,y,t} of the last short click (for the double click)
    this.lastRightT = -Infinity;
    this.hist = [];
    this.ptr = { x: 0.5, y: 0.5 };
    this.holdKind = null; this.holdStart = 0; this.holdOrigin = null; this.holdLatched = false;
    this.steerHand = null; this.helperHand = null;
    this.meta = null;
    this.hud = { handVisible: false, pose: 'none', mode: this.mode, holdKind: null, holdProgress: 0, anchor: null, screen: this.ptr, pressed: null };
    this.fx.reset(); this.fy.reset();
    this._resetScroll();
  }

  _resetScroll() {
    for (const s of [this.scrollMain, this.scrollHelper]) { s.f.reset(); s.prev = null; s.acc = 0; }
  }

  // ───────────────────────────── input ─────────────────────────────
  /** frame: { t (ms), hands: [{lm, wl, label}], meta? } */
  update(frame) {
    const S = this.S();
    const t = frame.t;
    this.meta = frame.meta || null;
    const hands = frame.hands || [];
    const { steer, helper } = this._pickHands(hands, S);
    this.steerHand = steer; this.helperHand = helper;

    if (!steer) { this._helperGone(t); return this._noHand(t, S); }

    const tr = this.main;
    if (t - tr.lastSeen > 250) this._resetTracking(); // hand came back after a gap: start clean
    tr.lastSeen = t;

    const wl = steer.wl || worldFromImage(steer.lm);
    const m = measure(wl);
    const raw = classify(tr, m, S);
    const prev = debounce(tr, raw, t, S);
    if (prev !== null && this.mode === 'active') this._onPoseChange(prev, tr.pose, t, S);

    const anchor = this._anchor(steer.lm, S);
    this._pointer(anchor, t, S);
    this._holds(steer, t, S);
    if (this.mode === 'active') this._act(steer, t, S);
    this._actionHold(tr, t, S);

    if (helper) this._helperUpdate(helper, t, S); else this._helperGone(t);

    this.hud = {
      handVisible: true,
      pose: tr.pose,
      rawPose: raw,
      mode: this.mode,
      holdKind: this.holdKind,
      holdProgress: this._holdProgress(S, t),
      anchor,
      screen: { ...this.ptr },
      pressed: this.pressed,
      measures: m,
      steerIndex: hands.indexOf(steer),
      helperIndex: helper ? hands.indexOf(helper) : -1,
      helperPose: helper ? this.helper.pose : null,
    };
    return this.hud;
  }

  // ───────────────────────────── hand lost ─────────────────────────────
  _noHand(t, S) {
    const tr = this.main;
    const lost = t - tr.lastSeen;
    if (lost > LOST_RELEASE_MS && this.pressed) this._releaseAll();
    if (lost > 250) {
      tr.pose = 'none'; tr.cand = 'none';
      this.holdKind = null; this.holdLatched = false;
      this.scrollMain.prev = null;
    }
    const lim = S.safety.autoPauseSec * 1000;
    if (this.mode === 'active' && lim > 0 && Number.isFinite(tr.lastSeen) && lost > lim) {
      this._requestMode('paused', 'hand not seen for too long');
    }
    this.hud = { handVisible: lost < HAND_FLICKER_MS, pose: 'none', mode: this.mode, holdKind: null, holdProgress: 0, anchor: null, screen: { ...this.ptr }, pressed: this.pressed, steerIndex: -1, helperIndex: -1 };
    return this.hud;
  }

  _resetTracking() {
    this.fx.reset(); this.fy.reset();
    this.hist = [];
    this.scrollMain.prev = null;
    this.holdKind = null; this.holdLatched = false;
    this.main.pose = 'none'; this.main.cand = 'none';
  }

  _pick(hands, S) {
    if (!hands.length) return null;
    let pool = hands;
    if (S.control.hand !== 'any') {
      pool = hands.filter((h) => h.label === S.control.hand);
      if (!pool.length) return null;
    }
    return pool.reduce((a, b) => (this._span(b) > this._span(a) ? b : a));
  }

  // the biggest hand in the image = the closest = the one in control
  _span(h) { return Math.hypot(h.lm[L.WRIST].x - h.lm[L.MIDDLE_MCP].x, h.lm[L.WRIST].y - h.lm[L.MIDDLE_MCP].y); }

  /** Which hand steers the cursor and, in two-hand mode, which one helps. */
  _pickHands(hands, S) {
    if (!S.control.twoHands) return { steer: this._pick(hands, S), helper: null };
    if (!hands.length) return { steer: null, helper: null };
    if (hands.length === 1) return { steer: hands[0], helper: null };
    const wanted = hands.filter((h) => h.label === S.control.cursorHand);
    if (wanted.length === 1) return { steer: wanted[0], helper: hands.find((h) => h !== wanted[0]) };
    // labels are missing or ambiguous: the closest (biggest) hand steers
    const sorted = [...hands].sort((a, b) => this._span(b) - this._span(a));
    return { steer: sorted[0], helper: sorted[1] };
  }

  // ───────────────────────────── the helper hand ─────────────────────────────
  _helperUpdate(hand, t, S) {
    const h = this.helper;
    if (t - h.lastSeen > 250) { h.pose = 'none'; h.cand = 'none'; this.scrollHelper.prev = null; this.scrollHelper.f.reset(); }
    h.lastSeen = t;
    const m = measure(hand.wl || worldFromImage(hand.lm));
    const raw = classify(h, m, S);
    const prev = debounce(h, raw, t, S);
    if (this.mode === 'active') {
      if (prev !== null) this._helperPoseChange(prev, h.pose, t, S);
      if (h.pose === 'scroll') this._scroll(hand, t, S, this.scrollHelper);
    }
    this._actionHold(h, t, S);
  }

  _helperPoseChange(prev, next, t, S) {
    const h = this.helper;
    if (prev === 'pinch' && this.pressOwner === 'helper') this._release(t, 'helper');
    if (next === 'pinch' && !this.pressed) {
      const f = this._histAt(h.candSince - 30);
      this.emit({ type: 'move', x: f.x, y: f.y, meta: this.meta });
      this.emit({ type: 'down', button: 'left', meta: this.meta });
      this.pressed = 'left'; this.pressOwner = 'helper'; this.pressT = t; this.dragging = false; this.freezePos = f;
    }
    if (next === 'rclick' && t - this.lastRightT > 350) {
      this.lastRightT = t;
      const f = this._histAt(h.candSince - 30);
      this.emit({ type: 'move', x: f.x, y: f.y, meta: this.meta });
      this.emit({ type: 'click', button: 'right', meta: this.meta });
    }
    if (next === 'scroll') { this.scrollHelper.prev = null; this.scrollHelper.acc = 0; }
  }

  _helperGone(t) {
    const h = this.helper;
    const lost = t - h.lastSeen;
    if (this.pressOwner === 'helper' && lost > LOST_RELEASE_MS) this._releaseAll();
    if (lost > 250 && h.pose !== 'none') { h.pose = 'none'; h.cand = 'none'; this.scrollHelper.prev = null; }
  }

  // ───────────────────────────── cursor ─────────────────────────────
  _anchor(lm, S) {
    let a;
    if (S.control.pointAt === 'tip') a = lm[L.INDEX_TIP];
    else if (S.control.pointAt === 'palm') {
      a = { x: 0, y: 0 };
      for (const i of PALM_POINTS) { a.x += lm[i].x / PALM_POINTS.length; a.y += lm[i].y / PALM_POINTS.length; }
    } else a = { x: (lm[L.INDEX_MCP].x + lm[L.INDEX_PIP].x) / 2, y: (lm[L.INDEX_MCP].y + lm[L.INDEX_PIP].y) / 2 };
    return { u: S.camera.mirror ? 1 - a.x : a.x, v: a.y };
  }

  _pointer(anchor, t, S) {
    const c = S.control;
    const p = smoothingToParams(c.smoothing);
    this.fx.configure(p); this.fy.configure(p);
    // The filter works on the CAMERA measurement (in pixels of a 1280x720 reference image), BEFORE the
    // mapping to the screen. If it worked on screen pixels, a small active area (a big magnification)
    // would make the measurement noise look like fast movement and the filter would stop smoothing.
    const u = this.fx.filter(anchor.u * REF_W, t) / REF_W;
    const v = this.fy.filter(anchor.v * REF_H, t) / REF_H;
    this.ptr = mapToScreen(u, v, c.area, c.sensitivity, c.snap);
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
    const pose = this.main.pose;
    let kind = pose === 'open' ? 'toggle' : pose === 'fist' ? 'lock' : null;
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

  /** Ring / pinky pinch held long enough: ask the main process to run the bound action (once per gesture). */
  _actionHold(tr, t, S) {
    if (this.mode !== 'active') return;
    const which = tr.pose === 'ringpinch' ? 'ring' : tr.pose === 'pinkypinch' ? 'pinky' : null;
    if (!which) return;
    const need = (S.actions && S.actions.holdMs) || ACTION_HOLD_MS;
    if (!tr.fired && t - tr.poseSince >= need) {
      tr.fired = true;
      this.emit({ type: 'action', which, meta: this.meta });
    }
  }

  // ───────────────────────────── actions (ACTIVE mode only) ─────────────────────────────
  _onPoseChange(prev, next, t, S) {
    if (prev === 'pinch' && this.pressed && this.pressOwner === 'main') this._release(t, 'main');
    if (next === 'pinch') this._press(t, S);
    if (next === 'rclick' && t - this.lastRightT > 350) {
      this.lastRightT = t;
      const f = this._histAt(this.main.candSince - 30);
      this.emit({ type: 'move', x: f.x, y: f.y, meta: this.meta });
      this.emit({ type: 'click', button: 'right', meta: this.meta });
    }
    if (next === 'scroll') { this.scrollMain.prev = null; this.scrollMain.acc = 0; }
  }

  _press(t, S) {
    if (this.pressed) return; // the other hand already holds the button
    let f = this._histAt(this.main.candSince - 30);
    // Double click: the second pinch "sticks" to the point of the first.
    if (this.lastClick && t - this.lastClick.t < DOUBLE_CLICK_MS
      && Math.hypot((f.x - this.lastClick.x) * this.screen.w, (f.y - this.lastClick.y) * this.screen.h) < DOUBLE_CLICK_SNAP * this.screen.w) {
      f = { x: this.lastClick.x, y: this.lastClick.y };
    }
    this.freezePos = f;
    this.emit({ type: 'move', x: f.x, y: f.y, meta: this.meta });
    this.emit({ type: 'down', button: 'left', meta: this.meta });
    this.pressed = 'left';
    this.pressOwner = 'main';
    this.pressT = t;
    this.dragging = false;
  }

  _release(t, owner) {
    if (this.pressOwner !== owner) return;
    const wasDrag = this.dragging;
    const pos = wasDrag ? this.ptr : this.freezePos;
    if (!wasDrag && pos) this.lastClick = { x: pos.x, y: pos.y, t };
    this.emit({ type: 'up', button: 'left', meta: this.meta });
    this.pressed = null; this.pressOwner = null;
    this.dragging = false;
  }

  _releaseAll() {
    if (this.pressed) {
      this.emit({ type: 'up', button: this.pressed, meta: this.meta });
      this.pressed = null; this.pressOwner = null; this.dragging = false;
    }
  }

  _act(hand, t, S) {
    const pose = this.main.pose;
    if (pose === 'point') {
      // Just after a short click the cursor stays where it clicked (unless the hand really moves away): when the
      // fingers open, the pointing point shifts a few pixels, and a double click needs both clicks within ±2 px.
      let p = this.ptr;
      const lc = this.lastClick;
      if (lc && t - lc.t < DOUBLE_CLICK_MS
        && Math.hypot((p.x - lc.x) * this.screen.w, (p.y - lc.y) * this.screen.h) < CLICK_STICK_PX) p = { x: lc.x, y: lc.y };
      this.emit({ type: 'move', x: p.x, y: p.y, meta: this.meta });
    } else if (pose === 'pinch' && this.pressed && this.pressOwner === 'main') {
      if (!this.dragging && t - this.pressT >= S.clicks.dragFreezeMs) this.dragging = true;
      if (this.dragging) this.emit({ type: 'move', x: this.ptr.x, y: this.ptr.y, meta: this.meta });
    } else if (pose === 'scroll') {
      this._scroll(hand, t, S, this.scrollMain);
    }
  }

  _scroll(hand, t, S, sc) {
    const lm = hand.lm;
    const v = (lm[L.INDEX_TIP].y + lm[L.MIDDLE_TIP].y) / 2;
    const c = S.control;
    const sy = mapToScreen(0.5, v, c.area, c.sensitivity, 0).y * this.screen.h;
    const f = sc.f.filter(sy, t);
    if (sc.prev == null) { sc.prev = f; return; }
    const dPx = f - sc.prev;
    sc.prev = f;
    if (Math.abs(dPx) < 0.4) return; // dead zone: a still hand does not scroll
    const dir = S.scroll.natural ? 1 : -1;
    // hand up (dPx<0) + natural = wheel down (negative): the content rises with the hand
    sc.acc += dir * (dPx / this.screen.h) * 1200 * S.scroll.speed;
    const n = Math.trunc(sc.acc / WHEEL_STEP) * WHEEL_STEP;
    if (n !== 0) {
      sc.acc -= n;
      this.emit({ type: 'wheel', delta: n, meta: this.meta });
    }
  }
}
