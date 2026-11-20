import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { GestureEngine } from '../src/core/engine.mjs';
import { OneEuro, smoothingToParams } from '../src/core/filters.mjs';
import { mapToScreen, areaFromCorners } from '../src/core/mapping.mjs';
import { measure } from '../src/core/hand.mjs';
import { makeHand, frame, run } from './helpers/synth.mjs';

const require = createRequire(import.meta.url);
const { DEFAULTS, merge, clone } = require('../src/core/defaults.cjs');

function setup(patch = {}) {
  const S = merge(clone(DEFAULTS), patch);
  const events = [];
  const eng = new GestureEngine(() => S, (e) => events.push(e));
  eng.setScreen(1920, 1080);
  return { S, events, eng };
}
const types = (ev) => ev.map((e) => e.type + (e.button ? ':' + e.button : ''));
// an image point (not mirrored) that corresponds to the middle of the screen
const CENTER = { x: 0.5, y: 0.5 };

test('the fake poses are recognised (hand measurements)', () => {
  const r = {};
  for (const p of ['point', 'open', 'fist', 'pinch', 'rclick', 'scroll']) {
    r[p] = measure(makeHand({ pose: p }).wl);
  }
  assert.ok(r.point.ratio.index > 1.55 && r.point.ratio.middle < 1.35, 'point: index extended, middle bent');
  assert.ok(r.open.ratio.pinky > 1.55, 'open: pinky extended');
  assert.ok(r.fist.ratio.index < 1.12, 'fist: index closed');
  assert.ok(r.pinch.pinchIndex < 0.28 && r.pinch.ratio.index > 1.12, 'pinch: tips together, index not closed');
  assert.ok(r.rclick.pinchMiddle < 0.28 && r.rclick.pinchIndex > 0.5, 'pinch with the middle finger');
  assert.ok(r.scroll.ratio.index > 1.55 && r.scroll.ratio.middle > 1.55 && r.scroll.ratio.ring < 1.35, 'V: two fingers');
});

test('One Euro: removes jitter when still and follows fast movements', () => {
  const { minCutoff, beta } = smoothingToParams(0.5);
  const f = new OneEuro({ minCutoff, beta });
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const raw = [], out = [];
  for (let i = 0; i < 150; i++) { const x = 960 + rnd() * 12; raw.push(x); out.push(f.filter(x, i * 33)); }
  const sd = (a) => { const m = a.reduce((p, c) => p + c) / a.length; return Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / a.length); };
  const reduction = sd(raw.slice(30)) / sd(out.slice(30));
  assert.ok(reduction > 2, `jitter reduced ${reduction.toFixed(1)}x (expected >2 at smoothing 0.5)`);
  // fast jump: it must arrive almost immediately
  const g = new OneEuro({ minCutoff, beta });
  for (let i = 0; i < 20; i++) g.filter(500, i * 33);
  let y = 0; for (let i = 20; i < 26; i++) y = g.filter(1500, i * 33);
  assert.ok(y > 1300, 'follows a fast movement within ~6 frames');
});

test('active area: corners and centre', () => {
  const area = { cx: 0.5, cy: 0.5, w: 0.5, h: 0.4 };
  assert.deepEqual(mapToScreen(0.5, 0.5, area), { x: 0.5, y: 0.5 });
  assert.deepEqual(mapToScreen(0.25, 0.3, area), { x: 0, y: 0 });
  assert.deepEqual(mapToScreen(0.99, 0.99, area), { x: 1, y: 1 });
  const a = areaFromCorners({ u: 0.3, v: 0.3 }, { u: 0.7, v: 0.6 });
  assert.ok(a.w > 0.4 && a.cx > 0.49 && a.cx < 0.51);
});

test('calibration never produces a tiny area (it would magnify the camera noise)', () => {
  const a = areaFromCorners({ u: 0.3, v: 0.5 }, { u: 0.7, v: 0.55 }); // almost no vertical travel
  assert.ok(a.h >= 0.28 - 1e-9 && a.w >= 0.28 - 1e-9, `area ${a.w.toFixed(2)} x ${a.h.toFixed(2)} is at least the minimum`);
  assert.ok(a.cy - a.h / 2 >= 0 && a.cy + a.h / 2 <= 1, 'stays inside the frame');
});

test('smoothing still works with a small active area (the filter works on the camera measurement)', () => {
  // the same camera noise, with a big area and with the smallest allowed one: the output must stay calm in both
  for (const area of [{ cx: 0.5, cy: 0.5, w: 0.8, h: 0.8 }, { cx: 0.5, cy: 0.5, w: 0.28, h: 0.28 }]) {
    const { eng, events } = setup({ control: { area } });
    eng.setMode('active');
    let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    let t = 0; const ys = [];
    for (let i = 0; i < 90; i++, t += 66) {
      eng.update(frame(t, makeHand({ pose: 'point', at: { x: 0.5 + rnd() * 0.004, y: 0.5 + rnd() * 0.004 } })));
    }
    const moves = events.filter((e) => e.type === 'move').slice(30);
    const sd = (a) => { const m = a.reduce((p, c) => p + c) / a.length; return Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / a.length); };
    const out = sd(moves.map((e) => e.y * 1080));
    const raw = (0.004 * 720 / Math.sqrt(12) * 720 / 720) * (1080 / (area.h * 720));   // uniform noise → sd, mapped to screen px
    assert.ok(out < raw * 0.75, `area ${area.h}: output jitter ${out.toFixed(1)} px vs raw ${raw.toFixed(1)} px`);
  }
});

test('while PAUSED the hand moves nothing', () => {
  const { eng, events } = setup();
  run(eng, 0, 1000, () => makeHand({ pose: 'point', at: CENTER }));
  assert.equal(events.length, 0);
});

test('open hand held still activates; again it pauses (and does not bounce)', () => {
  const { eng, events } = setup();
  let t = run(eng, 0, 1200, () => makeHand({ pose: 'open' }));
  assert.equal(eng.mode, 'paused', 'after 1.2 s still paused (1.6 s needed)');
  t = run(eng, t, 700, () => makeHand({ pose: 'open' }));
  assert.equal(eng.mode, 'active');
  assert.deepEqual(events.filter((e) => e.type === 'mode-request').map((e) => e.mode), ['active']);
  t = run(eng, t, 3000, () => makeHand({ pose: 'open' })); // keep holding it: must NOT bounce back to paused by itself
  assert.equal(eng.mode, 'active', 'holding the hand open after activating changes nothing');
  t = run(eng, t, 400, () => makeHand({ pose: 'point', at: CENTER })); // lower the gesture...
  t = run(eng, t, 1100, () => makeHand({ pose: 'open' }));             // ...and make it again: now ~0.9 s is needed
  assert.equal(eng.mode, 'paused');
  assert.deepEqual(events.filter((e) => e.type === 'mode-request').map((e) => e.mode), ['active', 'paused']);
});

test('waving with an open hand activates nothing', () => {
  const { eng } = setup();
  run(eng, 0, 4000, (ms) => makeHand({ pose: 'open', at: { x: 0.3 + 0.3 * Math.abs(Math.sin(ms / 400)), y: 0.5 } }));
  assert.equal(eng.mode, 'paused');
});

test('closed fist = emergency lock, and once locked gestures do nothing', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  const t = run(eng, 0, 1300, () => makeHand({ pose: 'fist' }));
  assert.equal(eng.mode, 'locked');
  events.length = 0;
  let t2 = run(eng, t, 2500, () => makeHand({ pose: 'open' }));
  assert.equal(eng.mode, 'locked', 'an open hand does NOT unlock');
  run(eng, t2, 1000, () => makeHand({ pose: 'point', at: CENTER }));
  assert.equal(events.filter((e) => e.type === 'move').length, 0);
});

test('index finger up: the cursor goes where you point (mirrored) and reaches centre and corners', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  run(eng, 0, 1500, () => makeHand({ pose: 'point', at: { x: 0.5, y: 0.5 } }));
  let last = [...events].reverse().find((e) => e.type === 'move');
  assert.ok(Math.abs(last.x - 0.5) < 0.01 && Math.abs(last.y - 0.5) < 0.01, 'centre');
  // hand on the right side of the image (mirrored = left of the screen)
  run(eng, 2000, 1500, () => makeHand({ pose: 'point', at: { x: 0.95, y: 0.1 } }));
  last = [...events].reverse().find((e) => e.type === 'move');
  assert.ok(last.x < 0.02 && last.y < 0.02, `top-left corner (${last.x.toFixed(3)}, ${last.y.toFixed(3)})`);
});

test('pinch = click: cursor still at the point, down then up', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  events.length = 0;
  // the hand "slides" a little while the pinch closes: the click must land where you were pointing
  t = run(eng, t, 200, (ms) => makeHand({ pose: 'pinch', at: { x: 0.5 + ms * 0.00015, y: 0.5 } }));
  t = run(eng, t, 100, () => makeHand({ pose: 'point', at: CENTER }));
  assert.deepEqual(types(events.filter((e) => e.type !== 'move')), ['down:left', 'up:left']);
  const down = events.findIndex((e) => e.type === 'down');
  const mv = events[down - 1];
  assert.equal(mv.type, 'move');
  assert.ok(Math.abs(mv.x - 0.5) < 0.01, 'the click lands on the point from before the pinch');
});

test('held and moved pinch = drag; opening releases', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  events.length = 0;
  t = run(eng, t, 900, (ms) => makeHand({ pose: 'pinch', at: { x: 0.5 - Math.min(ms, 900) * 0.0003, y: 0.5 } }));
  assert.ok(events.some((e) => e.type === 'down'));
  assert.ok(!events.some((e) => e.type === 'up'), 'still held');
  const moves = events.filter((e) => e.type === 'move');
  assert.ok(moves[moves.length - 1].x > 0.55, 'dragged to the right (mirror)');
  t = run(eng, t, 200, () => makeHand({ pose: 'point', at: CENTER }));
  assert.equal(events.filter((e) => e.type === 'up').length, 1);
});

test('double click: the second pinch sticks to the first', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  events.length = 0;
  for (let i = 0; i < 2; i++) {
    t = run(eng, t, 150, () => makeHand({ pose: 'pinch', at: { x: 0.5 + i * 0.004, y: 0.5 } }));
    t = run(eng, t, 120, () => makeHand({ pose: 'point', at: { x: 0.5 + i * 0.004, y: 0.5 } }));
  }
  const downs = events.map((e, i) => [e, i]).filter(([e]) => e.type === 'down');
  assert.equal(downs.length, 2);
  const [m1, m2] = downs.map(([, i]) => events[i - 1]);
  assert.ok(Math.abs(m1.x - m2.x) * 1920 < 3 && Math.abs(m1.y - m2.y) * 1080 < 3, 'same pixels (±3)');
});

test('thumb + middle pinch = right click (once only)', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  events.length = 0;
  t = run(eng, t, 600, () => makeHand({ pose: 'rclick', at: CENTER }));
  assert.deepEqual(types(events.filter((e) => e.type === 'click')), ['click:right']);
  assert.ok(!events.some((e) => e.type === 'down'), 'no left button');
});

test('two fingers (V) up/down = scrolling, "natural" direction and the opposite', () => {
  for (const natural of [true, false]) {
    const { eng, events } = setup({ scroll: { natural } });
    eng.setMode('active');
    let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
    t = run(eng, t, 400, () => makeHand({ pose: 'scroll', at: { x: 0.5, y: 0.6 } }));
    events.length = 0;
    // hand moving up (y decreasing) for half a second
    t = run(eng, t, 500, (ms) => makeHand({ pose: 'scroll', at: { x: 0.5, y: 0.6 - ms * 0.0003 } }));
    const wheels = events.filter((e) => e.type === 'wheel');
    assert.ok(wheels.length > 0, 'it scrolled');
    const sum = wheels.reduce((p, e) => p + e.delta, 0);
    assert.ok(natural ? sum < 0 : sum > 0, `natural=${natural}: hand up → sum ${sum}`);
    assert.ok(!events.some((e) => e.type === 'move'), 'the cursor does not move while scrolling');
  }
  // still = no scrolling
  const { eng, events } = setup();
  eng.setMode('active');
  const t = run(eng, 0, 600, () => makeHand({ pose: 'scroll', at: { x: 0.5, y: 0.6 } }));
  assert.equal(events.filter((e) => e.type === 'wheel').length, 0);
});

test('hand lost during a drag: the button is released', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 700, () => makeHand({ pose: 'pinch', at: CENTER }));
  events.length = 0;
  t = run(eng, t, 600, () => null);
  assert.equal(events.filter((e) => e.type === 'up').length, 1);
});

test('hand not seen for a long time = automatic pause', () => {
  const { eng, events } = setup({ safety: { autoPauseSec: 5 } });
  eng.setMode('active');
  let t = run(eng, 0, 500, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 4000, () => null);
  assert.equal(eng.mode, 'active');
  t = run(eng, t, 2000, () => null);
  assert.equal(eng.mode, 'paused');
  assert.ok(events.some((e) => e.type === 'mode-request' && e.mode === 'paused'));
});

test('leaving ACTIVE while the button is held releases it', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 500, () => makeHand({ pose: 'pinch', at: CENTER }));
  events.length = 0;
  eng.setMode('locked');
  assert.deepEqual(types(events), ['up:left']);
});

test('chosen hand: with "right" the left one is ignored', () => {
  const { eng, events } = setup({ control: { hand: 'right' } });
  eng.setMode('active');
  const left = makeHand({ pose: 'point', at: CENTER, label: 'left' });
  for (let t = 0; t < 800; t += 33) eng.update({ t, hands: [left] });
  assert.equal(events.length, 0);
});

// ───────────── pointer anchor, action gestures, two-hand mode ─────────────
function runHands(eng, t0, ms, fn, fps = 30) {
  const dt = 1000 / fps;
  let t = t0;
  for (; t < t0 + ms; t += dt) eng.update({ t, hands: fn(t - t0) });
  return t;
}

test('palm anchor stays put when the fingers move (more than the knuckle, much more than the tip)', () => {
  const shift = (pointAt) => {
    const { eng } = setup({ control: { pointAt } });
    eng.setMode('active');
    eng.update(frame(0, makeHand({ pose: 'point', at: CENTER })));
    const a = eng.hud.anchor;
    eng.update(frame(33, makeHand({ pose: 'pinch', at: CENTER })));
    const b = eng.hud.anchor;
    return Math.hypot((a.u - b.u) * 1280, (a.v - b.v) * 720);
  };
  const palm = shift('palm'), knuckle = shift('knuckle'), tip = shift('tip');
  assert.ok(palm < knuckle && knuckle < tip, `shift in pixels: palm ${palm.toFixed(1)} < knuckle ${knuckle.toFixed(1)} < tip ${tip.toFixed(1)}`);
});

test('ring pinch held = action "ring", once; pinky pinch = action "pinky"; the cursor does not move', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  events.length = 0;
  t = run(eng, t, 300, () => makeHand({ pose: 'ringpinch', at: CENTER }));
  assert.equal(events.filter((e) => e.type === 'action').length, 0, 'too short: no action yet');
  t = run(eng, t, 1200, () => makeHand({ pose: 'ringpinch', at: CENTER }));
  assert.deepEqual(events.filter((e) => e.type === 'action').map((e) => e.which), ['ring'], 'fires once however long it is held');
  const mv = events.filter((e) => e.type === 'move');
  assert.ok(mv.every((e) => Math.abs(e.x - mv[0].x) < 0.002 && Math.abs(e.y - mv[0].y) < 0.002), 'the cursor stays where it was during the gesture');
  t = run(eng, t, 300, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 900, () => makeHand({ pose: 'pinkypinch', at: CENTER }));
  assert.deepEqual(events.filter((e) => e.type === 'action').map((e) => e.which), ['ring', 'pinky']);
});

test('action gestures do nothing while PAUSED', () => {
  const { eng, events } = setup();
  run(eng, 0, 2000, () => makeHand({ pose: 'ringpinch', at: CENTER }));
  assert.equal(events.filter((e) => e.type === 'action').length, 0);
});

test('two-hand mode: the other hand clicks while the steering hand keeps moving', () => {
  const { eng, events } = setup({ control: { twoHands: true, cursorHand: 'right' } });
  eng.setMode('active');
  const R = (ms, pose = 'point') => makeHand({ pose, at: { x: 0.35 + ms * 0.00005, y: 0.5 }, label: 'right' });
  const Lh = (pose) => makeHand({ pose, at: { x: 0.7, y: 0.5 }, label: 'left' });
  let t = runHands(eng, 0, 800, (ms) => [R(ms), Lh('point')]);
  events.length = 0;
  t = runHands(eng, t, 200, (ms) => [R(800 + ms), Lh('pinch')]);   // quick pinch of the OTHER hand
  t = runHands(eng, t, 200, (ms) => [R(1000 + ms), Lh('point')]);
  assert.deepEqual(types(events.filter((e) => e.type !== 'move')), ['down:left', 'up:left'], 'a click from the helper hand');
  assert.ok(events.filter((e) => e.type === 'move').length > 8, 'the cursor kept being steered meanwhile');
});

test('two-hand mode: helper pinch held while steering = drag; helper V = scroll; helper thumb+middle = right click', () => {
  const { eng, events } = setup({ control: { twoHands: true, cursorHand: 'right' } });
  eng.setMode('active');
  const R = (ms) => makeHand({ pose: 'point', at: { x: 0.3 + ms * 0.0001, y: 0.5 }, label: 'right' });
  const Lh = (pose, y = 0.5) => makeHand({ pose, at: { x: 0.75, y }, label: 'left' });
  let t = runHands(eng, 0, 800, (ms) => [R(ms), Lh('point')]);
  events.length = 0;
  t = runHands(eng, t, 900, (ms) => [R(800 + ms), Lh('pinch')]);
  assert.ok(events.some((e) => e.type === 'down') && !events.some((e) => e.type === 'up'), 'button held by the helper hand');
  const moves = events.filter((e) => e.type === 'move');
  assert.ok(moves[moves.length - 1].x < moves[1].x - 0.02, 'steering moved the cursor while it was held (drag; mirrored)');
  t = runHands(eng, t, 200, (ms) => [R(1700 + ms), Lh('point')]);
  assert.equal(events.filter((e) => e.type === 'up').length, 1, 'released when the helper opens');
  events.length = 0;
  t = runHands(eng, t, 400, () => [R(1900), Lh('scroll', 0.6)]);
  t = runHands(eng, t, 500, (ms) => [R(1900), Lh('scroll', 0.6 - ms * 0.0003)]);
  assert.ok(events.filter((e) => e.type === 'wheel').length > 0, 'helper scrolls');
  events.length = 0;
  t = runHands(eng, t, 600, () => [R(1900), Lh('rclick')]);
  assert.deepEqual(types(events.filter((e) => e.type === 'click')), ['click:right']);
});

test('two-hand mode: a fist or an open hand on the helper hand does nothing', () => {
  const { eng } = setup({ control: { twoHands: true, cursorHand: 'right' } });
  eng.setMode('active');
  const R = makeHand({ pose: 'point', at: { x: 0.35, y: 0.5 }, label: 'right' });
  runHands(eng, 0, 2500, () => [R, makeHand({ pose: 'fist', at: { x: 0.75, y: 0.5 }, label: 'left' })]);
  assert.equal(eng.mode, 'active', 'no lock from the helper fist');
});

test('two-hand mode: if the helper hand disappears while holding the button, it is released', () => {
  const { eng, events } = setup({ control: { twoHands: true, cursorHand: 'right' } });
  eng.setMode('active');
  const R = makeHand({ pose: 'point', at: { x: 0.35, y: 0.5 }, label: 'right' });
  let t = runHands(eng, 0, 800, () => [R, makeHand({ pose: 'point', at: { x: 0.75, y: 0.5 }, label: 'left' })]);
  t = runHands(eng, t, 500, () => [R, makeHand({ pose: 'pinch', at: { x: 0.75, y: 0.5 }, label: 'left' })]);
  events.length = 0;
  t = runHands(eng, t, 600, () => [R]);
  assert.equal(events.filter((e) => e.type === 'up').length, 1);
});

test('single-hand mode ignores the second hand', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  const R = makeHand({ pose: 'point', at: { x: 0.35, y: 0.5 }, label: 'right', size: 0.2 });
  runHands(eng, 0, 800, () => [R, makeHand({ pose: 'pinch', at: { x: 0.75, y: 0.5 }, label: 'left', size: 0.1 })]);
  assert.ok(!events.some((e) => e.type === 'down'), 'the smaller hand is not used');
});
test('after a click the cursor stays where it clicked for a moment (so a double click works), then follows the hand again', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 200, () => makeHand({ pose: 'pinch', at: CENTER }));
  const clickAt = [...events].reverse().find((e) => e.type === 'move');
  events.length = 0;
  // the fingers reopen and the pointing point shifts a few pixels (here ~8 px on the screen)
  t = run(eng, t, 300, () => makeHand({ pose: 'point', at: { x: 0.5 + 0.004, y: 0.5 + 0.006 } }));
  const stuck = events.filter((e) => e.type === 'move');
  assert.ok(stuck.length > 3 && stuck.every((e) => Math.abs(e.x - clickAt.x) * 1920 < 1 && Math.abs(e.y - clickAt.y) * 1080 < 1), 'cursor held at the click position');
  events.length = 0;
  t = run(eng, t, 900, () => makeHand({ pose: 'point', at: { x: 0.5 + 0.004, y: 0.5 + 0.006 } }));
  const last = [...events].reverse().find((e) => e.type === 'move');
  assert.ok(Math.abs(last.y - clickAt.y) * 1080 > 3, 'after the short window it follows the hand again');
});
// ───────────── dragging: aim look-back, glide at the start of a drag, holding through slips ─────────────
const clickPos = (events) => { const i = events.findIndex((e) => e.type === 'down'); return events[i - 1]; };
const px = (a, b) => Math.hypot((a.x - b.x) * 1920, (a.y - b.y) * 1080);

test('click aim: if the aim was calm, the click lands on the calm position BEFORE the pinch nudged the hand', () => {
  const run1 = (lookbackMs) => {
    const { eng, events } = setup({ clicks: { lookbackMs } });
    eng.setMode('active');
    let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
    const start = [...events].reverse().find((e) => e.type === 'move');
    // the hand drifts a little while the fingers close (about 15 px on the screen), then the pinch is recognised
    t = run(eng, t, 250, (ms) => makeHand({ pose: 'point', at: { x: 0.5 + 0.004 * (ms / 250), y: 0.5 } }));
    events.length = 0;
    t = run(eng, t, 200, () => makeHand({ pose: 'pinch', at: { x: 0.504, y: 0.5 } }));
    return px(clickPos(events), start);
  };
  const withLookback = run1(400), without = run1(0);
  assert.ok(withLookback < without, `distance from the aimed point: ${withLookback.toFixed(1)} px with look-back < ${without.toFixed(1)} px without`);
});

test('click aim: if the hand was moving, the click is NOT pulled back', () => {
  const run1 = (lookbackMs) => {
    const { eng, events } = setup({ clicks: { lookbackMs } });
    eng.setMode('active');
    let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: { x: 0.4, y: 0.5 } }));
    t = run(eng, t, 400, (ms) => makeHand({ pose: 'point', at: { x: 0.4 + 0.00013 * ms, y: 0.5 } })); // ~500 px/s
    events.length = 0;
    t = run(eng, t, 200, (ms) => makeHand({ pose: 'pinch', at: { x: 0.452 + 0.00013 * ms, y: 0.5 } }));
    return clickPos(events);
  };
  assert.ok(px(run1(250), run1(0)) < 1, 'same position with and without look-back');
});

test('drag start: the cursor glides from where it was held to the hand in small steps (no single jump)', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 250, () => makeHand({ pose: 'pinch', at: CENTER }));
  events.length = 0;
  // during the 0.28 s freeze the hand has gone far away (~380 px): at the end of the freeze the cursor must catch up gradually
  t = run(eng, t, 900, () => makeHand({ pose: 'pinch', at: { x: 0.4, y: 0.5 } }));
  const moves = events.filter((e) => e.type === 'move');
  let maxStep = 0;
  for (let i = 1; i < moves.length; i++) maxStep = Math.max(maxStep, px(moves[i], moves[i - 1]));
  assert.ok(maxStep <= 41, `largest cursor step ${maxStep.toFixed(1)} px (limit 40)`);
  assert.ok(moves.length > 5, 'several regular moves while the drag starts');
  const last = moves[moves.length - 1];
  assert.ok(last.x > 0.55, 'it reached the hand (mirrored: the hand moved left in the image, so the cursor goes right)');
});

test('dragging: a brief slip of the pinch does not drop what you carry; a real release does', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 900, (ms) => makeHand({ pose: 'pinch', at: { x: 0.5 - 0.0001 * ms, y: 0.5 } })); // dragging now
  events.length = 0;
  t = run(eng, t, 66, () => makeHand({ pose: 'point', at: { x: 0.41, y: 0.5 } }));  // slip: 2 frames
  t = run(eng, t, 300, () => makeHand({ pose: 'pinch', at: { x: 0.41, y: 0.5 } }));
  assert.equal(events.filter((e) => e.type === 'up').length, 0, 'not dropped by a 66 ms slip');
  t = run(eng, t, 400, () => makeHand({ pose: 'point', at: { x: 0.41, y: 0.5 } }));
  assert.equal(events.filter((e) => e.type === 'up').length, 1, 'dropped when the pinch really opens');
});