// Hand measurements. We use MediaPipe's "world" points (in metres, independent of the
// distance from the camera): so the same gesture works at 50 cm and at 3 m.

// Indices of the 21 MediaPipe points
export const L = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_TIP: 20,
};

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

/** Hand size: wrist → middle knuckle (about 8-9 cm on an adult hand). */
export function handSize(w) {
  return dist(w[L.WRIST], w[L.MIDDLE_MCP]) || 1e-6;
}

/** How "open" a finger is: tip-to-wrist distance / knuckle-to-wrist distance. ~2.0 extended, ~0.8 curled into a fist. */
export function fingerRatio(w, tip, mcp) {
  return dist(w[tip], w[L.WRIST]) / (dist(w[mcp], w[L.WRIST]) || 1e-6);
}

export const FINGERS = {
  index: [L.INDEX_TIP, L.INDEX_MCP],
  middle: [L.MIDDLE_TIP, L.MIDDLE_MCP],
  ring: [L.RING_TIP, L.RING_MCP],
  pinky: [L.PINKY_TIP, L.PINKY_MCP],
};

/** Raw measurements of one frame (no memory: the hysteresis lives in the engine). */
export function measure(w) {
  const hs = handSize(w);
  return {
    hs,
    ratio: {
      index: fingerRatio(w, ...FINGERS.index),
      middle: fingerRatio(w, ...FINGERS.middle),
      ring: fingerRatio(w, ...FINGERS.ring),
      pinky: fingerRatio(w, ...FINGERS.pinky),
    },
    pinchIndex: dist(w[L.THUMB_TIP], w[L.INDEX_TIP]) / hs,
    pinchMiddle: dist(w[L.THUMB_TIP], w[L.MIDDLE_TIP]) / hs,
  };
}

/**
 * If MediaPipe does not give the "world" points, we derive them from the image by correcting
 * the aspect ratio. Less precise, but the gestures still work.
 */
export function worldFromImage(lm, aspect = 16 / 9) {
  return lm.map((p) => ({ x: p.x * aspect, y: p.y, z: (p.z || 0) * aspect }));
}
