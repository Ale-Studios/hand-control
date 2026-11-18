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
