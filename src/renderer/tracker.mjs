// Camera + MediaPipe. Everything is local: the engine and the model are files inside the app.
// No image ever leaves this file: frames are looked at and immediately forgotten.
//
// To work "at a distance" the hand must stay big enough for the model.
// The trick ('follow' mode): we ask the camera for 1080p and give the model only a crop
// around the hand, which follows the hand as it moves.

const VISION = 'hc://app/vendor/vision_bundle.mjs';
const WASM = 'hc://app/vendor/wasm';
const MODEL = 'hc://app/models/hand_landmarker.task';

const MAX_SIDE = 640; // the crop is scaled down to this size: enough for the model, light for the GPU

// Crop that follows the hand.
class RoiFollower {
  constructor(minSide) {
    this.minSide = minSide; // fraction of the frame height
    this.cx = null; this.cy = null; this.side = null;
    this.miss = 0;
    this.search = 0;
  }
  pick(W, H) {
    if (this.cx == null || this.miss >= 3) {
      // No hand: search in turns (whole frame, then zoomed centre, then the sides)
      const k = this.search++ % 4;
      if (k === 0) return { x: 0, y: 0, w: W, h: H };
      const w = Math.round(W * 0.5), h = Math.round(H * 0.5);
      const spots = [null, [(W - w) / 2, (H - h) / 2], [W * 0.05, (H - h) / 2], [W * 0.95 - w, (H - h) / 2]];
      return { x: Math.round(spots[k][0]), y: Math.round(spots[k][1]), w, h };
    }
    const side = Math.min(H, Math.max(this.minSide * H, this.side));
    const x = Math.min(W - side, Math.max(0, this.cx * W - side / 2));
    const y = Math.min(H - side, Math.max(0, this.cy * H - side / 2));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(side), h: Math.round(side) };
  }
  seen(lm, W, H) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of lm) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    const span = Math.max((x1 - x0) * W, (y1 - y0) * H);
    this.cx = this.cx == null || this.miss >= 3 ? c.x : this.cx + (c.x - this.cx) * 0.6;
    this.cy = this.cy == null || this.miss >= 3 ? c.y : this.cy + (c.y - this.cy) * 0.6;
    this.side = this.side == null || this.miss >= 3 ? span * 2.8 : this.side + (span * 2.8 - this.side) * 0.3;
    this.miss = 0;
  }
  lost() { this.miss++; }
}

export class Tracker {
  /**
   * @param video  <video> already in the page (also used for the preview)
   * @param hooks  { onFrame(frame), onStatus(state, msg) }
   */
  constructor(video, hooks) {
    this.video = video;
    this.hooks = hooks;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.landmarker = null;
    this.stream = null;
    this.vfc = null;
    this.running = false;
    this.mpModule = null;
    this.follower = null;
    this.busy = false;
    this.lastRoi = { x: 0, y: 0, w: 1, h: 1 };
    this.delegate = '?';
  }

  static async listCameras() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch { return []; }
  }

  async start({ deviceId, preset, numHands = 1, delegate = 'auto' }) {
    await this.stop();
    this.preset = preset;
    this.numHands = numHands;
    this.wantDelegate = String(delegate || 'auto').toUpperCase();
    this.hooks.onStatus('starting', 'Turning the camera on…');
    const video = {
      width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: 30, max: 30 },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      this.hooks.onStatus('error', 'Cannot open the camera (' + (e && e.name || 'error') + '). Is another app using it, or is permission denied?');
      return false;
    }
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch { /* it starts anyway */ }
    this.stream.getVideoTracks()[0].addEventListener('ended', () => this.hooks.onStatus('error', 'The camera was disconnected.'));

    this.hooks.onStatus('loading', 'Loading the recognition engine (local)…');
    try {
      await this._createLandmarker();
    } catch (e) {
      console.error(e);
      this.hooks.onStatus('error', 'The recognition engine failed to start: ' + (e && e.message || e));
      await this.stop();
      return false;
    }
    this.follower = preset.roi === 'follow' ? new RoiFollower(preset.minSide) : null;
    this.running = true;
    this.hooks.onStatus('on', `Camera on (${this.video.videoWidth}×${this.video.videoHeight}, ${this.delegate})`);
    this._schedule();
    return true;
  }

  async _createLandmarker() {
    if (!this.mpModule) this.mpModule = await import(VISION);
    const { FilesetResolver, HandLandmarker } = this.mpModule;
    const vision = await FilesetResolver.forVisionTasks(WASM);
    const follow = this.preset.roi === 'follow';
    const make = (delegate) => HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      numHands: this.numHands,
      runningMode: follow ? 'IMAGE' : 'VIDEO',
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    if (this.wantDelegate === 'CPU') { this.landmarker = await make('CPU'); this.delegate = 'CPU'; return; }
    try { this.landmarker = await make('GPU'); this.delegate = 'GPU'; }
    catch (e) { console.warn('GPU not available, using the CPU', e); this.landmarker = await make('CPU'); this.delegate = 'CPU'; }
  }

  _schedule() {
    if (!this.running) return;
    this.vfc = this.video.requestVideoFrameCallback((now, meta) => {
      this._frame(now, meta);
      this._schedule();
    });
  }

  _frame(now, meta) {
    if (this.busy || !this.landmarker) return;
    const v = this.video;
    const W = v.videoWidth, H = v.videoHeight;
    if (!W || !H) return;
    this.busy = true;
    const tStart = performance.now();
    try {
      const roi = this.follower ? this.follower.pick(W, H) : { x: 0, y: 0, w: W, h: H };
      this.lastRoi = roi;
      const s = Math.min(1, MAX_SIDE / Math.max(roi.w, roi.h));
      const cw = Math.max(32, Math.round(roi.w * s)), ch = Math.max(32, Math.round(roi.h * s));
      if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
      this.ctx.drawImage(v, roi.x, roi.y, roi.w, roi.h, 0, 0, cw, ch);

      const res = this.follower
        ? this.landmarker.detect(this.canvas)
        : this.landmarker.detectForVideo(this.canvas, tStart);
      const tDone = performance.now();

      const hands = [];
      const lms = (res && res.landmarks) || [];
      for (let i = 0; i < lms.length; i++) {
        const lm = lms[i].map((p) => ({ x: (roi.x + p.x * roi.w) / W, y: (roi.y + p.y * roi.h) / H, z: p.z }));
        const cat = res.handedness && res.handedness[i] && res.handedness[i][0] && res.handedness[i][0].categoryName;
        // MediaPipe assumes a mirrored image; ours is not, so the label has to be swapped.
        const label = cat === 'Left' ? 'right' : cat === 'Right' ? 'left' : 'unknown';
        hands.push({ lm, wl: res.worldLandmarks && res.worldLandmarks[i], label, score: res.handedness && res.handedness[i] && res.handedness[i][0] && res.handedness[i][0].score });
      }
      if (this.follower) { if (hands.length) this.follower.seen(hands[0].lm, W, H); else this.follower.lost(); }

      const origin = performance.timeOrigin;
      const tCap = meta && typeof meta.captureTime === 'number' ? meta.captureTime : (meta && meta.receiveTime) || now;
      this.hooks.onFrame({
        t: tCap,
        hands,
        meta: {
          tCapEpoch: origin + tCap,        // when the camera took the picture (ms, epoch)
          tStartEpoch: origin + tStart,    // when we started processing
          tDoneEpoch: origin + tDone,      // when the model finished
          inferMs: tDone - tStart,
          roi, W, H,
          captureLagMs: tStart - tCap,     // camera → app delay
        },
      });
    } catch (e) {
      console.error('frame', e);
    } finally {
      this.busy = false;
    }
  }

  async stop() {
    this.running = false;
    if (this.vfc != null && this.video.cancelVideoFrameCallback) { try { this.video.cancelVideoFrameCallback(this.vfc); } catch { /* ok */ } }
    this.vfc = null;
    if (this.landmarker) { try { this.landmarker.close(); } catch { /* ok */ } this.landmarker = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.video.srcObject = null;
  }
}
