// Actions: what the action gestures (and the launcher tiles) can do.
//
// An action is a short text, so it can live in the settings:
//   keys:COMBO      press a keyboard shortcut          e.g. keys:<cmd>+<tab>   keys:<ctrl>+<shift>+s
//   zoom:in|out     Ctrl + mouse wheel at the cursor   (zooms in most apps)
//   media:NAME      playpause | next | prev | volup | voldown | mute
//   open:TARGET     open an app, file, folder or web address (the browser is a separate program)
//   window:minimize | window:maximize   the window under the cursor
//   launcher        show / hide the launcher tiles
//   none            do nothing
//
// Everything here runs in the MAIN process, only when control is ACTIVE (the caller checks), and the
// text always comes from the saved settings, never from the camera window at the moment of the click.

const { shell, BrowserWindow, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseAction } = require('./actionspec.cjs');

// launcher geometry, in DIP (the test uses it to know where the tiles are)
const LAYOUT = { cols: 3, tileW: 180, tileH: 100, gap: 10, maxTiles: 11 };
const SAFE_SCHEMES = ['http', 'https', 'ms-settings', 'mailto'];
const AUTO_CLOSE_MS = 20000;

/** Opens an app, a file, a folder or a web address. Only a few address types are allowed. */
function openTarget(target) {
  const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(target);
  if (scheme && !/^[a-z]:[\\/]/i.test(target)) {
    if (!SAFE_SCHEMES.includes(scheme[1].toLowerCase())) throw new Error(`address type "${scheme[1]}" is not allowed`);
    return shell.openExternal(target);
  }
  if (fs.existsSync(target)) return shell.openPath(target);
  // a command such as "notepad", "calc", "osk", "explorer"
  const child = spawn(target, [], { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
  return undefined;
}

class Actions {
  /**
   * deps: { input, getSettings, log, isDry(), isLocked(), emit(name, ...args) }
   */
  constructor(deps) {
    this.d = deps;
    this.launcher = null;
    this.tiles = [];
    this.lastRun = 0;
  }

  /** Gesture → bound action. `which` is "ring" or "pinky". */
  runGesture(which) {
    const a = this.d.getSettings().actions;
    const text = which === 'ring' ? a.ringPinch : a.pinkyPinch;
    const now = Date.now();
    if (now - this.lastRun < 400) return false; // never twice in a blink
    this.lastRun = now;
    return this.runText(text, `gesture ${which}`);
  }

  runText(text, why = '') {
    const act = parseAction(text);
    if (act.error) { this.d.log(act.error); return false; }
    if (act.kind === 'none') return true;
    if (this.d.isDry()) { this.d.log(`[test mode] would run ${text}${why ? ' (' + why + ')' : ''}`); this.d.emit('action', text, true); return true; }
    try {
      if (act.kind === 'launcher') this.toggleLauncher();
      else if (act.kind === 'keys') this.d.input.chord(act.vks);
      else if (act.kind === 'zoom') this.d.input.zoom(act.value === 'in' ? 1 : -1);
      else if (act.kind === 'media') this.d.input.media(act.value);
      else if (act.kind === 'open') openTarget(act.value);
      else if (act.kind === 'window') {
        const title = this.d.input.windowAction(act.value);
        if (title == null) { this.d.log('No window under the cursor'); return false; }
        why = (why ? why + ': ' : '') + title;
      }
      this.d.log(`Action: ${text}${why ? ' (' + why + ')' : ''}`);
      this.d.emit('action', text, false);
      return true;
    } catch (e) {
      this.d.log(`Action failed (${text}): ${e.message}`);
      return false;
    }
  }

  // ───────────────────────── launcher ─────────────────────────
  launcherOpen() { return !!(this.launcher && !this.launcher.isDestroyed()); }

  toggleLauncher() {
    if (this.launcherOpen()) { this.closeLauncher(); return; }
    const raw = this.d.getSettings().actions.tiles;
    this.tiles = (Array.isArray(raw) ? raw : [])
      .filter((t) => Array.isArray(t) && typeof t[0] === 'string' && typeof t[1] === 'string' && !parseAction(t[1]).error)
      .slice(0, LAYOUT.maxTiles)
      .map((t) => [t[0].slice(0, 28), t[1]]);
    const n = this.tiles.length + 1; // + the "Close" tile
    const { cols, tileW, tileH, gap } = LAYOUT;
    const rows = Math.ceil(n / cols);
    const width = Math.min(n, cols) * (tileW + gap) + gap;
    const height = rows * (tileH + gap) + gap;

    const cur = this.d.input.cursor();
    let dip = cur;
    try { dip = screen.screenToDipPoint(cur); } catch { /* keep physical */ }
    const wa = screen.getDisplayNearestPoint(dip).workArea;
    const x = Math.round(Math.max(wa.x, Math.min(dip.x - width / 2, wa.x + wa.width - width)));
    const y = Math.round(Math.max(wa.y, Math.min(dip.y - height / 2, wa.y + wa.height - height)));

    const w = new BrowserWindow({
      x, y, width, height, frame: false, transparent: true, resizable: false, movable: false,
      focusable: false,          // never steals the focus: shortcuts reach the app you were using
      skipTaskbar: true, hasShadow: false, show: false,
      webPreferences: { preload: path.join(__dirname, 'launcher-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.launcher = w;
    w.setAlwaysOnTop(true, 'screen-saver');
    w.loadURL('hc://app/launcher.html');
    w.webContents.once('did-finish-load', () => {
      if (w.isDestroyed()) return;
      w.webContents.send('launcher:tiles', { names: this.tiles.map((t) => t[0]), cols });
      w.showInactive();
    });
    const timer = setTimeout(() => this.closeLauncher(), AUTO_CLOSE_MS);
    w.on('closed', () => { clearTimeout(timer); if (this.launcher === w) this.launcher = null; });
    this.d.emit('launcher', true);
  }

  closeLauncher() {
    if (this.launcherOpen()) this.launcher.close();
  }

  /** A tile was chosen (by a click inside the launcher window). */
  chooseTile(index, sender) {
    if (!this.launcherOpen() || sender !== this.launcher.webContents) return;
    if (!Number.isInteger(index) || index < 0) return;
    if (index >= this.tiles.length) { this.closeLauncher(); return; } // the "Close" tile
    const text = this.tiles[index][1];
    this.closeLauncher();
    if (this.d.isLocked()) return;
    // a moment for Windows to give the focus back to the previous app, which the shortcut should reach
    setTimeout(() => this.runText(text, `tile "${this.tiles[index][0]}"`), 150);
  }

  bounds() { return this.launcherOpen() ? this.launcher.getBounds() : null; }
}

module.exports = { Actions, parseAction, openTarget, LAYOUT };
