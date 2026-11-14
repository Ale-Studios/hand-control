// Mouse e tastiera "veri" su Windows, tramite la funzione di sistema SendInput
// (user32.dll) chiamata direttamente con `koffi`: nessun processo esterno,
// nessun PowerShell, nessuna compilazione al volo. Ogni mossa costa ~0,05 ms.
//
// Limite di Windows: un programma normale NON può "toccare" finestre avviate
// come Amministratore (UIPI). Per quelle serve avviare anche Hand Control come
// Amministratore. Lo scriviamo nel README.

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

const MOUSEEVENTF = {
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, WHEEL: 0x0800, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000,
};
const KEYEVENTF_KEYUP = 0x0002;
const SIZE = koffi.sizeof(INPUT);
const MAGIC = 0x48434f4e; // "HCON": firma delle nostre mosse (dwExtraInfo)

function sendMouse(flags, data = 0, dx = 0, dy = 0) {
  return SendInput(1, [{ type: 0, u: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: MAGIC } } }], SIZE);
}

class Input {
  constructor() {
    this.buttons = new Set();   // tasti del mouse che abbiamo premuto noi
    this.screen = null;         // rettangolo (in pixel fisici) dello schermo di destinazione
    this.lastPos = null;        // dove abbiamo messo noi il cursore l'ultima volta
    this.suspendUntil = 0;      // se l'utente usa il mouse vero, ci fermiamo fino a questo istante
    this.realMouseWins = true;
    this.onRealMouse = null;
  }

  /** Rettangolo dello schermo di destinazione in pixel fisici {x,y,w,h}. */
  setScreenRect(r) { this.screen = r; }

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

  /** Lo stato REALE di un tasto in Windows (1 = sinistro, 2 = destro): per i test e le verifiche. */
  isDown(vk) { return (GetAsyncKeyState(vk) & 0x8000) !== 0; }
  doubleClickInfo() { return { ms: GetDoubleClickTime(), px: GetSystemMetrics(36), py: GetSystemMetrics(37) }; }

  /** Il mouse vero è stato mosso da una persona dopo l'ultima nostra mossa? */
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

  /** Muove il cursore: nx, ny in 0..1 sullo schermo di destinazione. */
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
      // Rilasciare è SEMPRE permesso (mai lasciare un tasto incastrato).
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
    for (const b of [...this.buttons]) this.button(b, false);
  }

  /** Tasto della tastiera (usato solo dai test per provare le scorciatoie globali). */
  key(vk, down) {
    return SendInput(1, [{ type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: down ? 0 : KEYEVENTF_KEYUP, time: 0, dwExtraInfo: MAGIC } } }], SIZE);
  }
}

module.exports = { Input, MOUSEEVENTF };
