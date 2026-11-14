# Technical choices (and the alternatives discarded)

This document explains **why** Hand Control is built the way it is. Every important choice has its options
side by side. If you want to change one, the place to touch is indicated.

---

## 1. How to make the mouse and keyboard really move on Windows

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **`koffi` + `SendInput`** (calls `user32.dll` directly) | No external program. ~0.05 ms per move. Maintained library with ready-made binaries for Electron (nothing to compile on the PC). "Normal" use of Windows. | One more native dependency (but prebuilt). | ✅ **Chosen** |
| `robotjs` | Famous, simple | Unmaintained for years; must be **rebuilt** for every Electron version (needs Visual Studio Build Tools); often breaks on updates | ❌ |
| `nut.js` | Modern, many features (images, windows) | The official version is now paid / private registry; the free fork is less updated; heavy (ships computer vision too) | ❌ |
| **PowerShell** on every move/click (what JARVIS does today) | Zero dependencies | Slow (300–800 ms **per click**), compiles C# on the fly every time (antivirus products frown on it), impossible for continuous movement | ❌ |
| An external helper `.exe` (C#/Go) | Fast | One more program to sign, maintain and get accepted by antivirus | ❌ (for now) |

**Antivirus:** `SendInput` is the same function used by on-screen keyboards, accessibility tools and AutoHotkey. There is no code
that downloads or compiles on the fly. The app is still not signed: on first launch SmartScreen may show a warning (see README,
installation section).

**Where to change it:** everything is in `src/main/input.cjs` (one class with 5 methods: `moveNorm`, `button`, `click`, `wheel`,
`releaseAll`). Replacing `koffi` with something else means rewriting only that file.

**Windows limit (UIPI):** a normal program cannot "click" inside windows started as Administrator. For those, Hand Control must
also be started as Administrator.

---

## 2. Where hand recognition runs

| Option | Verdict |
|---|---|
| **MediaPipe Tasks (HandLandmarker) inside the Electron page**, with the engine and model **inside the app** | ✅ Chosen. Same technology as JARVIS, but without downloading anything from the internet (JARVIS currently loads it from a CDN at every start). Uses the GPU (WebGL) and falls back to the CPU. |
| Python + MediaPipe in a separate process | ❌ A second runtime to install, slower communication. |
| A custom ONNX model | ❌ A lot of work for similar results; MediaPipe is already very good. |

**Graphics card:** on PCs with two GPUs (here Intel UHD 630 + GTX 1650) the app passes `force_high_performance_gpu`.
Measured on the test PC: powerful GPU → 25 ms per frame; processor → 67 ms; the GPU picked by Windows → the engine did not start.
To turn the request off: environment variable `HC_GPU=default`. If no frames arrive within 15 s it switches to the processor by itself.

The model (`assets/models/hand_landmarker.task`, ~7.8 MB, Google's Apache 2.0 licence) and the `wasm` files are served through an
internal `hc://` protocol (local files only).

---

## 3. How "at a distance" works (1–3 metres)

The problem: an ordinary webcam sees the hand **tiny** at 3 metres, and Google's model needs a hand of at least ~30–40 pixels
to recognise it.

The implemented solution ("crop that follows the hand"):
1. we ask the camera for **1080p**;
2. when we see the hand, we give the model only a **crop** around it (~2.8 times the hand size), which follows it; the model
   "sees" a big hand even when it is far away;
3. when the hand disappears, we search in turns: the whole frame, then the zoomed centre, then the sides.

Three presets: **Near** (up to 1.5 m, 720p, no crop), **Medium** (1.5–2.5 m), **Far** (2.5–4 m).
Honest limit: it depends on the camera. A 1080p webcam with a very wide lens is the worst case; one with a "narrower" lens or 4K is
much better. **Real values must be measured with your camera** (see the *Measure* tab and `docs/MEASUREMENTS.md`).

---

## 4. How accidental clicks are avoided

* Control **always starts paused**. Activating it needs a deliberate gesture (open hand held **still** ~1.6 s, with a progress
  bar). Moving or waving the hand restarts the count.
* **Pause** with the same gesture (~0.9 s), or `Ctrl+Alt+P`.
* **Emergency lock**: `Ctrl+Alt+K` (global, works with the app in the background), the red button, the tray icon, or a
  **closed fist held still ~1 s**. Once locked, gestures are ignored; it can **only** be left from the keyboard/button, and it
  returns to *pause*, never directly to *active*.
* **The "judge" is the main process**, not the window with the camera: if the window froze or were tampered with, mouse commands
  are still discarded when we are not ACTIVE. Releasing buttons, on the other hand, is **always** allowed (never leave a button stuck).
* **Watchdog**: if a button stays pressed and no more signals arrive for 1.5 s, it releases it.
* **Hand lost**: button released after 0.35 s; automatic pause after 20 s without a hand (adjustable).
* **Physical mouse**: if you move the mouse yourself, the hand pauses for 1.5 s (so the two do not fight).

## 5. Click: why "down on pinch, up on release"

A classic click is **press** and **release**. The pinch does exactly that, so click, double click and drag come for free, with
minimum latency:

* short pinch = click; two pinches = double click (the second "sticks" to the same point as the first);
* **held** pinch and moving hand = drag (after 0.28 s, adjustable).

The classic problem: when you pinch, the finger moves and the click lands next to the target. Solutions:
* the cursor is driven by the **index knuckle** (it moves little when you pinch), not the fingertip;
* the click is placed at the position the cursor had ~30 ms **before** the pinch was recognised, and the cursor stays still
  for 0.28 s.

## 6. Jitter smoothing

**One Euro** filter (the standard for hand/eye-driven cursors): when still it smooths a lot, when you move fast it adds almost no
lag. The cursor is filtered **in screen pixels**, so the setting is equivalent on every resolution. The cursor **always reaches
the corners** (there is a 2% "magnet" at the edges of the area).

## 7. Privacy

* No network requests: every non-local address is **cancelled** before it leaves (and counted, see the "Network requests blocked"
  line in the app), plus a CSP rule in the page.
* The camera only opens while the app is running and there is always an **indicator**: a red "CAMERA" dot in the always-on-top
  badge plus the name in the system tray. It can be turned off with a button.
* Frames are never saved: they are looked at and immediately discarded. "Measurements" save **numbers only**.
* Only the app window can ask for the camera, only video (never the microphone).
* Only settings are stored (`settings.json` in the app's data folder under `%APPDATA%`).

## 8. Why JARVIS was only read, not touched

JARVIS's code was **only read** to understand its "air-tap" cursor. The new project is independent (its own folder and repository).
Things that are deliberately different here: local engine and model (not from a CDN), one single channel to the mouse with filters
and safety in the main process, direct SendInput instead of PowerShell, smoothing, a calibratable active area, pause/lock gestures.
