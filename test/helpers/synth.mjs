// Mani finte per i test: costruisce i 21 punti di una mano in una posa data,
// sia in metri ("world") sia nell'immagine. Nessuna fotocamera, nessun dato personale.

const HS = 0.09; // polso → nocca del medio, in metri

// base delle dita (x, y) in metri; y negativo = verso l'alto
const MCP = {
  index: [0.025, -0.088],
  middle: [0.0, -0.09],
  ring: [-0.022, -0.085],
  pinky: [-0.043, -0.075],
};
const SEG = {
  index: [0.040, 0.025, 0.022],
  middle: [0.045, 0.028, 0.024],
  ring: [0.041, 0.026, 0.023],
  pinky: [0.032, 0.019, 0.019],
};
const FIRST = { index: 5, middle: 9, ring: 13, pinky: 17 };

// flessione cumulativa (gradi) delle tre falangi
const FLEX = {
  straight: [0, 0, 0],
  curled: [90, 90, 80],
  halfPinch: [30, 55, 60], // indice nel pizzico: piegato ma non chiuso
  half: [45, 60, 40],
};

function finger(name, flex) {
  const [mx, my] = MCP[name];
  const pts = [{ x: mx, y: my, z: 0 }];
  let cur = { x: mx, y: my, z: 0 };
  let A = 0;
  for (let i = 0; i < 3; i++) {
    A += flex[i] * Math.PI / 180;
    // si piega verso la telecamera (z negativo = verso chi guarda)
    cur = { x: cur.x, y: cur.y - Math.cos(A) * SEG[name][i], z: cur.z - Math.sin(A) * SEG[name][i] };
    pts.push(cur);
  }
  return pts; // [mcp, pip, dip, tip]
}

const POSES = {
  // nome: { dita: [indice, medio, anulare, mignolo], thumb: 'out'|'tuck'|'index'|'middle'|'fist' }
  point: { f: ['straight', 'curled', 'curled', 'curled'], thumb: 'tuck' },
  open: { f: ['straight', 'straight', 'straight', 'straight'], thumb: 'out' },
  fist: { f: ['curled', 'curled', 'curled', 'curled'], thumb: 'fist' },
  pinch: { f: ['halfPinch', 'curled', 'curled', 'curled'], thumb: 'index' },
  pinchOpenHand: { f: ['halfPinch', 'straight', 'straight', 'straight'], thumb: 'index' },
  rclick: { f: ['straight', 'halfPinch', 'curled', 'curled'], thumb: 'middle' },
  scroll: { f: ['straight', 'straight', 'curled', 'curled'], thumb: 'tuck' },
};

/**
 * @param pose  nome della posa
 * @param at    dove sta il punto "nocca dell'indice" nell'immagine intera: {x, y} (0..1, NON a specchio)
 * @param size  grandezza della mano nell'immagine (polso→nocca medio) in frazione dell'altezza
 * @param pinch (facoltativo) apertura del pizzico 0..1 per prove graduali (0 = chiuso)
 */
export function makeHand({ pose = 'point', at = { x: 0.5, y: 0.5 }, size = 0.12, aspect = 16 / 9, label = 'right' } = {}) {
  const P = POSES[pose];
  if (!P) throw new Error('posa sconosciuta: ' + pose);
  const w = new Array(21);
  w[0] = { x: 0, y: 0, z: 0 };
  const names = ['index', 'middle', 'ring', 'pinky'];
  const tips = {};
  names.forEach((n, i) => {
    const pts = finger(n, FLEX[P.f[i]]);
    const b = FIRST[n];
    w[b] = pts[0]; w[b + 1] = pts[1]; w[b + 2] = pts[2]; w[b + 3] = pts[3];
    tips[n] = pts[3];
  });
  // pollice: 1..4
  const setThumb = (cmc, mcp, ip, tip) => { w[1] = cmc; w[2] = mcp; w[3] = ip; w[4] = tip; };
  const T = {
    out: [[0.025, -0.02, 0], [0.048, -0.045, 0], [0.065, -0.065, 0], [0.078, -0.082, 0]],
    tuck: [[0.025, -0.02, 0], [0.04, -0.04, -0.01], [0.05, -0.055, -0.02], [0.05, -0.062, -0.03]],
    fist: [[0.025, -0.02, 0], [0.035, -0.045, -0.02], [0.02, -0.06, -0.04], [0.005, -0.068, -0.045]],
  };
  const near = (p, dx = 0.006) => ({ x: p.x + dx, y: p.y + 0.002, z: p.z - 0.002 });
  if (P.thumb === 'index') {
    const t = near(tips.index);
    setThumb({ x: 0.025, y: -0.02, z: 0 }, { x: 0.04, y: -0.045, z: -0.01 },
      { x: (0.04 + t.x) / 2 + 0.01, y: (-0.045 + t.y) / 2, z: -0.02 }, t);
  } else if (P.thumb === 'middle') {
    const t = near(tips.middle, -0.006);
    setThumb({ x: 0.025, y: -0.02, z: 0 }, { x: 0.035, y: -0.04, z: -0.01 },
      { x: (0.035 + t.x) / 2, y: (-0.04 + t.y) / 2, z: -0.02 }, t);
  } else {
    setThumb(...T[P.thumb].map(([x, y, z]) => ({ x, y, z })));
  }

  // immagine: stesso disegno, scalato e traslato (z ignorata nella proiezione)
  const sc = size / HS;               // metri → frazione dell'altezza
  const knuckle = { x: (w[5].x + w[6].x) / 2, y: (w[5].y + w[6].y) / 2 };
  const lm = w.map((p) => ({
    x: at.x + ((p.x - knuckle.x) * sc) / aspect,
    y: at.y + (p.y - knuckle.y) * sc,
    z: p.z * sc,
  }));
  return { lm, wl: w, label };
}

/** Un fotogramma per l'engine. */
export function frame(t, hand, meta) {
  return { t, hands: hand ? [hand] : [], meta };
}

/** Fa girare l'engine con la stessa mano per `ms` millisecondi a `fps`. Ritorna il tempo finale. */
export function run(engine, t0, ms, handFn, fps = 30) {
  const dt = 1000 / fps;
  let t = t0;
  for (; t < t0 + ms; t += dt) engine.update(frame(t, handFn(t - t0)));
  return t;
}
