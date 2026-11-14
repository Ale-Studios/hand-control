// "One Euro" filter: removes jitter when the hand is still, but lets fast movements
// through with almost no lag. It is the standard for hand/eye-controlled cursors
// (Casiez et al., 2012).
//
//  minCutoff  → how much it smooths slow movements (Hz, lower = steadier)
//  beta       → how much it "opens up" when you move fast (higher = less lag)

function alphaFor(cutoffHz, dtSec) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  configure({ minCutoff, beta }) {
    if (minCutoff != null) this.minCutoff = minCutoff;
    if (beta != null) this.beta = beta;
  }
  /** x: new value, tMs: time in milliseconds. Returns the filtered value. */
  filter(x, tMs) {
    if (this.x === null || this.t === null) {
      this.x = x; this.dx = 0; this.t = tMs;
      return x;
    }
    // minimum dt of 1 ms (avoids division by zero); a large dt = no memory.
    const dt = Math.max((tMs - this.t) / 1000, 0.001);
    const rawDx = (x - this.x) / dt;
    const aD = alphaFor(this.dCutoff, dt);
    this.dx = this.dx + aD * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = alphaFor(cutoff, dt);
    this.x = this.x + a * (x - this.x);
    this.t = tMs;
    return this.x;
  }
}

/** The UI's 0..1 "smoothing" knob → filter parameters (in screen pixels). */
export function smoothingToParams(smoothing) {
  const s = Math.min(1, Math.max(0, smoothing));
  return {
    minCutoff: 4.0 * Math.pow(0.1, s), // 0 → 4 Hz (responsive), 1 → 0.4 Hz (very steady)
    beta: 0.02,
  };
}

/** Plain median (used by the calibration). */
export function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
