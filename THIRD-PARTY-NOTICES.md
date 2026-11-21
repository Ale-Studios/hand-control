# Third-party notices

Hand Control itself is MIT-licensed (see [LICENSE](LICENSE)). It builds on the open-source components below.
Each keeps its own licence; the full texts ship inside the packages (`node_modules/<name>/LICENSE`) and inside the
installed app (`LICENSE.electron.txt`, `LICENSES.chromium.html`).

| Component | Used for | Licence |
|---|---|---|
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (`@mediapipe/tasks-vision`, incl. its WebAssembly runtime) | hand tracking, runs locally | Apache-2.0 |
| MediaPipe **Hand Landmarker** model (`assets/models/hand_landmarker.task`) | the hand-landmark model, from Google's published model card | Apache-2.0 |
| [Electron](https://www.electronjs.org/) 31 (includes Chromium and Node.js) | the desktop shell | MIT (Chromium and its dependencies carry their own licences, see `LICENSES.chromium.html`) |
| [koffi](https://koffi.dev/) | calls the Windows `user32.dll` input functions (`SendInput` etc.) | MIT |
| [electron-builder](https://www.electron.build/) (build only) | creates the installer | MIT |
| [rcedit](https://github.com/electron/rcedit) (build only) | embeds the icon and version into the .exe | MIT |

The smoothing filter follows a published paper (Casiez, Roussel & Vogel, *1€ Filter*, CHI 2012). Some interaction ideas
(for example the launcher and two-hand mode) were inspired by other open-source hand-control projects such as `handcursor`;
the code in this repository was written for Hand Control and does not include code from those projects.

If you find a missing or wrong notice, please open an issue.
