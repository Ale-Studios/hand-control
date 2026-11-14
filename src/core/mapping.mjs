// Dalla posizione della mano nell'immagine (0..1, già "a specchio") alla
// posizione sullo schermo (0..1).
//
// "area" è il rettangolo della telecamera dove muovi la mano: {cx, cy, w, h}
// (centro e dimensioni, in frazioni dell'immagine). Dentro quel rettangolo la
// mano copre tutto lo schermo; fuori il cursore resta sul bordo.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function mapToScreen(u, v, area, gain = 1, snap = 0.02) {
  const w = Math.max(0.05, area.w / Math.max(0.2, gain));
  const h = Math.max(0.05, area.h / Math.max(0.2, gain));
  let sx = (u - (area.cx - w / 2)) / w;
  let sy = (v - (area.cy - h / 2)) / h;
  // "Calamita" ai bordi: per arrivare negli angoli non serve essere precisi.
  const snapTo = (p) => (p < snap ? 0 : p > 1 - snap ? 1 : p);
  sx = snapTo(clamp01(sx));
  sy = snapTo(clamp01(sy));
  return { x: sx, y: sy };
}

/** Area dai due angoli misurati in calibrazione (alto-sinistra, basso-destra), con un po' di margine. */
export function areaFromCorners(tl, br, margin = 0.06) {
  const x0 = Math.min(tl.u, br.u), x1 = Math.max(tl.u, br.u);
  const y0 = Math.min(tl.v, br.v), y1 = Math.max(tl.v, br.v);
  const w = Math.min(1, Math.max(0.08, (x1 - x0) * (1 + 2 * margin)));
  const h = Math.min(1, Math.max(0.08, (y1 - y0) * (1 + 2 * margin)));
  return {
    cx: Math.min(1 - w / 2, Math.max(w / 2, (x0 + x1) / 2)),
    cy: Math.min(1 - h / 2, Math.max(h / 2, (y0 + y1) / 2)),
    w, h,
  };
}
