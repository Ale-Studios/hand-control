// HUD drawing for the camera preview: a light, "holographic" look over the dimmed camera image.
// Everything is drawn in VIEW coordinates (already mirrored if the preview is mirrored), so text is readable.

const COLORS = {
  ice: { a: '#c4ecfa', b: '#7fd0ee' },
  amber: { a: '#ffd9a0', b: '#ffab40' },
  mint: { a: '#c2f7e1', b: '#5fe0b0' },
};
const CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const TIPS = [4, 8, 12, 16, 20];
const PALM = [0, 1, 5, 9, 13, 17];
const TRAIL_MS = 650;

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const MONO = '"Cascadia Mono", Consolas, monospace';

function brackets(ctx, x0, y0, x1, y1, len) {
  ctx.beginPath();
  ctx.moveTo(x0, y0 + len); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0);
  ctx.moveTo(x1 - len, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + len);
  ctx.moveTo(x0, y1 - len); ctx.lineTo(x0, y1); ctx.lineTo(x0 + len, y1);
  ctx.moveTo(x1 - len, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - len);
  ctx.stroke();
}

export class HudRenderer {
  constructor() {
    this.trail = [];
    this.spin = 0;
    this.scan = 0;
    this.lastT = 0;
  }

  /** o: { frame, hud, S, mode, screen:{w,h}, poseName } */
  draw(ctx, W, H, o) {
    const { frame, hud, S, mode } = o;
    const col = COLORS[S.ui.hudColor] || COLORS.ice;
    const mirror = S.camera.mirror;
    const k = o.px || 1; // canvas pixels per CSS pixel: sizes below are in CSS pixels
    const X = (xn) => (mirror ? 1 - xn : xn) * W;
    const Y = (yn) => yn * H;
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.lastT || now)) / 1000);
    this.lastT = now;
    this.spin += dt * 0.9;
    const active = mode === 'active';
    const handVisible = !!(hud && hud.handVisible);

    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 0;

    const text = (s, x, y, size, color, align = 'left') => {
      ctx.font = `${size * k}px ${MONO}`;
      ctx.textAlign = align;
      ctx.fillStyle = color;
      ctx.fillText(s, x, y);
    };

    // ── zoom crop (distance modes) ──
    const roi = frame.meta && frame.meta.roi;
    if (roi && frame.meta.W && (roi.w < frame.meta.W * 0.98 || roi.h < frame.meta.H * 0.98)) {
      const xa = X(roi.x / frame.meta.W), xb = X((roi.x + roi.w) / frame.meta.W);
      ctx.strokeStyle = hexA(col.a, 0.25); ctx.lineWidth = k; ctx.setLineDash([4 * k, 6 * k]);
      ctx.strokeRect(Math.min(xa, xb), Y(roi.y / frame.meta.H), Math.abs(xb - xa), Y(roi.h / frame.meta.H));
      ctx.setLineDash([]);
    }

    // ── active area: corner brackets, faint thirds ──
    let area = null;
    if (S.ui.showArea) {
      const a = S.control.area, g = Math.max(0.2, S.control.sensitivity);
      const w = a.w / g, h = a.h / g;
      area = { x0: (a.cx - w / 2) * W, x1: (a.cx + w / 2) * W, y0: (a.cy - h / 2) * H, y1: (a.cy + h / 2) * H };
      ctx.strokeStyle = active ? 'rgba(61,220,151,.85)' : hexA(col.a, 0.5);
      ctx.lineWidth = 1.4 * k;
      brackets(ctx, area.x0, area.y0, area.x1, area.y1, Math.min(area.x1 - area.x0, area.y1 - area.y0) * 0.09);
      ctx.strokeStyle = hexA(col.a, 0.07); ctx.lineWidth = k;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        const gx = area.x0 + ((area.x1 - area.x0) * i) / 3, gy = area.y0 + ((area.y1 - area.y0) * i) / 3;
        ctx.moveTo(gx, area.y0); ctx.lineTo(gx, area.y1); ctx.moveTo(area.x0, gy); ctx.lineTo(area.x1, gy);
      }
      ctx.stroke();
      const cx = (area.x0 + area.x1) / 2, cy = (area.y0 + area.y1) / 2;
      ctx.strokeStyle = hexA(col.a, 0.3);
      ctx.beginPath(); ctx.moveTo(cx - 6 * k, cy); ctx.lineTo(cx + 6 * k, cy); ctx.moveTo(cx, cy - 6 * k); ctx.lineTo(cx, cy + 6 * k); ctx.stroke();
    }

    // ── idle: a slow scan line while no hand is seen ──
    if (!handVisible) {
      this.trail.length = 0;
      this.scan = (this.scan + dt * 0.22) % 1;
      const r = area || { x0: W * 0.2, x1: W * 0.8, y0: H * 0.15, y1: H * 0.85 };
      const y = r.y0 + (r.y1 - r.y0) * this.scan;
      const grd = ctx.createLinearGradient(r.x0, 0, r.x1, 0);
      grd.addColorStop(0, hexA(col.a, 0)); grd.addColorStop(0.5, hexA(col.a, 0.35)); grd.addColorStop(1, hexA(col.a, 0));
      ctx.strokeStyle = grd; ctx.lineWidth = 1.5 * k; ctx.shadowColor = col.b; ctx.shadowBlur = 8 * k;
      ctx.beginPath(); ctx.moveTo(r.x0, y); ctx.lineTo(r.x1, y); ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ── hands ──
    (frame.hands || []).forEach((hand, i) => {
      const main = handVisible && i === 0;
      const pts = hand.lm.map((p) => ({ x: X(p.x), y: Y(p.y) }));
      const aBone = main ? 0.95 : 0.35;

      // translucent palm
      ctx.beginPath();
      PALM.forEach((idx, n) => (n ? ctx.lineTo(pts[idx].x, pts[idx].y) : ctx.moveTo(pts[idx].x, pts[idx].y)));
      ctx.closePath();
      ctx.fillStyle = hexA(col.b, main ? 0.1 : 0.04);
      ctx.fill();

      // bones with a soft glow
      ctx.shadowColor = col.b; ctx.shadowBlur = (main ? 10 : 4) * k;
      ctx.strokeStyle = hexA(col.a, aBone); ctx.lineWidth = (main ? 1.4 : 1) * k;
      ctx.beginPath();
      for (const [p, q] of CONN) { ctx.moveTo(pts[p].x, pts[p].y); ctx.lineTo(pts[q].x, pts[q].y); }
      ctx.stroke();

      // joints (small) and fingertips (ringed)
      ctx.shadowBlur = 0;
      ctx.fillStyle = hexA(col.a, main ? 0.9 : 0.4);
      pts.forEach((p, n) => {
        if (TIPS.includes(n)) return;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.7 * k, 0, Math.PI * 2); ctx.fill();
      });
      for (const n of TIPS) {
        const p = pts[n];
        ctx.fillStyle = hexA(col.a, main ? 1 : 0.5);
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.6 * k, 0, Math.PI * 2); ctx.fill();
        if (main) {
          ctx.strokeStyle = hexA(col.a, 0.6); ctx.lineWidth = k;
          ctx.beginPath(); ctx.arc(p.x, p.y, 6.5 * k, 0, Math.PI * 2); ctx.stroke();
        }
      }

      if (!main) return;

      // tracking box with readouts
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      const pad = 0.12 * Math.max(x1 - x0, y1 - y0) + 12 * k;
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      ctx.strokeStyle = hexA(col.a, 0.8); ctx.lineWidth = 1.2 * k;
      brackets(ctx, x0, y0, x1, y1, Math.min(x1 - x0, y1 - y0) * 0.16);
      const lab = (hand.label && hand.label !== 'unknown' ? hand.label : 'hand').toUpperCase();
      text(`HAND 01 · ${lab}`, x0, y0 - 8 * k, 11, hexA(col.a, 0.95));
      const pose = String(o.poseName || '').toUpperCase();
      text(pose, x0, y1 + 16 * k, 11, hexA(col.a, 0.95));
      if (hud.screen && o.screen) {
        text(`X ${Math.round(hud.screen.x * o.screen.w)}  Y ${Math.round(hud.screen.y * o.screen.h)}`, x0, y1 + 30 * k, 10, hexA(col.a, 0.55));
      }

      // pinch gauge: thumb ↔ index (and thumb ↔ middle for the right click)
      const m = hud.measures;
      const gauge = (a, b, dist, on) => {
        if (dist == null || dist > 0.9) return;
        const mid = { x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2 };
        ctx.strokeStyle = on ? col.a : hexA(col.a, 0.4); ctx.lineWidth = (on ? 1.8 : 1) * k;
        ctx.setLineDash(on ? [] : [3 * k, 4 * k]);
        ctx.shadowColor = col.b; ctx.shadowBlur = on ? 10 * k : 0;
        ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke();
        ctx.setLineDash([]); ctx.shadowBlur = 0;
        if (on) { ctx.beginPath(); ctx.arc(mid.x, mid.y, 9 * k, 0, Math.PI * 2); ctx.stroke(); }
        text(dist.toFixed(2), mid.x + 12 * k, mid.y - 8 * k, 10, hexA(col.a, on ? 1 : 0.6));
      };
      if (m) {
        gauge(4, 8, m.pinchIndex, hud.pose === 'pinch');
        if (hud.pose === 'rclick' || m.pinchMiddle < 0.45) gauge(4, 12, m.pinchMiddle, hud.pose === 'rclick');
      }

      // scroll chevrons
      if (hud.pose === 'scroll') {
        const cx = (x0 + x1) / 2;
        ctx.strokeStyle = hexA(col.a, 0.85); ctx.lineWidth = 1.6 * k;
        for (const [yy, d] of [[y0 - 18 * k, -1], [y1 + 28 * k, 1]]) {
          ctx.beginPath(); ctx.moveTo(cx - 9 * k, yy - d * 5 * k); ctx.lineTo(cx, yy + d * 4 * k); ctx.lineTo(cx + 9 * k, yy - d * 5 * k); ctx.stroke();
        }
      }
    });

    // ── pointer: trail + reticle ──
    if (handVisible && hud.anchor) {
      const px = hud.anchor.u * W, py = hud.anchor.v * H;
      if (S.ui.trail) {
        this.trail.push({ x: px, y: py, t: now });
        while (this.trail.length && now - this.trail[0].t > TRAIL_MS) this.trail.shift();
        for (let n = 1; n < this.trail.length; n++) {
          const age = (now - this.trail[n].t) / TRAIL_MS;
          ctx.strokeStyle = hexA(col.b, Math.max(0, 0.75 * (1 - age)));
          ctx.lineWidth = Math.max(0.6, (1 - age) * 3.2) * k;
          ctx.beginPath(); ctx.moveTo(this.trail[n - 1].x, this.trail[n - 1].y); ctx.lineTo(this.trail[n].x, this.trail[n].y); ctx.stroke();
        }
      }
      const c = hud.pressed ? '#ff7a75' : active ? '#3ddc97' : col.a;
      const r = (hud.pressed ? 9 : 14) * k;
      ctx.shadowColor = c; ctx.shadowBlur = 10 * k;
      ctx.strokeStyle = c; ctx.lineWidth = 1.4 * k;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(px + dx * (r + 3 * k), py + dy * (r + 3 * k)); ctx.lineTo(px + dx * (r + 9 * k), py + dy * (r + 9 * k));
      }
      ctx.stroke();
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(px, py, 2.2 * k, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}
