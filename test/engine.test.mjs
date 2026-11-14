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
// un punto dell'immagine (non a specchio) che corrisponde a metà schermo
const CENTER = { x: 0.5, y: 0.5 };

test('le pose finte vengono riconosciute (misure della mano)', () => {
  const r = {};
  for (const p of ['point', 'open', 'fist', 'pinch', 'rclick', 'scroll']) {
    r[p] = measure(makeHand({ pose: p }).wl);
  }
  assert.ok(r.point.ratio.index > 1.55 && r.point.ratio.middle < 1.35, 'punto: indice teso, medio piegato');
  assert.ok(r.open.ratio.pinky > 1.55, 'aperta: mignolo teso');
  assert.ok(r.fist.ratio.index < 1.12, 'pugno: indice chiuso');
  assert.ok(r.pinch.pinchIndex < 0.28 && r.pinch.ratio.index > 1.12, 'pizzico: punte unite, indice non chiuso');
  assert.ok(r.rclick.pinchMiddle < 0.28 && r.rclick.pinchIndex > 0.5, 'pizzico col medio');
  assert.ok(r.scroll.ratio.index > 1.55 && r.scroll.ratio.middle > 1.55 && r.scroll.ratio.ring < 1.35, 'V: due dita');
});

test('One Euro: toglie il tremolio da fermo e segue i movimenti veloci', () => {
  const { minCutoff, beta } = smoothingToParams(0.5);
  const f = new OneEuro({ minCutoff, beta });
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const raw = [], out = [];
  for (let i = 0; i < 150; i++) { const x = 960 + rnd() * 12; raw.push(x); out.push(f.filter(x, i * 33)); }
  const sd = (a) => { const m = a.reduce((p, c) => p + c) / a.length; return Math.sqrt(a.reduce((p, c) => p + (c - m) ** 2, 0) / a.length); };
  const reduction = sd(raw.slice(30)) / sd(out.slice(30));
  assert.ok(reduction > 2, `tremolio ridotto di ${reduction.toFixed(1)}x (atteso >2 a smorzamento 0.5)`);
  // salto veloce: deve arrivare quasi subito
  const g = new OneEuro({ minCutoff, beta });
  for (let i = 0; i < 20; i++) g.filter(500, i * 33);
  let y = 0; for (let i = 20; i < 26; i++) y = g.filter(1500, i * 33);
  assert.ok(y > 1300, 'segue un movimento veloce entro ~6 fotogrammi');
});

test('area attiva: angoli e centro', () => {
  const area = { cx: 0.5, cy: 0.5, w: 0.5, h: 0.4 };
  assert.deepEqual(mapToScreen(0.5, 0.5, area), { x: 0.5, y: 0.5 });
  assert.deepEqual(mapToScreen(0.25, 0.3, area), { x: 0, y: 0 });
  assert.deepEqual(mapToScreen(0.99, 0.99, area), { x: 1, y: 1 });
  const a = areaFromCorners({ u: 0.3, v: 0.3 }, { u: 0.7, v: 0.6 });
  assert.ok(a.w > 0.4 && a.cx > 0.49 && a.cx < 0.51);
});

test('in PAUSA la mano non muove nulla', () => {
  const { eng, events } = setup();
  run(eng, 0, 1000, () => makeHand({ pose: 'point', at: CENTER }));
  assert.equal(events.length, 0);
});

test('mano aperta tenuta ferma attiva; di nuovo la mette in pausa (e non rimbalza)', () => {
  const { eng, events } = setup();
  let t = run(eng, 0, 1200, () => makeHand({ pose: 'open' }));
  assert.equal(eng.mode, 'paused', 'dopo 1,2 s ancora in pausa (serve 1,6 s)');
  t = run(eng, t, 700, () => makeHand({ pose: 'open' }));
  assert.equal(eng.mode, 'active');
  assert.deepEqual(events.filter((e) => e.type === 'mode-request').map((e) => e.mode), ['active']);
  t = run(eng, t, 3000, () => makeHand({ pose: 'open' })); // continua a tenerla: NON deve rimbalzare in pausa da sola
  assert.equal(eng.mode, 'active', 'tenere la mano aperta dopo aver attivato non cambia nulla');
  t = run(eng, t, 400, () => makeHand({ pose: 'point', at: CENTER })); // abbassa il gesto...
  t = run(eng, t, 1100, () => makeHand({ pose: 'open' }));             // ...e rifalla: ora serve ~0,9 s
  assert.equal(eng.mode, 'paused');
  assert.deepEqual(events.filter((e) => e.type === 'mode-request').map((e) => e.mode), ['active', 'paused']);
});

test('salutare con la mano aperta non attiva niente', () => {
  const { eng } = setup();
  run(eng, 0, 4000, (ms) => makeHand({ pose: 'open', at: { x: 0.3 + 0.3 * Math.abs(Math.sin(ms / 400)), y: 0.5 } }));
  assert.equal(eng.mode, 'paused');
});

test('pugno chiuso = blocco di emergenza, e da bloccato i gesti non fanno più nulla', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  const t = run(eng, 0, 1300, () => makeHand({ pose: 'fist' }));
  assert.equal(eng.mode, 'locked');
  events.length = 0;
  let t2 = run(eng, t, 2500, () => makeHand({ pose: 'open' }));
  assert.equal(eng.mode, 'locked', 'la mano aperta NON sblocca');
  run(eng, t2, 1000, () => makeHand({ pose: 'point', at: CENTER }));
  assert.equal(events.filter((e) => e.type === 'move').length, 0);
});

test('indice teso: il cursore va dove punti (a specchio) e arriva a centro e angoli', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  run(eng, 0, 1500, () => makeHand({ pose: 'point', at: { x: 0.5, y: 0.5 } }));
  let last = [...events].reverse().find((e) => e.type === 'move');
  assert.ok(Math.abs(last.x - 0.5) < 0.01 && Math.abs(last.y - 0.5) < 0.01, 'centro');
  // mano alla destra dell'immagine (a specchio = sinistra dello schermo)
  run(eng, 2000, 1500, () => makeHand({ pose: 'point', at: { x: 0.95, y: 0.1 } }));
  last = [...events].reverse().find((e) => e.type === 'move');
  assert.ok(last.x < 0.02 && last.y < 0.02, `angolo alto-sinistra (${last.x.toFixed(3)}, ${last.y.toFixed(3)})`);
});

test('pizzico = click: cursore fermo al punto, giù poi su', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  events.length = 0;
  // la mano "scivola" un po' mentre il pizzico si chiude: il click deve cadere dove puntavi
  t = run(eng, t, 200, (ms) => makeHand({ pose: 'pinch', at: { x: 0.5 + ms * 0.00015, y: 0.5 } }));
  t = run(eng, t, 100, () => makeHand({ pose: 'point', at: CENTER }));
  assert.deepEqual(types(events.filter((e) => e.type !== 'move')), ['down:left', 'up:left']);
  const down = events.findIndex((e) => e.type === 'down');
  const mv = events[down - 1];
  assert.equal(mv.type, 'move');
  assert.ok(Math.abs(mv.x - 0.5) < 0.01, 'il click cade sul punto di prima del pizzico');
});

test('pizzico tenuto e mosso = trascinamento; apri = rilascia', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  events.length = 0;
  t = run(eng, t, 900, (ms) => makeHand({ pose: 'pinch', at: { x: 0.5 - Math.min(ms, 900) * 0.0003, y: 0.5 } }));
  assert.ok(events.some((e) => e.type === 'down'));
  assert.ok(!events.some((e) => e.type === 'up'), 'ancora premuto');
  const moves = events.filter((e) => e.type === 'move');
  assert.ok(moves[moves.length - 1].x > 0.55, 'ha trascinato verso destra (specchio)');
  t = run(eng, t, 200, () => makeHand({ pose: 'point', at: CENTER }));
  assert.equal(events.filter((e) => e.type === 'up').length, 1);
});

test('doppio click: il secondo pizzico si incolla al primo', () => {
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
  assert.ok(Math.abs(m1.x - m2.x) * 1920 < 3 && Math.abs(m1.y - m2.y) * 1080 < 3, 'stessi pixel (±3)');
});

test('pizzico col medio = click destro (una volta sola)', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  events.length = 0;
  t = run(eng, t, 600, () => makeHand({ pose: 'rclick', at: CENTER }));
  assert.deepEqual(types(events.filter((e) => e.type === 'click')), ['click:right']);
  assert.ok(!events.some((e) => e.type === 'down'), 'niente tasto sinistro');
});

test('due dita (V) su/giù = scorrimento, direzione "naturale" e opposta', () => {
  for (const natural of [true, false]) {
    const { eng, events } = setup({ scroll: { natural } });
    eng.setMode('active');
    let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
    t = run(eng, t, 400, () => makeHand({ pose: 'scroll', at: { x: 0.5, y: 0.6 } }));
    events.length = 0;
    // mano che sale (y diminuisce) per mezzo secondo
    t = run(eng, t, 500, (ms) => makeHand({ pose: 'scroll', at: { x: 0.5, y: 0.6 - ms * 0.0003 } }));
    const wheels = events.filter((e) => e.type === 'wheel');
    assert.ok(wheels.length > 0, 'ha scorso');
    const sum = wheels.reduce((p, e) => p + e.delta, 0);
    assert.ok(natural ? sum < 0 : sum > 0, `natural=${natural}: mano su → somma ${sum}`);
    assert.ok(!events.some((e) => e.type === 'move'), 'il cursore non si muove mentre scorri');
  }
  // fermo = non scorre
  const { eng, events } = setup();
  eng.setMode('active');
  const t = run(eng, 0, 600, () => makeHand({ pose: 'scroll', at: { x: 0.5, y: 0.6 } }));
  assert.equal(events.filter((e) => e.type === 'wheel').length, 0);
});

test('mano persa durante un trascinamento: il tasto viene rilasciato', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 700, () => makeHand({ pose: 'pinch', at: CENTER }));
  events.length = 0;
  t = run(eng, t, 600, () => null);
  assert.equal(events.filter((e) => e.type === 'up').length, 1);
});

test('mano non vista a lungo = pausa automatica', () => {
  const { eng, events } = setup({ safety: { autoPauseSec: 5 } });
  eng.setMode('active');
  let t = run(eng, 0, 500, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 4000, () => null);
  assert.equal(eng.mode, 'active');
  t = run(eng, t, 2000, () => null);
  assert.equal(eng.mode, 'paused');
  assert.ok(events.some((e) => e.type === 'mode-request' && e.mode === 'paused'));
});

test('uscire da ATTIVO mentre il tasto è premuto lo rilascia', () => {
  const { eng, events } = setup();
  eng.setMode('active');
  let t = run(eng, 0, 800, () => makeHand({ pose: 'point', at: CENTER }));
  t = run(eng, t, 500, () => makeHand({ pose: 'pinch', at: CENTER }));
  events.length = 0;
  eng.setMode('locked');
  assert.deepEqual(types(events), ['up:left']);
});

test('mano scelta: con "destra" ignora la sinistra', () => {
  const { eng, events } = setup({ control: { hand: 'right' } });
  eng.setMode('active');
  const left = makeHand({ pose: 'point', at: CENTER, label: 'left' });
  for (let t = 0; t < 800; t += 33) eng.update({ t, hands: [left] });
  assert.equal(events.length, 0);
});

