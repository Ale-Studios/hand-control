# Measurements

Where and how the numbers were measured, what they mean, and what has **not** been measured yet.
Test PC: Windows 11, GTX 1650 4 GB + Intel UHD 630, 16 GB RAM, 1920×1080 screen (100% scale), webcam at 1280×720.
Date: 14/11/2026. App version: 0.1.0.

## 1. End-to-end test with "fake hands" (`npm run test:e2e`)

Chain tested: a frame with the 21 points of a synthetic hand → app page → gesture engine → main process → `SendInput` →
**the real Windows mouse** → a full-screen test window that records the events.
Isolated profile (temporary USERPROFILE/APPDATA/LOCALAPPDATA). **27 checks out of 27 passed.**

| What | Result |
|---|---|
| While PAUSED the hand does not move the cursor | ✅ (0 px) |
| Open hand 1 s does not activate; ~2 s does | ✅ |
| The cursor goes where you point | ✅ 0 px offset (expected 1535,755 / got 1535,755), 48 `mousemove` events |
| Reaches the 4 screen corners | ✅ (0,0) and (1919,1079) |
| Pinch click (down, up, click) | ✅ |
| The click lands where you were pointing before the pinch | ✅ 0 px offset (even if the hand "slides" while pinching) |
| Double click (two pinches) | ✅ the window receives `dblclick` (280 ms between the clicks, same pixel) |
| Right click (thumb + middle pinch) | ✅ a single `contextmenu` |
| Drag (held and moved pinch) | ✅ moved 767 px with the button held |
| V-sign scrolling up/down | ✅ in both directions (8 and 9 notches) |
| Pause with the open hand (~1 s) | ✅ and the cursor stays still |
| **Ctrl+Alt+K** (real, via keyboard) with a button held | ✅ lock in **6–15 ms**; mouse button released (checked on the real Windows state) |
| While LOCKED: gestures ignored; an open hand does not unlock; Ctrl+Alt+K unlocks into PAUSED | ✅ |
| Closed fist ~1 s = LOCK | ✅ |
| Hand not seen for 3 s (with the threshold set to 3 s) = automatic PAUSE | ✅ |
| Internet blocked (navigation and `fetch`) | ✅ `ERR_BLOCKED_BY_CLIENT` / CSP, requests counted |

### Latency of the "software" part (no camera)

| Stretch | Median | 95th percentile |
|---|---|---|
| Frame → `SendInput` finished (page + IPC + system) | **2.5 ms** | 3.1 ms |
| Click: frame → `mousedown` event in the window | **13 ms** (of which SendInput→window 2–3 ms) | – |
| Emergency key → LOCKED mode | **6–15 ms** | – |

For comparison, JARVIS's click launches PowerShell on every click (hundreds of ms: not measured here, it was not touched).

> ⚠️ These measurements **do not include** the camera and recognition: they are only the stretch "from the moment the hand points
> are ready to the moment the cursor has moved".

## 2. Real camera + MediaPipe (`npm run bench:camera`)

A 20 s recording with the real camera at 1280×720, *Near* preset, **with no hand in front of it** (so the model works in
"search" mode: the heaviest case for palm detection). Only numbers are saved.

| Engine | Frames/s | Recognition (median / 95th) | Camera→app (median) |
|---|---|---|---|
| **Powerful GPU** (`force_high_performance_gpu`, default) | 15 | **25 ms** / 38 ms | 39 ms |
| Processor (CPU, XNNPACK) | 14 | 67 ms / 88 ms | 71 ms |
| GPU "default" chosen by Windows | ⛔ did not start (no result in 90 s) | – | – |

What it means:
* The camera in that room ran at ~15 frames/s (probably low light: webcams drop their fps in the dark). With more light it should reach
  30; the recognition (25 ms) would be enough.
* **Estimated total hand→cursor delay** = camera→app (~40 ms) + recognition (~25 ms) + software (~3 ms) ≈ **70 ms**, plus the camera's
  internal delay (sensor/USB, typically 30–60 ms, not measurable in software) and any display lag. For a remote pointer this is normal,
  not "instant".
* That is why the app **forces the powerful graphics card** at start-up; if a PC cannot cope, after 15 s without frames it switches to the
  processor by itself (and the safety watchdog pauses control if frames stop while ACTIVE).
* First start: the first frame on the GPU can take a few seconds (it compiles the graphics programs); the recording therefore starts 8 s
  after the first frame.

## 3. What has **not** been measured yet (your hand is needed)

* **Gesture recognition with a real hand** (pinch / middle / V / fist / open hand): thresholds were chosen from hand geometry (ratios between
  distances, independent of distance), but still need verifying. How: *Measure → Record 20 seconds* while making the gestures → the `.json`
  file counts the recognised gestures.
* **Real jitter** with a still hand and **click precision**: *Measure → Jitter test* and *Precision test* (9 targets). Goals: jitter below
  ~3 px when still; mean click error below ~15 px; at least 8/9 targets hit.
* **Distance**: repeat the recording at 1 m, 2 m, 3 m with the *Near/Medium/Far* presets and note the % of frames with a hand seen. The crop that
  follows the hand (*Medium/Far*) has **never been tried with a real hand**: it is implemented but needs validating.
* MediaPipe's **right/left label** (if "Right only" picks the wrong hand, use "Left only").
* Several monitors, screen scale other than 100% (the maths uses physical pixels and Windows absolute coordinates, but it has not been
  tried with other scales).
* "Administrator" applications (a Windows limit) and exclusive full-screen games.

### Table to fill in

| Date | Distance | Light | Frames/s | Hand seen | Total delay | Jitter (px) | Precision (px) | Notes |
|---|---|---|---|---|---|---|---|---|
| | 1 m | | | | | | | |
| | 2 m | | | | | | | |
| | 3 m | | | | | | | |
