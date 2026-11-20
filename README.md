# Hand Control

Control your PC **with your hands**, without touching a mouse or keyboard, even from a few metres away.
A camera watches your hand; **everything stays on your PC** (no internet, no cloud, no recordings).

> Status: **MVP (v0.1)**. Tested with synthetic "fake hands" along the whole chain down to the real mouse
> (27 automatic checks passed, ~3 ms of software delay) and with a real camera (local engine on the GPU: 25 ms per frame).
> Accuracy with a **real** hand, especially at 2–3 m, still has to be measured: see [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

## What it does

| Gesture | What happens |
|---|---|
| ☝️ **Index finger up** | moves the cursor (with jitter smoothing) |
| 🤏 **Pinch thumb + index** | left click · held and moved = drag · two pinches = double click |
| 🤏 **Pinch thumb + middle** | right click |
| ✌️ **Index + middle up** | scroll: move your hand up/down |
| 🤏 **Thumb + ring finger, held ½ s** (index up) | **action 1**: by default the launcher (big tiles) |
| 🤏 **Thumb + little finger, held ½ s** (index up) | **action 2**: by default task view (switch windows) |
| 🖐️ **Open hand, held still** | activate / pause (progress bar) |
| ✊ **Closed fist, held still** | **emergency lock** |
| ⌨️ **Ctrl+Alt+K** | **emergency lock** from the keyboard (again = unlock, into pause) |

Also: a HUD-style preview (dimmed camera image; glowing hand skeleton, translucent palm, tracking box, pointer reticle with a fading
trail, live pinch gauge; colour, brightness and trail are adjustable in *Settings → Camera*; *Window glass effect* gives a
translucent Windows 11 window), an always-on-top status badge (ACTIVE / PAUSED / LOCKED / hand not seen, plus a red dot
while the camera is on), guided calibration of the movement area, settings for sensitivity / smoothing / area / distance,
and a **Measure** tab (latency, jitter, precision).

## Actions, launcher and two-hand mode

**Action gestures.** Touch thumb and ring finger (or little finger) for half a second, keeping the index finger up: Hand Control runs
the action you chose for it (*Settings → Actions*). Ready-made choices: launcher, task view, show desktop, search, screenshot,
zoom in/out, back/forward, close/new tab, play/pause, volume, on-screen keyboard, File Explorer, nothing.

**Launcher.** A grid of big tiles appears around the cursor (Files, Search, Keyboard, Task view, Desktop, Screenshot, Zoom in/out,
Play/pause). Point at a tile and pinch to choose it; the *Close* tile (or the same gesture again, or 20 s) closes it. It never takes the
keyboard focus, so a shortcut goes to the app you were using. Tiles and gestures are stored in `settings.json` as short texts:

| Action text | What it does |
|---|---|
| `keys:<ctrl>+<shift>+s` | presses a keyboard shortcut (`<cmd>` is the Windows key) |
| `zoom:in` / `zoom:out` | Ctrl + mouse wheel at the cursor: zooms in browsers, Explorer, Office, image viewers, maps |
| `media:playpause` | also `next`, `prev`, `volup`, `voldown`, `mute` |
| `open:TARGET` | opens an app (`open:notepad`), a file or folder, or a web address (`https:`, `ms-settings:`; the browser is a separate program) |
| `launcher` / `none` | show the launcher / do nothing |

Actions only run while control is **ACTIVE**; keys are always released afterwards (also by the emergency lock); a mistyped action is
rejected instead of saved.

**Two-hand mode** (*Settings → Cursor*). One hand steers the cursor, the other clicks, drags and scrolls, so you can click without
holding the pointing hand still. A fist or an open hand on the helper hand does nothing.

**Cursor point.** *Settings → Cursor → Point that moves the cursor*: index knuckle (steady), **centre of the palm** (steadiest: it does
not move when the fingers do) or index fingertip (most natural).

**Test mode** (*Settings → Safety*). Hand Control shows in the log what each gesture *would* do, without touching the mouse or the
keyboard. The badge says TEST MODE. Good for trying gestures with no risk.

## Quick start

You need **Windows 10/11** and **Node.js 20+** (for development). Then:

```bash
npm install
npm start
```

1. Stand 1–3 m from the camera with your hand clearly visible.
2. **Controls → Calibrate the movement area** (two corners, 1.5 s each).
3. Hold an **open hand still for ~2 seconds**: the badge turns green (**ACTIVE**).
4. Point with your index finger. To stop everything: **Ctrl+Alt+K**.

Control **always starts paused**: nothing moves until you make the activation gesture yourself.

### Installing it as a program

```bash
npm run dist
```

creates `dist\Hand Control Setup 0.1.0.exe` (NSIS installer, ~96 MB; you can choose the folder; it adds Desktop and Start-menu
shortcuts). It is not digitally signed: on first launch Windows SmartScreen may show "Windows protected your PC" →
*More info → Run anyway*.
To try just the build without an installer: `npm run build` (creates `dist\win-unpacked\Hand Control.exe`).
Quick check of a built or installed app: `"Hand Control.exe" --selftest` (verifies that the mouse API, the engine, the model and
the files are all present, prints the result and exits with code 0 if everything is fine).
The build downloads **only** the Electron/NSIS build tools from the internet (once); the finished app never does.

## Permissions and safety (what is needed and what it does NOT do)

| What | Needed? | Why |
|---|---|---|
| **Camera** | yes | to see your hand. It turns on at launch, a red "CAMERA" indicator is always visible, and a button turns it off. Windows: *Settings → Privacy & security → Camera* must allow desktop apps. |
| **Mouse control** | yes (no special permission) | uses the system function `SendInput`, like a virtual keyboard/mouse. |
| **Administrator** | no — **only** if you want to control windows started as Administrator | Windows stops a normal program from clicking inside those windows (UIPI). |
| **Microphone** | **no** (the request is denied by the code) | |
| **Internet** | **no**, never | every non-local request is blocked and counted (the *"Network requests blocked"* line). The recognition engine and model are inside the app. |
| **Disk** | settings only | `settings.json` in the app's data folder under `%APPDATA%`. Measurements save **numbers only**. |

* **No recording:** frames are analysed and immediately discarded; no image or video is ever written.
* **Accidental control is hard:** it starts paused; activation needs a deliberate gesture (open hand held **still** for
  ~1.6 s; if you move, it starts over); the pause/lock gestures also work only when held still.
* **An emergency switch that always works:** `Ctrl+Alt+K` (global, even with the app in the background), the red button, the
  tray-icon menu, or a closed fist. It instantly releases any pressed mouse buttons. Once LOCKED, gestures do nothing and
  only the keyboard/button unlock it, returning to *pause*.
* If another app already owns `Ctrl+Alt+K` (for example JARVIS), Hand Control tries `Ctrl+Alt+Shift+K` and says so in the log;
  the red button and the fist stay available regardless.
* If you move the **physical mouse**, hand control pauses for ~1.5 s so it does not fight you.
* If the camera is on but analysed frames stop arriving (5 s) while you are ACTIVE, the app pauses itself.
* On PCs with two graphics cards the app asks Windows for the **powerful** one (on the test PC, with the one Windows picked
  the recognition would not start); if the graphics card does not respond it falls back to the processor by itself
  (*Settings → Camera → Compute engine* to choose manually).

## At a distance (1–3 metres)

In *Settings → Camera → Distance* choose **Near / Medium / Far**. The farther away, the more the app asks the camera for 1080p and
zooms in around your hand (the crop follows it). Tips: good light in front of you (not backlit), a not-too-busy background,
a sleeve that contrasts with your skin, a **1080p camera** or better. At 3 m with a cheap wide-angle webcam the hand may stay too
small: it depends on the camera, so it needs measuring (*Measure* tab).

## Measure (precision and latency)

**Measure** tab:
* **Live:** frames/s, recognition time, hand→cursor delay (camera→app, processing, mouse).
* **Record 20 seconds:** full statistics (medians, 95th percentile, % of frames with a hand, gestures counted), saved as `.json`
  in the app's `measurements` folder (button *Open the measurements folder*).
* **Jitter test (5 s):** how many pixels the cursor "dances" with a still hand, before and after smoothing.
* **Precision test:** 9 targets to hit with a pinch in full screen → mean error in pixels and times.

From a terminal, without the interface: `npm run bench:camera` (turns the camera on for ~35 s, writes the numbers in an
isolated profile, exits; `npm run bench:camera -- --delegate=CPU` tries the processor instead of the graphics card).
Results and how to read them: [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

## Testing

```bash
npm test          # 30 tests of the gesture "brain" and of the action texts, with fake hands (fast, no camera)
npm run test:e2e  # full test: real app → real mouse → a window that records the events (~3 min)
HC_E2E_ONLY=dbl,kill npm run test:e2e   # only some sections (dbl = double click, kill = emergency, actions = actions/launcher/two hands/test mode, net = network)
```

`test:e2e` opens a full-screen window that **uses the mouse by itself for ~3 minutes** (do not touch anything) in an isolated
profile (temporary `USERPROFILE/APPDATA/LOCALAPPDATA`); it checks movement, click, double click, right click, drag, scrolling,
pause, the emergency switch (with a real `Ctrl+Alt+K`), fist, auto-pause and the network block, and measures latency.

## Project structure

```
src/core/       gesture brain (pure, testable): engine, filters, mapping, hand measurements
src/main/       Electron: safety and modes, SendInput (koffi), shortcuts, icons, network lockdown
src/renderer/   interface, camera + MediaPipe (tracker.mjs), status overlay
assets/models/  hand recognition model (Google, Apache 2.0)
test/           automatic tests and the end-to-end test
docs/           technical choices, future ideas, measurements
```

To understand **why** it is built this way (and the discarded alternatives): [docs/TECHNICAL-CHOICES.md](docs/TECHNICAL-CHOICES.md).
Ideas for later: [docs/FUTURE-IDEAS.md](docs/FUTURE-IDEAS.md).

## Known limits (honesty)

* The gestures were verified with synthetic hands and with the chain down to the mouse; **with a real hand more measurements are still
  needed** and probably some tweaking of the thresholds (settings *Pinch sensitivity*, *Minimum gesture duration*).
* MediaPipe's **right/left** label must be confirmed with your camera (if "Right only" picks the wrong hand, use "Left only").
* At 3 m the result depends heavily on the camera and the light.
* It cannot control "Administrator" windows unless it is also started as Administrator.
* Only one hand is in control (the closest one, or the chosen one).
* Unsigned installer → SmartScreen warning.

## Licences

Code: Ale Studios. Dependencies: Electron (MIT), koffi (MIT), MediaPipe Tasks Vision and the `hand_landmarker.task` model
(Google, Apache 2.0).
