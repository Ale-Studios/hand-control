// From the hand position in the image (0..1, already "mirrored") to the screen position (0..1).
//
// "area" is the rectangle of the camera frame where you move your hand: {cx, cy, w, h}
// (centre and size, as fractions of the image). Inside that rectangle the hand covers the
// whole screen; outside it the cursor stays on the edge.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function mapToScreen(u, v, area, gain = 1, snap = 0.02) {
  const w = Math.max(0.05, area.w / Math.max(0.2, gain));
  const h = Math.max(0.05, area.h / Math.max(0.2, gain));
  let sx = (u - (area.cx - w / 2)) / w;
  let sy = (v - (area.cy - h / 2)) / h;
  // Edge "magnet": reaching the corners does not need to be precise.
  const snapTo = (p) => (p < snap ? 0 : p > 1 - snap ? 1 : p);
  sx = snapTo(clamp01(sx));
  sy = snapTo(clamp01(sy));
  return { x: sx, y: sy };
}

/** Smallest active area allowed (fraction of the frame). Smaller = the camera noise gets magnified too much. */
export const MIN_AREA = 0.28;

/** Enlarges an area that is too small around its centre (keeps it inside the frame). */
export function enforceMinArea(a, min = MIN_AREA) {
  const w = Math.min(1, Math.max(min, a.w));
  const h = Math.min(1, Math.max(min, a.h));
  return {
    cx: Math.min(1 - w / 2, Math.max(w / 2, a.cx)),
    cy: Math.min(1 - h / 2, Math.max(h / 2, a.cy)),
    w, h,
  };
}

/** Area from the two corners measured in calibration (top-left, bottom-right), with a little margin. */
export function areaFromCorners(tl, br, margin = 0.06) {
  const x0 = Math.min(tl.u, br.u), x1 = Math.max(tl.u, br.u);
  const y0 = Math.min(tl.v, br.v), y1 = Math.max(tl.v, br.v);
  const w = Math.min(1, (x1 - x0) * (1 + 2 * margin));
  const h = Math.min(1, (y1 - y0) * (1 + 2 * margin));
  return enforceMinArea({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h });
}
