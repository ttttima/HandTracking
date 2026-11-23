# HandTracking: hand tracking that controls your PC

**HandGestures** is a Windows desktop app (and a browser version) that tracks your hands through the webcam,
draws a 21-point skeleton over each hand, recognises signs, and can move and click your
mouse with your hand.

Built with **TypeScript + Vite + [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js)**,
packaged with **Electron**. Mouse control calls Windows' own `user32` functions through
[koffi](https://koffi.dev). Everything runs locally; no video leaves your machine.

---

## Quick start

Requirements: **Windows 10/11**, **Node.js 18+**, a webcam.

```powershell
npm install
```
This installs the dependencies, copies the WASM runtime and downloads the hand model (~7.8 MB).

Then start the desktop app, or just double-click **`start.bat`**:

```powershell
npm run desktop:start
```

Click **Start camera**, hold your hand up about 40–80 cm from the screen, and click
**Control my PC** when you want your hand to drive the mouse.

To get a single file you can copy anywhere or put on your desktop:

```powershell
npm run desktop:dist
```
This writes `release/HandGestures-1.0.0-portable.exe` (about 120 MB, no install needed). Windows SmartScreen
may warn the first time because the file is not code-signed; choose *More info → Run anyway*.

| Command | What it does |
| --- | --- |
| `npm run desktop:start` | Build and open the desktop app |
| `npm run desktop` | Desktop app in development mode (UI reloads as you edit) |
| `npm run desktop:dist` | Build the portable Windows `.exe` into `release/` |
| `npm start` | Browser version only (no PC control) on http://localhost:5173 |
| `npm test` | Unit tests: fingers, signs, drag/swipe, and the PC controller |
| `npm run verify` | Browser end-to-end checks: real hand photos, webcam path via a fake camera, permission errors |
| `npm run verify:settings` | Settings survive a restart: change keybinds and settings, close, wipe Chromium storage, reopen |
| `npm run verify:desktop` | Desktop end-to-end checks in **dry-run** mode (mouse actions are logged, never performed). Add `-- --packaged` after `desktop:dist` to test the `.exe` |
| `npm run verify:background` | Checks tracking keeps full speed while the desktop app is minimised |
| `npm run setup` | Re-copy WASM files / re-download the model |

---

## Controlling your PC

Control is **off** until you click **Control my PC**. Then one hand (right by default) becomes the mouse:

| Do this | Mouse |
| --- | --- |
| Move your hand | Move the pointer (it follows the middle of your four knuckles, so pinching or bending a finger doesn't nudge it) |
| Quick pinch (thumb + index, let go) | Left click; two quick pinches double-click |
| Pinch and hold, move, let go | Drag and drop. If tracking loses the pinch or your hand for a moment, the drag keeps holding; it drops once the pinch has been gone for 500 ms (**Settings → Sensitivity → Drop drag after**) |
| Any other gesture | Whatever you set in **Keybinds** (see below) |
| **Ctrl+Alt+H** (works from any app) | Turn control off or on |

### How the pointer is made precise

- **One filter, on the raw points.** The pointer reads the detector's unsmoothed knuckle points and
  filters them once, in screen units (a One Euro filter: very steady when your hand is still, quick
  when it moves). Small movements below a speed threshold count as still, so camera noise can't make
  the pointer wobble.
- **Gliding between camera frames.** The camera gives about 30 positions a second; the desktop app
  moves the cursor towards each one in small steps about 200 times a second, so motion is smooth.
- **Clicks land where you aimed.** Forming a pinch nudges the hand. A click (or the start of a drag)
  goes to where the pointer was just before the pinch began, and the pointer holds still around it.
- **Sub-pixel wobble is ignored**, and **Settings → PC control → Screens** can stretch the pointer
  across every monitor.

Measured on a simulated hand with camera-like noise (`tests/pointer.test.ts`), against the previous
version: jitter when still 1.06 → 0.48 px, lag while moving 47–89 ms → 11–18 ms, settling after you
stop 167–300 ms → 33–67 ms.

### Saved settings

In the desktop app every setting and keybind is saved to one file as you change it, and loaded when
the app starts: `%APPDATA%\hand-gestures\settings.json` (**Settings → Saved settings → Show the file**).
It is plain JSON, so you can back it up or copy it to another PC. In a browser, settings are kept in the
browser's own storage instead.

### Keybinds

The **Keybinds** button (top bar, desktop app) lets you choose what every gesture except pinch does while
control is on: open palm, closed palm, fist, pointing, peace, middle finger, thumbs up, thumbs down, Vulcan salute, and
the four swipe directions. Either hand can trigger them. Each one can be set to:

- Nothing, left click, right click, double click, scroll up, scroll down
- Minimise window, show desktop / bring windows back (Win+D), pause or resume control
- **Second desktop**: from your original desktop, go to a second virtual desktop, creating it if it does
  not exist yet. **Back to first desktop** returns to the original. At most two desktops are used: on the
  second desktop, "second" does nothing, and on the original, "back" does nothing.
- **Open an app**: search the list of installed apps (everything in the Start menu, including Store apps
  such as Calculator or Settings), or **Browse…** for any program (.exe or shortcut)
- **Any keyboard shortcut**: type it (`Ctrl+Shift+T`, `Win+E`, `Alt+F4`…), press **Record** and press the
  keys, or pick a common one (Alt+Tab, copy/paste, media play/pause, volume…)

Signs can fire **when made** or **when held** for about a second. Defaults: peace = right click, middle
finger = minimise window, hold fist = pause or resume, swipe left = second desktop, swipe right = back to
the first desktop, swipe up/down = scroll. Gestures switched off in
Settings → Gestures never fire.

The box drawn on the picture is the part of the camera view that covers your whole screen,
so you can reach the screen edges without leaving the frame. In **Settings → PC control** you can pick the
hand, change the reach (box size) and pointer smoothing, and keep the window on top of other apps.

Safety: mouse buttons are always released if the hand leaves the picture, control is
switched off, or the window closes.

Tracking keeps full speed while the window is minimised or covered: camera frames are read straight
from the camera track (WebCodecs `MediaStreamTrackProcessor`) and analysed as they arrive, instead of
waiting for the on-screen video to be drawn, and Chromium's background throttling is switched off.
`npm run verify:background` measures the frame rate visible, minimised and restored.

Limits: control covers the **primary monitor**. Windows does not let a normal app click inside windows
running as administrator (UAC prompts, elevated apps); start HandGestures as administrator if you need that.

---

## What you get

**Tracking**: up to 2 hands at once, each detected and shown on its own, 21 landmarks per hand,
One Euro smoothing (low jitter when still, low lag when moving), stable hand IDs across frames,
and duplicate suppression (MediaPipe sometimes reports one hand twice).

**Screen layout**: left hand | picture | right hand. Each side shows only what that hand is doing now:
- the sign it is making, set large. Its letter width follows how open the hand is: a fist reads narrow, an open palm wide.
- how long the sign has been held and how well it matches
- five finger bars (thumb to pinky) showing how far each finger is extended

With mirroring off, the panels swap sides so each one stays next to its hand.

**On the picture**: a hand-shaped outline (slate for the left hand, clay for the right), the palm, bones coloured
per finger, joints scaled by depth, larger fingertips, a square wrist, lines between fingertips that are near
or touching, a ripple when a drag starts, and a tag above each hand with its sign.

**Settings → Gestures**: a checkbox per gesture. Unchecked gestures are ignored completely, including
their PC action (unchecking Pinch stops pinch-clicking, Peace stops right click, and so on).

**Settings → Angle snapping**: when checked, the mouse pointer, drags and air drawing are snapped to
fixed directions (every 15°, 30°, 45° or 90°), so straight horizontal, vertical and diagonal lines are easy.
Movement is measured from a starting point, its angle is rounded to the nearest step
(`Math.round(angle / step) * step`) and the position is projected onto that line. Hold your hand still for
about 0.2 s to start a new line in another direction.

**Settings** (top right): camera, detection backend (automatic / GPU / CPU), one or two hands, a photo or
video instead of the camera, display options (skeleton, outline, sign recognition, mirror, smoothing,
point numbers, air draw), and sensitivity sliders for every threshold.

Keyboard: **C** camera, **S** skeleton, **O** outline, **G** sign recognition, **M** mirror, **F** smoothing, **I** point numbers, **D** air draw, **Esc** close settings.

**Air draw**: touch thumb and index to draw in the air, hold a fist to clear.

**Palette**: built around stone `#A69F98`, with muted earthy neighbours: bone `#EBE7E1`, soot `#221E1B`,
slate `#9FB3BB` (left hand), clay `#D9A58C` (right hand), and finger colours clay, ochre, sage, slate and mauve.
Type is Archivo (bundled, works offline). Tokens live at the top of `src/styles.css` and in `PALETTE` in `src/config.ts`.

---

## Gestures

All distances are divided by the **palm size** (wrist → middle-finger knuckle, measured in 3-D
world coordinates), so thresholds behave the same whether your hand is near or far, big or small.
Finger state comes from **joint bend angles** in 3-D, so it is independent of hand rotation.

| Gesture | How it's recognised |
| --- | --- |
| 🖐️ Open palm | all five fingers extended **and spread apart** (average angle between neighbouring fingers above 10°) |
| Closed palm | flat hand: index to pinky extended **and held together** (below 6°); thumb can be in or out |
| Middle finger | only the middle finger extended |
| ✊ Fist | index–pinky folded, thumb not clearly out |
| ☝️ Pointing | index extended, middle/ring/pinky folded, thumb not pinching the index |
| ✌️ Peace | index + middle extended, thumb/ring/pinky folded |
| 🖖 Vulcan salute | index to pinky extended in two pairs: a gap between middle and ring above 14°, and the index–middle and ring–pinky gaps much smaller (thumb in or out) |
| 🤏 Pinch | thumb and index fingertips together or close, at any rotation; index reaching out (rejects fists) |
| 👍 Thumbs up / 👎 down | only the thumb extended **and** pointing up / down in the image |
| Drag | thumb–index touch held > 480 ms → `drag:start` / `drag:move` / `drag:end` |
| Hold | any gesture held for 900 ms → `gesture:hold` (e.g. "hold thumbs up to confirm") |
| Swipe | fast palm movement (≥ 0.6 palm sizes at ≥ 4 palm/s; set the distance with the **Swipe distance** slider under the picture) with ≥ 3 fingers out → left/right/up/down |

**Finger interactions:** every fingertip pair is tracked with hysteresis: *touching*
(< 0.25 × palm, released at 0.33), *near* (< 0.55) or *apart*. Each transition fires an event
(`contact:start`, `contact:end`, `proximity:near`, `proximity:far`), so "thumb touches index",
"two fingertips touch", "fingers move close" and "fingers separate" are all first-class events.

**Stability:** gestures use soft 0–1 scores, an activate/deactivate hysteresis band, and
must persist `stableMs` to start and be absent `releaseMs` to end, so single-frame glitches never fire events.

### Tuning sensitivity
Open **Settings → Sensitivity**: every slider applies instantly and is saved in your browser.
To change the defaults for everyone, edit `DEFAULT_THRESHOLDS` in [`src/config.ts`](src/config.ts).

---

## Architecture

```
src/
├── config.ts                 All tunables: model, camera, thresholds (+ UI schema), colours, gesture metadata
├── types.ts                  Landmark indices, finger chains, shared types
├── core/
│   ├── sources.ts            Webcam + image/video file sources, friendly CameraError mapping
│   └── detector.ts           MediaPipe HandLandmarker wrapper (local assets → CDN fallback, Auto GPU/CPU)
├── analysis/
│   ├── vec.ts                Vector math, angles, smoothstep, convex hull
│   ├── oneEuro.ts            One Euro filter for landmark smoothing
│   ├── handTracker.ts        Stable hand IDs, handedness voting, smoothing
│   └── handAnalyzer.ts       Palm size, finger bend/extension, fingertip contacts, orientation
├── gestures/
│   ├── staticGestures.ts     Per-frame soft scores for each gesture
│   └── gestureEngine.ts      Debounce/hysteresis, drag/hold/swipe state machines, contact events
├── control/pcController.ts   Hand → mouse: pointer mapping, pinch click/drag, right click, scroll, pause
├── events/eventBus.ts        Typed event bus (the integration point)
├── actions/actionMapper.ts   Gesture-event → named-action bindings (in-page demo actions)
├── render/
│   ├── skeletonRenderer.ts   Canvas overlay: outline, palm, bones, joints, contacts, labels, ripples
│   └── airCanvas.ts          Pinch-to-draw demo layer
├── ui/                       Left/right hand readouts, settings drawer, DOM helpers
├── app.ts                    Orchestrator: source → detect → track → analyse → gestures → render/UI
└── main.ts                   Entry point (exposes window.handGestures for debugging)
electron/
├── main.cjs                  Desktop window, app:// file serving, camera permission, Ctrl+Alt+H
├── preload.cjs               The only API the page gets: window.pcControl (move, click, scroll…)
└── input.cjs                 Windows mouse input via user32 (SetCursorPos, mouse_event); HG_DRY_RUN=1 logs instead
tests/                        Synthetic-hand unit tests (vitest)
scripts/                      Asset setup + end-to-end browser verification
```

Data flow per video frame:

```
FrameSource → HandDetector → HandTracker → HandAnalyzer → GestureEngine ─▶ EventBus ─┬▶ Dashboard
 (camera/file)  (MediaPipe)   (ids+smooth)  (fingers,       (gestures,                 ├▶ ActionMapper → actions
                                             contacts)       drags, swipes)            └▶ your code
SkeletonRenderer / AirCanvas draw the latest features on every animation frame.
```

---

## Extending it

### Add a gesture
1. Add an id to `GESTURE_IDS` in `src/types.ts`.
2. Add label/icon/description to `GESTURES` in `src/config.ts` (its position = priority).
3. Add a scoring rule in `computeStaticScores` (`src/gestures/staticGestures.ts`). The helper
   `patternScore(ext, [thumb, index, middle, ring, pinky])` takes `1` (extended), `0` (folded) or `null` (don't care).
4. Add a case to `tests/synthetic.ts` / `tests/gestures.test.ts`.

The debounce, events, hand readouts and picture tags pick it up automatically.

### React to gestures in code
```ts
const { app } = window.handGestures;          // or import the bus where you build the app
app.bus.on('drag:start', ({ x, y }) => console.log('pinch held at', x, y));
app.bus.on('gesture:hold', ({ gesture }) => { if (gesture === 'thumbs_up') doSomething(); });
app.bus.on('swipe', ({ direction }) => navigate(direction));
app.bus.on('pointer:move', ({ x, y }) => moveCursor(x, y));   // index fingertip, 0..1 display space
```

### Add more PC actions
Mouse actions go through `window.pcControl` (see `electron/preload.cjs`). To add one, for
example keyboard shortcuts, add a function to `electron/input.cjs` (Windows `keybd_event` or
`SendInput`), expose it in `preload.cjs`, and call it from `src/control/pcController.ts` on the
gesture event you want. Gesture events are listed in `src/events/eventBus.ts`.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Pointer is jittery or slow | **Settings → PC control → Pointer**: move left for steadier, right for snappier. Good, even lighting helps most. |
| Can't reach the screen edges | **Settings → PC control → Reach**: make the box smaller. |
| "Camera access was blocked" | Click the camera icon in the address bar → Allow, then *Start camera* again. |
| "The camera could not be started" | Another app (Teams, Zoom, OBS, another tab) is using it. Close it and retry. |
| "No camera was found" | Plug in a webcam, or choose **Use a photo or video** with a picture of a hand. |
| Top bar says "on CPU" after a while | *Automatic* detection found the GPU detector missing hands on your device and switched to the more sensitive CPU detector. Force one in Settings, or `?delegate=gpu` / `?delegate=cpu` in the URL. |
| Low FPS | Choose *GPU* and *Track one hand* in Settings, close other heavy tabs, improve lighting. |
| Left/right swapped | Your camera driver mirrors its output. Set `swapHandedness: true` in `src/config.ts`. |
| Gestures too eager / too strict | Open **Settings → Sensitivity**: e.g. raise *Touch distance* if touches don't register, raise *Stable for* to reduce flicker. |
| Model failed to load | Run `npm run setup` (needs internet once); afterwards everything is served locally. |

Debugging: `handGestures.snapshot()` in the browser console returns the current hands, finger
states, gesture scores, FPS and backend. URL options: `?source=<image-or-video-url>`, `?camera=1`, `?delegate=auto|gpu|cpu`.

---

## How it was verified

- `npm test`: 35 unit tests on a synthetic 3-D hand model: every gesture, the PC controller, hysteresis, size /
  distance / rotation invariance, pinch monotonicity, pinch at any rotation, drag, swipe, hand loss, duplicate-hand suppression.
- `npm run verify`: 11 end-to-end checks in real Edge: MediaPipe on real hand photos
  (peace, thumbs up, pointing, thumbs down all recognised), the full **webcam** path via Chromium's fake
  camera streaming a hand photo (camera starts → hand tracked → gesture recognised → events fire → stops cleanly),
  denied-permission error screen, and no uncaught page errors.
- `npm run verify:desktop` (and `-- --packaged` for the `.exe`): 10 checks with mouse control in
  dry-run mode: the app loads from its built files, the Windows input layer loads, a fake camera hand is
  tracked, turning control on moves the pointer, the peace sign right-clicks, no button is left pressed,
  and control turns off cleanly. The controller's click, drag, pause/resume and release-on-loss logic is
  unit-tested separately.

## Credits

- Hand landmark model & runtime: [Google MediaPipe](https://github.com/google-ai-edge/mediapipe) (Apache-2.0).
- Smoothing: Casiez, Roussel & Vogel, *1€ Filter* (CHI 2012).
