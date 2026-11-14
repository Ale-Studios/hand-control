# Ideas for after the MVP (not implemented)

Proposals in order of value/simplicity. None has been started: to be decided together.

## 1. On-screen keyboard driven by the hands  ⭐ (the most useful)
A big-key keyboard that appears when needed (gesture or button) and is used by "pointing and pinching",
like the keys of a phone. You can type without a physical keyboard.
* **How:** a transparent always-on-top window that does *not steal focus* (like the current badge); keys are sent with
  `SendInput` (already available: `Input.key()` exists and is used in the tests) using Unicode scan codes, so accents and symbols work too.
* **Aids:** word suggestions (a small local dictionary), very large enter/backspace keys, "swipe" typing with the index finger
  as on smartphones.
* **Cost:** medium (2–3 days). **Risk:** precise typing at a distance is slow → better to use very big keys.

## 2. Media control
Volume, play/pause, next/previous track, ±10 s skip, in full screen.
* **How:** "wheel" gestures (index + thumb turning for volume), horizontal swipe for the track, held open hand for play/pause.
  It sends Windows' media keys (`VK_MEDIA_PLAY_PAUSE`, `VK_VOLUME_UP/DOWN`...), which work with Spotify, YouTube, VLC, Netflix...
* **"Media" mode:** entered with a gesture (e.g. two fingers up + hold), so sofa gestures do not interfere with the cursor.
  Shows a small panel with the volume.
* **Cost:** low (1 day). **Value:** high for people who watch films from a distance.

## 3. Configurable gestures
A tab where each gesture is mapped to an action chosen from a list: click, key, shortcut (e.g. `Alt+Tab`, `Win+D`), launching a
program, media command...
* **How:** the gestures are already named in the engine (`point`, `pinch`, `rclick`, `scroll`, `open`, `fist`): all it takes is a
  `gesture → action` table stored in the settings, plus new poses (thumbs-up, "OK", three fingers...) that are **recorded by showing them
  to the camera** (the hand shape is saved as numbers, never as images).
* **Safety note:** "dangerous" actions (closing windows, shutting down, sending keys) must ask for confirmation or require
  two gestures in sequence.
* **Cost:** medium-high (3–5 days).

## 4. Other small but useful ideas
* **Two-hand gestures:** zoom (hands moving apart), horizontal scrolling between virtual desktops (`Win+Ctrl+←/→`), "Alt+Tab" with a swipe.
* **Profiles:** "Desk" (near, high precision) and "Sofa" (far, slower and smoother cursor), chosen with a key or automatically
  from the size of the hand.
* **Cursor "brake":** automatically slows down when you approach a small target (as accessibility systems do).
* **Guided 4-corner calibration** with perspective correction (useful if the camera is above the screen and tilted, or with several monitors).
* **Multiple monitors:** active area split between screens, or a gesture to "jump" to the next monitor.
* **Lighting self-check:** a "too dark" warning with advice (turn on a light).
* **Presentation mode:** only previous/next arrows and an on-screen "laser" pointer (PowerPoint from a distance, no remote).
* **Accessibility mode:** wider thresholds, longer times, "dwell click" (hold the cursor on a target for 1 s = click) for people
  who cannot pinch.
* **Installation without warnings:** digitally sign the program (costs money every year) to avoid SmartScreen.

## 5. Measurements to take together (before anything else)
The gesture code was tested with "fake hands" (automatic tests) but **not yet with a real hand** over several sessions. Before
adding features it is worth using the *Measure* tab (20-second recording, jitter test, precision test) at 1 m, 2 m and 3 m and noting
the results in `docs/MEASUREMENTS.md`. That way we tune the pinch thresholds and the long-distance crop with data.
