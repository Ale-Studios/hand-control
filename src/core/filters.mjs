// Filtro "One Euro": toglie il tremolio quando la mano è ferma, ma lascia
// passare i movimenti veloci quasi senza ritardo. È lo standard per i cursori
// controllati con mano/occhi (Casiez et al., 2012).
//
//  minCutoff  → quanto "liscia" quando ti muovi piano (Hz, più basso = più fermo)
//  beta       → quanto si "sblocca" quando ti muovi veloce (più alto = meno ritardo)

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
  /** x: valore nuovo, tMs: istante in millisecondi. Ritorna il valore filtrato. */
  filter(x, tMs) {
    if (this.x === null || this.t === null) {
      this.x = x; this.dx = 0; this.t = tMs;
      return x;
    }
    // dt minimo 1 ms (evita divisioni per zero); dt grande = nessuna memoria.
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

/** Il manopola "smorzamento" 0..1 della UI → parametri del filtro (in pixel di schermo). */
export function smoothingToParams(smoothing) {
  const s = Math.min(1, Math.max(0, smoothing));
  return {
    minCutoff: 4.0 * Math.pow(0.1, s), // 0 → 4 Hz (reattivo), 1 → 0.4 Hz (molto fermo)
    beta: 0.02,
  };
}

/** Mediana semplice (usata dalla calibrazione). */
export function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
