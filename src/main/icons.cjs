// Draws the icons on the fly (no image files to carry around). Writes PNGs "by hand" with zlib.
//
// The app icon: a glowing hand skeleton (the same look as the HUD) on an anthracite rounded square
// with a thin silver bezel. The tray icons are the same drawing with the hand in the status colour.
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the hand: 21 MediaPipe-style points in a unit square (x right, y down) ──
const HAND = [
  [0.50, 0.86],                                                       // 0 wrist
  [0.41, 0.77], [0.31, 0.67], [0.24, 0.56], [0.19, 0.46],             // 1-4 thumb
  [0.38, 0.59], [0.35, 0.44], [0.33, 0.33], [0.32, 0.23],             // 5-8 index
  [0.48, 0.56], [0.48, 0.39], [0.48, 0.27], [0.48, 0.16],             // 9-12 middle
  [0.58, 0.58], [0.61, 0.43], [0.63, 0.32], [0.64, 0.23],             // 13-16 ring
  [0.67, 0.63], [0.72, 0.52], [0.75, 0.44], [0.77, 0.36],             // 17-20 pinky
];
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const TIPS = [4, 8, 12, 16, 20];
const PALM = [0, 1, 5, 9, 13, 17];

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

/**
 * App icon at `size` px. `hand` = colour of the hand (default: ice), `bezel` = colour of the thin frame.
 * Everything is computed per pixel from distances (no external drawing library), with 2x2 supersampling.
 */
function drawAppIcon(size, hand = [196, 236, 250], bezel = [207, 214, 222]) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 2;
  const small = size <= 40;
  const scale = 0.84, off = (1 - scale) / 2 + 0.005;
  const P = HAND.map(([x, y]) => [off + x * scale, off + y * scale + 0.01]);
  const lineW = small ? Math.max(1.5 / size, 0.045) : 0.028;
  const glowS = small ? 0.05 : 0.035;
  const dot = small ? 0.045 : 0.026;
  const R = 0.2; // corner radius of the rounded square

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
        // rounded square (signed distance)
        const qx = Math.abs(u - 0.5) - (0.5 - 0.035 - R), qy = Math.abs(v - 0.5) - (0.5 - 0.035 - R);
        const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
        const cover = 1 - smooth(-0.004, 0.004, sd);
        if (cover <= 0) continue;
        // anthracite gradient, a little lighter at the top, with a soft vignette
        let cr = mix(46, 20, v), cg = mix(50, 22, v), cb = mix(56, 26, v);
        const vig = 1 - 0.35 * smooth(0.25, 0.7, Math.hypot(u - 0.5, v - 0.5));
        cr *= vig; cg *= vig; cb *= vig;
        // thin silver bezel just inside the edge
        const bz = 1 - smooth(0.0, 0.012, Math.abs(sd + 0.012));
        cr = mix(cr, bezel[0], bz * 0.55); cg = mix(cg, bezel[1], bz * 0.55); cb = mix(cb, bezel[2], bz * 0.55);

        // palm (translucent)
        if (inPoly(u, v, PALM.map((i) => P[i]))) { cr = mix(cr, hand[0], 0.13); cg = mix(cg, hand[1], 0.13); cb = mix(cb, hand[2], 0.13); }
        // bones: glow + core
        let dmin = 1;
        for (const [i, j] of BONES) dmin = Math.min(dmin, segDist(u, v, P[i][0], P[i][1], P[j][0], P[j][1]));
        const glow = Math.exp(-((dmin * dmin) / (glowS * glowS))) * (small ? 0.5 : 0.42);
        const core = 1 - smooth(lineW / 2 - 0.004, lineW / 2 + 0.004, dmin);
        cr = mix(cr, hand[0], glow); cg = mix(cg, hand[1], glow); cb = mix(cb, hand[2], glow);
        cr = mix(cr, 255, 0); // (keep the hue)
        cr = mix(cr, hand[0], core); cg = mix(cg, hand[1], core); cb = mix(cb, hand[2], core);
        // joints and ringed fingertips
        let jd = 1, ring = 0;
        P.forEach(([px, py], n) => {
          const d = Math.hypot(u - px, v - py);
          jd = Math.min(jd, d - (TIPS.includes(n) ? dot * 1.25 : dot * 0.8));
          if (TIPS.includes(n)) ring = Math.max(ring, 1 - smooth(0.0035, 0.009, Math.abs(d - dot * 2.4)));
        });
        const dotCover = 1 - smooth(-0.003, 0.003, jd);
        const white = [255, 255, 255];
        cr = mix(cr, white[0], dotCover); cg = mix(cg, white[1], dotCover); cb = mix(cb, white[2], dotCover);
        if (!small) { cr = mix(cr, hand[0], ring * 0.8); cg = mix(cg, hand[1], ring * 0.8); cb = mix(cb, hand[2], ring * 0.8); }

        r += cr * cover; g += cg * cover; b += cb * cover; a += cover;
      }
      const i = (y * size + x) * 4;
      const n = SS * SS;
      if (a > 0) { buf[i] = Math.round(r / a); buf[i + 1] = Math.round(g / a); buf[i + 2] = Math.round(b / a); }
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

const COLORS = {
  active: [61, 220, 151],  // green
  paused: [242, 184, 75],  // amber
  locked: [239, 83, 80],   // red
  off: [150, 158, 170],    // grey
  brand: [196, 236, 250],  // ice (the app icon)
};

/** PNG for a state ('active' | 'paused' | 'locked' | 'off' | 'brand') at a given size. */
function pngFor(state, size = 32) {
  const col = COLORS[state] || COLORS.off;
  return encodePNG(size, size, drawAppIcon(size, col, state === 'brand' ? [207, 214, 222] : col));
}

/** ICO with PNG images inside (valid since Windows Vista). */
function icoFrom(pngs) {
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = 6 + 16 * pngs.length;
  const dir = [], body = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(off, 12);
    off += data.length; dir.push(e); body.push(data);
  }
  return Buffer.concat([head, ...dir, ...body]);
}

module.exports = { pngFor, icoFrom, encodePNG, drawAppIcon, COLORS };
