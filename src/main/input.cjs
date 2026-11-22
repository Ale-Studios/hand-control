// Real mouse and keyboard on Windows, through the system function SendInput
// (user32.dll) called directly with `koffi`: no external process, no PowerShell,
// no on-the-fly compilation. Each move costs ~0.05 ms.
//
// Windows limit: a normal program CANNOT "touch" windows started as Administrator
// (UIPI). For those, Hand Control must also be started as Administrator.
// This is documented in the README.

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  u: koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT }),
});
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });

const SendInput = user32.func('unsigned int SendInput(unsigned int cInputs, INPUT *pInputs, int cbSize)');
const GetCursorPos = user32.func('bool GetCursorPos(_Out_ POINT *p)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int n)');
const GetAsyncKeyState = user32.func('short GetAsyncKeyState(int vKey)');
const GetDoubleClickTime = user32.func('unsigned int GetDoubleClickTime()');
// hide / restore the Windows arrow (see Input.hideSystemCursor)
const CreateCursor = user32.func('void *CreateCursor(void *hInst, int xHot, int yHot, int w, int h, const void *andMask, const void *xorMask)');
const SetSystemCursor = user32.func('bool SetSystemCursor(void *hcur, unsigned int id)');
const SystemParametersInfoW = user32.func('bool SystemParametersInfoW(unsigned int action, unsigned int param, void *pv, unsigned int ini)');
const SPI_SETCURSORS = 0x0057;
// windows: which one is under the cursor (walking the z-order, top first)
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GetTopWindow = user32.func('void *GetTopWindow(void *h)');
const GetWindow = user32.func('void *GetWindow(void *h, unsigned int cmd)');
const IsWindowVisible = user32.func('bool IsWindowVisible(void *h)');
const IsIconic = user32.func('bool IsIconic(void *h)');
const IsZoomed = user32.func('bool IsZoomed(void *h)');
const GetWindowRect = user32.func('bool GetWindowRect(void *h, _Out_ RECT *r)');
const GetWindowLongPtrW = user32.func('intptr_t GetWindowLongPtrW(void *h, int i)');
const GetClassNameW = user32.func('int GetClassNameW(void *h, _Out_ uint16_t *buf, int n)');
const GetWindowTextW = user32.func('int GetWindowTextW(void *h, _Out_ uint16_t *buf, int n)');
const PostMessageW = user32.func('bool PostMessageW(void *h, unsigned int m, uintptr_t w, intptr_t l)');
const ShowWindow = user32.func('bool ShowWindow(void *h, int cmd)');
const SetWindowPos = user32.func('bool SetWindowPos(void *h, intptr_t after, int x, int y, int cx, int cy, unsigned int flags)');
const DwmGetWindowAttribute = koffi.load('dwmapi.dll').func('int DwmGetWindowAttribute(void *h, unsigned int attr, _Out_ int *v, unsigned int cb)');
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']); // desktop and taskbar: never touched
const wtext = (fn, h) => { const b = new Uint16Array(256); const n = fn(h, b, 256); return n > 0 ? Buffer.from(b.buffer, 0, n * 2).toString('utf16le') : ''; };
// arrow, I-beam, wait, cross, up, the four resize cursors, move, "no", hand, "working in background", help
const SYSTEM_CURSOR_IDS = [32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651];

const MOUSEEVENTF = {
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, WHEEL: 0x0800, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000,
};
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const SIZE = koffi.sizeof(INPUT);
const MAGIC = 0x48434f4e; // "HCON": signature of our own moves (dwExtraInfo)

// ── keyboard: key names → virtual-key codes ──
const VK = {
  ctrl: 0x11, control: 0x11, alt: 0x12, menu: 0x12, shift: 0x10, cmd: 0x5b, win: 0x5b, meta: 0x5b, super: 0x5b,
  tab: 0x09, enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe,
};
for (let i = 1; i <= 12; i++) VK['f' + i] = 0x6f + i;
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i;
const MEDIA = { playpause: 0xb3, next: 0xb0, prev: 0xb1, previous: 0xb1, stop: 0xb2, volup: 0xaf, voldown: 0xae, mute: 0xad };
const EXTENDED = new Set([0x25, 0x26, 0x27, 0x28, 0x2e, 0x24, 0x23, 0x21, 0x22, 0x5b]);

/** Turns a text like "<ctrl>+<alt>+tab" or "ctrl+shift+s" into key codes; null if any key is unknown. */
function parseCombo(text) {
  const keys = String(text).split('+').map((t) => t.trim().replace(/^<|>$/g, '').toLowerCase()).filter(Boolean);
  if (!keys.length || keys.length > 5) return null;
  const vks = keys.map((k) => VK[k]);
  return vks.every((v) => v) ? vks : null;
}

function kbd(vk, down) {
  const flags = (down ? 0 : KEYEVENTF_KEYUP) | (EXTENDED.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
  return { type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: MAGIC } } };
}
function wheelInput(delta) {
  return { type: 0, u: { mi: { dx: 0, dy: 0, mouseData: delta >>> 0, dwFlags: MOUSEEVENTF.WHEEL, time: 0, dwExtraInfo: MAGIC } } };
}

function sendMouse(flags, data = 0, dx = 0, dy = 0) {
  return SendInput(1, [{ type: 0, u: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: MAGIC } } }], SIZE);
}

class Input {
  constructor() {
    this.buttons = new Set();   // mouse buttons that we pressed ourselves
    this.winMove = null;        // the window being moved by a closed fist
    this.keysDown = new Set();  // keyboard keys that we pressed ourselves (always released)
    this.screen = null;         // rectangle (in physical pixels) of the target screen
    this.lastPos = null;        // where we last put the cursor
    this.suspendUntil = 0;      // if the user uses the physical mouse, we stop until this instant
    this.realMouseWins = true;
    this.onRealMouse = null;
  }

  /** Target screen rectangle in physical pixels {x,y,w,h}. */
  setScreenRect(r) { this.screen = r; }

  /**
   * Hides the Windows arrow by swapping the system cursors for a fully transparent one (the on-screen hand takes its place).
   * It is ALWAYS undone by showSystemCursor(): Windows reloads the user's own cursor scheme (SPI_SETCURSORS). Callers restore it
   * whenever control is not active, on quit, and once at startup in case a previous run was killed while the arrow was hidden.
   */
  hideSystemCursor() {
    if (this.cursorHidden) return true;
    try {
      const andMask = Buffer.alloc(128, 0xff); // 32×32 mono: AND = 1, XOR = 0 → every pixel stays as the background
      const xorMask = Buffer.alloc(128, 0x00);
      for (const id of SYSTEM_CURSOR_IDS) {
        const h = CreateCursor(null, 0, 0, 32, 32, andMask, xorMask);
        if (h) SetSystemCursor(h, id); // Windows takes ownership of the cursor handle
      }
      this.cursorHidden = true;
      return true;
    } catch { this.showSystemCursor(); return false; }
  }

  showSystemCursor() {
    try { SystemParametersInfoW(SPI_SETCURSORS, 0, null, 0); } catch { /* nothing else to do */ }
    this.cursorHidden = false;
  }

  /**
   * The normal window under the cursor, or null. Windows that must not count are skipped: click-through layers (the hand drawn
   * on screen), tool and no-activate windows, hidden / minimised / cloaked ones. The desktop and the taskbar are never returned.
   */
  windowAtCursor() {
    const c = this.cursor();
    let h = GetTopWindow(null);
    for (let i = 0; h && i < 500; i++, h = GetWindow(h, 2)) {
      if (!IsWindowVisible(h) || IsIconic(h)) continue;
      const ex = Number(GetWindowLongPtrW(h, -20));
      if (ex & (0x20 | 0x80 | 0x08000000)) continue;          // TRANSPARENT | TOOLWINDOW | NOACTIVATE
      const cloaked = [0];
      if (DwmGetWindowAttribute(h, 14, cloaked, 4) === 0 && cloaked[0]) continue; // on another virtual desktop
      const r = {};
      if (!GetWindowRect(h, r) || c.x < r.left || c.x >= r.right || c.y < r.top || c.y >= r.bottom) continue;
      const cls = wtext(GetClassNameW, h);
      if (SHELL_CLASSES.has(cls)) return null;
      return { h, title: wtext(GetWindowTextW, h), cls };
    }
    return null;
  }

  /** 'minimize' | 'maximize' (toggles with restore) for the window under the cursor. Returns its title, or null if there is none. */
  windowAction(what) {
    const w = this.windowAtCursor();
    if (!w) return null;
    const sc = what === 'minimize' ? 0xF020 : (IsZoomed(w.h) ? 0xF120 : 0xF030); // SC_MINIMIZE | SC_RESTORE | SC_MAXIMIZE
    PostMessageW(w.h, 0x0112, sc, 0);                         // WM_SYSCOMMAND, asynchronous: a hung window cannot block us
    return w.title || w.cls;
  }

  /** Puts a window (native handle Buffer from Electron) at the BOTTOM of the z-order, under every other app, without activating it. */
  sendToBack(handleBuf) {
    const hwnd = koffi.decode(handleBuf, 'void *'); // the buffer holds the HWND value
    return SetWindowPos(hwnd, 1 /* HWND_BOTTOM */, 0, 0, 0, 0, 0x0213 /* NOSIZE|NOMOVE|NOACTIVATE|NOOWNERZORDER */);
  }

  /**
   * Closed-fist grab: starts moving the WHOLE window under the cursor, from wherever the cursor is on it (like dragging its
   * title bar; no mouse button is pressed, so no text gets selected). A maximised window is restored first, as Windows does.
   * skip = handle (BigInt) of a window that must not be grabbed (this app's own window while it is the maximised backdrop).
   * Returns 'moving', 'skip' (that window: do nothing) or null (no window here: the caller falls back to a normal mouse drag).
   */
  beginWindowMove(skip = null) {
    const w = this.windowAtCursor();
    if (!w) return null;
    if (skip != null && BigInt(koffi.address(w.h)) === BigInt(skip)) return 'skip';
    let c = this.cursor();
    const r = {};
    if (IsZoomed(w.h)) {
      GetWindowRect(w.h, r);
      const fx = (c.x - r.left) / Math.max(1, r.right - r.left);
      ShowWindow(w.h, 9 /* SW_RESTORE */);
      const n = {}; GetWindowRect(w.h, n);
      const ww = n.right - n.left;
      // keep the cursor at the same place across the width, just below the top edge
      SetWindowPos(w.h, 0, Math.round(c.x - fx * ww), c.y - 16, 0, 0, 0x0015 /* NOSIZE|NOZORDER|NOACTIVATE */);
    }
    GetWindowRect(w.h, r);
    SetWindowPos(w.h, 0 /* HWND_TOP */, 0, 0, 0, 0, 0x0013 /* NOSIZE|NOMOVE|NOACTIVATE: bring it to the front */);
    this.winMove = { h: w.h, x: r.left, y: r.top, c0: c, title: w.title || w.cls };
    return 'moving';
  }

  /** Called after each cursor move while a window is grabbed: the window follows the cursor. */
  moveGrabbedWindow() {
    const g = this.winMove;
    if (!g) return false;
    const c = this.cursor();
    return SetWindowPos(g.h, 0, g.x + c.x - g.c0.x, g.y + c.y - g.c0.y, 0, 0, 0x0015 /* NOSIZE|NOZORDER|NOACTIVATE */);
  }

  endWindowMove() { const was = !!this.winMove; this.winMove = null; return was; }

  /** true while the physical mouse has been used recently (control gives way, the arrow must be visible again). */
  suspended(now = Date.now()) { return now < this.suspendUntil; }

  virtual() {
    return {
      x: GetSystemMetrics(76), y: GetSystemMetrics(77), w: GetSystemMetrics(78), h: GetSystemMetrics(79),
    };
  }

  cursor() {
    const p = {};
    GetCursorPos(p);
    return { x: p.x, y: p.y };
  }

  /** The REAL state of a key in Windows (1 = left, 2 = right): for tests and checks. */
  isDown(vk) { return (GetAsyncKeyState(vk) & 0x8000) !== 0; }
  doubleClickInfo() { return { ms: GetDoubleClickTime(), px: GetSystemMetrics(36), py: GetSystemMetrics(37) }; }

  /** Has a person moved the physical mouse since our last move? */
  _humanMovedMouse() {
    if (!this.realMouseWins || !this.lastPos) return false;
    const c = this.cursor();
    return Math.hypot(c.x - this.lastPos.x, c.y - this.lastPos.y) > 25;
  }

  _blocked(now) {
    if (now < this.suspendUntil) return true;
    if (this._humanMovedMouse()) {
      this.suspendUntil = now + 1500;
      this.lastPos = null;
      this.releaseAll();
      if (this.onRealMouse) this.onRealMouse();
      return true;
    }
    return false;
  }

  /** Moves the cursor: nx, ny in 0..1 on the target screen. */
  moveNorm(nx, ny, now = Date.now()) {
    if (!this.screen) return false;
    if (this._blocked(now)) return false;
    const px = Math.round(this.screen.x + Math.min(1, Math.max(0, nx)) * (this.screen.w - 1));
    const py = Math.round(this.screen.y + Math.min(1, Math.max(0, ny)) * (this.screen.h - 1));
    const v = this.virtual();
    const ax = Math.round(((px - v.x) * 65535) / Math.max(1, v.w - 1));
    const ay = Math.round(((py - v.y) * 65535) / Math.max(1, v.h - 1));
    sendMouse(MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK, 0, ax, ay);
    this.lastPos = { x: px, y: py };
    return true;
  }

  button(name, down, now = Date.now()) {
    const map = {
      left: [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP],
      right: [MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP],
      middle: [MOUSEEVENTF.MIDDLEDOWN, MOUSEEVENTF.MIDDLEUP],
    }[name];
    if (!map) return false;
    if (down) {
      if (this._blocked(now)) return false;
      sendMouse(map[0]);
      this.buttons.add(name);
    } else {
      // Releasing is ALWAYS allowed (never leave a button stuck).
      if (this.buttons.has(name)) { sendMouse(map[1]); this.buttons.delete(name); }
    }
    return true;
  }

  click(name, now = Date.now()) {
    if (this._blocked(now)) return false;
    this.button(name, true, now);
    this.button(name, false, now);
    return true;
  }

  wheel(delta, now = Date.now()) {
    if (this._blocked(now)) return false;
    sendMouse(MOUSEEVENTF.WHEEL, delta | 0);
    return true;
  }

  releaseAll() {
    this.winMove = null; // a grabbed window is simply left where it is
    for (const b of [...this.buttons]) this.button(b, false);
    for (const vk of [...this.keysDown].reverse()) { SendInput(1, [kbd(vk, false)], SIZE); this.keysDown.delete(vk); }
  }

  /** Presses a key combination (e.g. ctrl, shift, s) and ALWAYS releases it, even if something goes wrong. */
  chord(vks) {
    if (!vks || !vks.length) return false;
    try {
      for (const vk of vks) { SendInput(1, [kbd(vk, true)], SIZE); this.keysDown.add(vk); }
    } finally {
      for (const vk of [...vks].reverse()) { SendInput(1, [kbd(vk, false)], SIZE); this.keysDown.delete(vk); }
    }
    return true;
  }

  /** Ctrl + mouse wheel at the cursor: zoom in most apps. One batch, so Ctrl is never left pressed. */
  zoom(direction, notches = 1) {
    this.keysDown.add(VK.ctrl);
    try {
      SendInput(3, [kbd(VK.ctrl, true), wheelInput((direction > 0 ? 120 : -120) * notches), kbd(VK.ctrl, false)], SIZE);
    } finally {
      this.keysDown.delete(VK.ctrl);
    }
    return true;
  }

  /** Media keys: play/pause, next, previous, volume. */
  media(name) {
    const vk = MEDIA[String(name).toLowerCase()];
    if (!vk) return false;
    SendInput(2, [kbd(vk, true), kbd(vk, false)], SIZE);
    return true;
  }

  /** Keyboard key (only used by tests to try the global shortcuts). */
  key(vk, down) {
    return SendInput(1, [{ type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: down ? 0 : KEYEVENTF_KEYUP, time: 0, dwExtraInfo: MAGIC } } }], SIZE);
  }
}

module.exports = { Input, MOUSEEVENTF, parseCombo, VK, MEDIA };
