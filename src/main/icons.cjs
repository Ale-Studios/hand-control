// Draws the icons on the fly (no image files to carry around): a disc in the status colour
// with a white crosshair. Writes PNGs "by hand" with zlib.
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

/** Coloured disc + white crosshair, with a soft edge (4x anti-aliasing). */
function drawIcon(size, [r, g, b]) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2, R = size * 0.46;
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0, ink = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        const d = Math.hypot(px - cx, py - cy);
        if (d <= R) {
          cov++;
          const ring = Math.abs(d - R * 0.58) < R * 0.07;
          const dot = d < R * 0.17;
          const cross = (Math.abs(px - cx) < R * 0.05 || Math.abs(py - cy) < R * 0.05) && d > R * 0.58 - R * 0.05 && d < R * 0.9;
          if (ring || dot || cross) ink++;
        }
      }
      const a = cov / (SS * SS);
      const w = cov ? ink / cov : 0;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r * (1 - w) + 255 * w);
      buf[i + 1] = Math.round(g * (1 - w) + 255 * w);
      buf[i + 2] = Math.round(b * (1 - w) + 255 * w);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return buf;
}

const COLORS = {
  active: [61, 220, 151],  // green
  paused: [242, 184, 75],  // amber
  locked: [239, 83, 80],   // red
  off: [107, 115, 128],    // grey
  brand: [62, 68, 77],     // anthracite (app icon)
};

function pngFor(state, size = 32) { return encodePNG(size, size, drawIcon(size, COLORS[state] || COLORS.off)); }

/** ICO containing a PNG (a valid format since Windows Vista). */
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

module.exports = { pngFor, icoFrom, encodePNG, drawIcon, COLORS };
