// Misure sulla mano. Usiamo i punti "world" di MediaPipe (in metri, indipendenti
// dalla distanza dalla telecamera): così lo stesso gesto vale a 50 cm e a 3 m.

// Indici dei 21 punti MediaPipe
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

/** Grandezza della mano: polso → nocca del medio (circa 8-9 cm in una mano adulta). */
export function handSize(w) {
  return dist(w[L.WRIST], w[L.MIDDLE_MCP]) || 1e-6;
}

/** Quanto è "aperto" un dito: distanza punta-polso / distanza nocca-polso. ~2.0 teso, ~0.8 chiuso a pugno. */
export function fingerRatio(w, tip, mcp) {
  return dist(w[tip], w[L.WRIST]) / (dist(w[mcp], w[L.WRIST]) || 1e-6);
}

export const FINGERS = {
  index: [L.INDEX_TIP, L.INDEX_MCP],
  middle: [L.MIDDLE_TIP, L.MIDDLE_MCP],
  ring: [L.RING_TIP, L.RING_MCP],
  pinky: [L.PINKY_TIP, L.PINKY_MCP],
};

/** Misure grezze di un fotogramma (nessuna memoria: l'isteresi sta nell'engine). */
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
 * Se MediaPipe non dà i punti "world", li ricaviamo dall'immagine correggendo le proporzioni.
 * Meno precisi, ma i gesti funzionano comunque.
 */
export function worldFromImage(lm, aspect = 16 / 9) {
  return lm.map((p) => ({ x: p.x * aspect, y: p.y, z: (p.z || 0) * aspect }));
}
