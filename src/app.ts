/**
 * Application orchestrator.
 *
 *   FrameSource ─▶ HandDetector ─▶ HandTracker ─▶ HandAnalyzer ─▶ GestureEngine ─▶ EventBus
 *   (camera/file)   (MediaPipe)     (ids+smooth)    (fingers,        (gestures,       │
 *                                                    contacts)        drags, swipes)  ├─▶ Dashboard
 *                                                                                     ├─▶ ActionMapper
 *   SkeletonRenderer / AirCanvas draw the latest features every animation frame.      └─▶ AirCanvas
 */
import { ActionMapper } from './actions/actionMapper';
import { HandAnalyzer } from './analysis/handAnalyzer';
import { HandTracker } from './analysis/handTracker';
import { loadEnabledGestures, loadThresholds } from './config';
import { loadSnapping } from './control/angleSnap';
import { BIND_TARGETS, keybinds, loadKeybinds } from './control/keybinds';

/** "hold a fist" style description of the gesture bound to turning control on / off, or null if none is. */
function pauseGesture(): string | null {
  const t = BIND_TARGETS.find((x) => keybinds[x.id].action === 'pause_control');
  if (!t) return null;
  const name = t.label.toLowerCase();
  return keybinds[t.id].trigger === 'held' ? `hold ${name === 'fist' ? 'a fist' : name}` : `show ${name}`;
}
import { KeybindsPanel } from './ui/keybindsPanel';
import { chime } from './ui/chime';
import { CursorBadge } from './control/cursorBadge';
import { ReachCalibrator, type FitResult } from './control/reachCalibration';
import { HandDetector, type Backend } from './core/detector';
import { CameraError, listCameras, openCamera, openMedia, type FrameSource } from './core/sources';
import { EventBus } from './events/eventBus';
import { GestureEngine } from './gestures/gestureEngine';
import { AirCanvas } from './render/airCanvas';
import { SkeletonRenderer } from './render/skeletonRenderer';
import type { HandFeatures, HandGestureState } from './types';
import { Dashboard } from './ui/dashboard';
import { $ } from './ui/dom';
import { SettingsPanel } from './ui/settingsPanel';
import { SwipeSlider } from './ui/swipeSlider';
import { PcController, type ControlOptions } from './control/pcController';

const CONTROL_STORAGE = 'handgestures.control.v1';

type Flag = 'skeleton' | 'outline' | 'gestures' | 'mirror' | 'smoothing' | 'ids' | 'air';

const FLAG_INPUTS: Record<Flag, string> = {
  skeleton: 'tg-skeleton',
  outline: 'tg-outline',
  gestures: 'tg-gestures',
  mirror: 'tg-mirror',
  smoothing: 'tg-smoothing',
  ids: 'tg-ids',
  air: 'tg-air',
};
const FLAG_KEYS: Record<string, Flag> = { s: 'skeleton', o: 'outline', g: 'gestures', m: 'mirror', f: 'smoothing', i: 'ids', d: 'air' };
const FLAGS_STORAGE = 'handgestures.flags.v1';
const DETECTOR_STORAGE = 'handgestures.detector.v1';

/** Strip USB vendor:product ids such as "(046d:0825)" from camera labels. */
const cleanLabel = (label: string) => label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)/i, '');

export class HandTrackingApp {
  readonly bus = new EventBus();
  readonly tracker = new HandTracker();
  readonly analyzer = new HandAnalyzer();
  readonly engine = new GestureEngine(this.bus);
  readonly actions = new ActionMapper(this.bus);
  readonly ui = new Dashboard();
  private settings = new SettingsPanel();
  private swipeSlider = new SwipeSlider();
  private renderer = new SkeletonRenderer($('overlay') as HTMLCanvasElement);
  private air = new AirCanvas($('air-canvas') as HTMLCanvasElement);
  /** Present only in the desktop app (Electron preload provides window.pcControl). */
  readonly control: PcController | null = window.pcControl ? new PcController(this.bus, window.pcControl) : null;
  /** Desktop app: the status badge next to the mouse pointer. */
  private badge: CursorBadge | null = window.pcControl ? new CursorBadge(this.bus, (s) => window.pcControl?.setOverlay(s)) : null;
  /** Reach calibration in progress (Settings → PC control → Calibrate reach). */
  private calib: ReachCalibrator | null = null;
  private calibDone: ((r: FitResult | null) => void) | null = null;
  private video = $('video') as HTMLVideoElement;
  private image = $('image') as HTMLImageElement;
  private stage = $('stage');
  private cameraBtn = $('btn-camera') as HTMLButtonElement;
  private cameraSelect = $('camera-select') as HTMLSelectElement;
  private backendSelect = $('backend-select') as HTMLSelectElement;
  private handsSelect = $('hands-select') as HTMLSelectElement;
  private backend: Backend = 'auto';
  private numHands = 2;

  private detector: HandDetector | null = null;
  private source: FrameSource | null = null;
  private starting = false;
  readonly flags: Record<Flag, boolean> = {
    skeleton: true, outline: true, gestures: true, mirror: true, smoothing: true, ids: false, air: false,
  };

  private hands: HandFeatures[] = [];
  private gestures = new Map<string, HandGestureState>();
  private lastVideoTime = -1;
  private lastImageDetect = 0;
  private frameCount = 0;
  /** Total frames analysed since start (diagnostics and tests). */
  framesProcessed = 0;
  private fps = 0;
  private fpsWindowStart = 0;
  private latency = 0;
  private detectErrors = 0;
  /** Exceptions thrown while analysing frames (any part after detection); see noteFrameError. */
  frameErrors = 0;
  /** Self-healing actions taken (diagnostics and tests). */
  readonly recoveries: { at: number; what: string }[] = [];
  private watch = { frames: -1, at: 0, step: 0, lastCameraRestart: -Infinity };
  private reconnects = 0;
  private cameraSince = 0;
  private frameSize = { w: 1280, h: 720 };
  private eventCount = 0;

  async init(): Promise<void> {
    loadThresholds();
    loadEnabledGestures();
    loadSnapping();
    loadKeybinds();
    this.settings.refresh();
    this.swipeSlider.refresh();
    this.restoreFlags();
    this.bindControls();
    this.bindEvents();
    this.registerDemoActions();
    this.setupControl();
    requestAnimationFrame(this.tick);

    const params = new URLSearchParams(location.search);
    this.restoreDetectorPrefs(params.get('delegate'));
    if (!(await this.loadDetector(true))) return;
    this.cameraBtn.disabled = false;
    this.showIdle();
    await this.refreshCameras();

    window.setInterval(this.watchdog, 1000);

    const src = params.get('source');
    const resume = (params.get('resume') ?? '').split(',');
    if (src) await this.loadMedia(src);
    else if (params.get('camera') === '1' || resume.includes('camera')) await this.startCamera();
    // The window was reloaded after the page crashed or hung: carry on where it was.
    if (resume.includes('control') && this.source && this.control && !this.control.isOn) this.control.start();
    if (resume.includes('camera')) this.ui.toast('The app recovered from a crash and carried on.', 'info', 5000);
  }

  // ── Long-run health ───────────────────────────────────────────────────

  /**
   * Once a second: if the camera is on but no frame has been analysed for a while, fix it in steps,
   * each only if the previous one did not help:
   *   3 s   restart the frame reader (the camera stream to the model)
   *   8 s   reopen the camera (at most once every 30 s)
   *   20 s  reload the hand model (on the CPU if the GPU one broke)
   */
  private watchdog = () => {
    const src = this.source;
    const now = performance.now();
    const w = this.watch;
    if (!src || src.kind !== 'camera' || !this.detector || this.starting) {
      w.frames = -1;
      w.step = 0;
      return;
    }
    if (this.framesProcessed !== w.frames) {
      w.frames = this.framesProcessed;
      w.at = now;
      w.step = 0;
      if (now - this.cameraSince > 60000) this.reconnects = 0; // ran fine for a minute
      return;
    }
    const stalled = now - w.at;
    if (w.step === 0 && stalled > 3000) {
      w.step = 1;
      this.recovered('restarted the camera reader (no frames for 3 s)');
      this.stopFrameReader();
      this.startFrameReader(src);
    } else if (w.step === 1 && stalled > 8000 && now - w.lastCameraRestart > 30000) {
      w.step = 2;
      w.lastCameraRestart = now;
      this.recovered('reopened the camera (no frames for 8 s)');
      void this.startCamera();
    } else if (w.step >= 1 && stalled > 20000 && w.step < 3) {
      w.step = 3;
      this.recovered('reloaded the hand model (no frames for 20 s)');
      void this.reloadDetector();
    }
  };

  private recovered(what: string) {
    console.warn(`[health] ${what}`);
    this.recoveries.push({ at: Date.now(), what });
    if (this.recoveries.length > 50) this.recoveries.shift();
  }

  /** A frame threw somewhere after detection. Never let one bad frame stop tracking. */
  private noteFrameError(err: unknown) {
    this.frameErrors++;
    if (this.frameErrors === 1 || this.frameErrors % 100 === 0) console.error(`[frame] error #${this.frameErrors}`, err);
    // Clear per-hand state in case it is what keeps failing.
    if (this.frameErrors % 10 === 0) {
      this.tracker.reset();
      this.engine.reset();
      this.control?.cancelPress();
    }
  }

  /** The model keeps failing (e.g. the GPU was reset): load it again, on the CPU if it was the GPU. */
  private async reloadDetector() {
    if (!this.detector) return;
    const prev = this.backend;
    if (this.detector.info.delegate === 'GPU') this.backend = 'cpu';
    try {
      await this.loadDetector();
    } finally {
      this.backend = prev; // only for this session; the saved choice is unchanged
    }
  }

  /** The camera track ended (unplugged, taken by another app, PC asleep): try to get it back. */
  private cameraLost(err: CameraError) {
    if (this.reconnects >= 5) {
      this.handleCameraError(err);
      return;
    }
    this.reconnects++;
    this.recovered(`camera ended, reconnecting (try ${this.reconnects})`);
    this.ui.toast('The camera stopped. Reconnecting…', 'info', 3000);
    this.stopFrameReader();
    window.setTimeout(() => { void this.startCamera(); }, 1500 * this.reconnects);
  }

  // ── Detector ──────────────────────────────────────────────────────────

  private restoreDetectorPrefs(param: string | null) {
    try {
      const saved = JSON.parse(localStorage.getItem(DETECTOR_STORAGE) ?? '{}');
      if (['auto', 'gpu', 'cpu'].includes(saved.backend)) this.backend = saved.backend;
      if (saved.numHands === 1 || saved.numHands === 2) this.numHands = saved.numHands;
    } catch { /* ignore */ }
    const forced = param?.toLowerCase();
    if (forced === 'auto' || forced === 'gpu' || forced === 'cpu') this.backend = forced;
    this.backendSelect.value = this.backend;
    this.handsSelect.value = String(this.numHands);
  }

  private saveDetectorPrefs() {
    try {
      localStorage.setItem(DETECTOR_STORAGE, JSON.stringify({ backend: this.backend, numHands: this.numHands }));
    } catch { /* ignore */ }
  }

  /** (Re)creates the detector with the current backend / hand-count settings. */
  private async loadDetector(initial = false): Promise<boolean> {
    const old = this.detector;
    this.detector = null; // pauses detection in the loop while loading
    old?.close();
    this.tracker.reset();
    this.engine.reset();
    this.ui.setStatus('loading', 'Loading the hand model');
    const showProgress = initial || !this.source;
    if (showProgress) {
      this.ui.setEmpty({ title: 'Loading the hand model', text: 'This takes a few seconds the first time.' });
    }
    try {
      this.detector = await HandDetector.create(this.backend, this.numHands, (msg) => {
        this.ui.setStatus('loading', msg);
        if (showProgress) this.ui.setEmpty({ title: 'Loading the hand model', text: msg });
      });
    } catch (err) {
      console.error(err);
      this.ui.setStatus('error', 'The hand model did not load');
      this.ui.setEmpty({
        title: 'The hand model did not load',
        text: `${(err as Error).message || err}. Run "npm run setup" to download the model locally, check your internet connection, then reload.`,
        error: true,
      });
      return false;
    }
    this.detector.onBackendSwitch = (info) => {
      this.ui.toast('Switched detection to the CPU, because the GPU kept missing hands on this computer.', 'info', 6000);
      void info;
      this.updateReadyStatus();
    };
    this.updateReadyStatus();
    if (!initial && !this.source) this.showIdle();
    return true;
  }

  private updateReadyStatus() {
    if (!this.detector) return;
    const { delegate, assets, backend } = this.detector.info;
    this.ui.setMetrics({ fps: this.fps, backend: delegate });
    if (this.source) {
      this.ui.setStatus('live', this.source.kind === 'camera' ? `Watching ${cleanLabel(this.source.label)}` : `Reading ${this.source.label}`);
    } else {
      this.ui.setStatus('ready', assets === 'cdn' ? 'Ready, using the online model' : 'Ready');
    }
    void backend;
  }

  // ── Sources ───────────────────────────────────────────────────────────

  async startCamera(): Promise<void> {
    if (this.starting || !this.detector) return;
    this.starting = true;
    this.stopSource();
    this.cameraBtn.disabled = true;
    this.ui.setStatus('loading', 'Starting the camera');
    this.ui.setEmpty({ title: 'Starting the camera', text: 'If your browser asks for permission, choose Allow.' });
    try {
      const src = await openCamera(this.video, this.cameraSelect.value || undefined);
      src.onEnded = (err) => this.cameraLost(err);
      this.cameraSince = performance.now();
      this.useSource(src);
      this.updateReadyStatus();
      await this.refreshCameras(); // labels become available after permission is granted
    } catch (err) {
      this.handleCameraError(err);
    } finally {
      this.starting = false;
      this.cameraBtn.disabled = false;
      this.syncCameraButton();
    }
  }

  stopCamera(): void {
    this.stopSource();
    this.ui.setStatus('ready', 'Camera off');
    this.showIdle();
  }

  async loadMedia(input: File | string): Promise<void> {
    if (!this.detector) return;
    this.stopSource();
    this.ui.setStatus('loading', 'Opening the file');
    try {
      const src = await openMedia(input, this.video, this.image);
      this.useSource(src);
      this.updateReadyStatus();
    } catch (err) {
      this.ui.setStatus('error', 'The file did not open');
      this.ui.toast((err as Error).message || String(err), 'error');
      this.showIdle();
    }
    this.syncCameraButton();
  }

  private useSource(src: FrameSource) {
    this.source = src;
    this.lastVideoTime = -1;
    this.frameSize = { w: src.width, h: src.height };
    this.stage.style.setProperty('--ar', String(src.width / Math.max(1, src.height)));
    document.getElementById('tune')?.style.setProperty('--ar', String(src.width / Math.max(1, src.height)));
    this.video.hidden = src.kind === 'image';
    this.image.hidden = src.kind !== 'image';
    this.ui.setEmpty(null);
    this.fpsWindowStart = performance.now();
    this.frameCount = 0;
    if (src.kind === 'camera') this.startFrameReader(src);
  }

  private stopSource() {
    this.stopFrameReader();
    this.control?.cancelPress();
    this.calibDone?.(null);
    this.badge?.hide();
    if (!this.source) return;
    this.source.stop();
    this.source = null;
    this.engine.reset();
    this.tracker.reset();
    this.hands = [];
    this.gestures.clear();
    this.renderer.clear();
    this.fps = 0;
    this.ui.renderEmptyPanels();
    this.ui.setMetrics({ fps: 0, backend: this.detector?.info.delegate ?? '–' });
    this.syncCameraButton();
  }

  private handleCameraError(err: unknown) {
    console.warn('[camera]', err);
    this.stopSource();
    const e = err instanceof CameraError ? err : new CameraError('unknown', String((err as Error)?.message ?? err));
    this.ui.setStatus('error', e.message);
    this.ui.setEmpty({ title: e.message, text: e.hint, error: true, camera: true, file: true });
    this.syncCameraButton();
  }

  private showIdle() {
    this.ui.setEmpty({
      title: 'Camera is off',
      text: 'Start the camera and hold your hand up, about 40–80 cm from the screen. Everything runs locally in your browser; no video leaves your machine.',
      camera: true,
      file: true,
    });
  }

  private async refreshCameras() {
    const cams = await listCameras();
    const current = this.cameraSelect.value;
    this.cameraSelect.innerHTML = '';
    if (!cams.length) {
      this.cameraSelect.append(new Option('Default camera', ''));
    }
    cams.forEach((c, i) => this.cameraSelect.append(new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
    const activeId = (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings().deviceId;
    const pick = activeId || current;
    if (pick && [...this.cameraSelect.options].some((o) => o.value === pick)) this.cameraSelect.value = pick;
  }

  /** Desktop app: tell the main process what is running, so it can resume after a crash. */
  private reportRunState() {
    window.pcControl?.reportState?.({ camera: this.source?.kind === 'camera', control: !!this.control?.isOn });
  }

  private syncCameraButton() {
    this.reportRunState();
    const on = this.source?.kind === 'camera';
    this.cameraBtn.classList.toggle('on', on);
    this.cameraBtn.querySelector('span')!.textContent = on ? 'Stop camera' : 'Start camera';
  }

  // ── Main loop ─────────────────────────────────────────────────────────

  private tick = (now: number) => {
    // Animation frames only drive drawing. (A minimised window gets none; the camera keeps
    // being analysed by the frame reader below, so mouse control keeps working.)
    if (document.hidden) window.setTimeout(() => this.tick(performance.now()), 16);
    else requestAnimationFrame(this.tick);
    const src = this.source;
    if (src && this.detector && !this.frameReader) {
      let fresh = false;
      if (src.kind === 'image') {
        fresh = now - this.lastImageDetect >= 33;
        if (fresh) this.lastImageDetect = now;
      } else {
        const v = src.element as HTMLVideoElement;
        if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = v.currentTime;
          fresh = true;
        }
      }
      if (fresh) {
        try { this.process(now); } catch (err) { this.noteFrameError(err); }
      }
    }

    const mirror = this.flags.mirror;
    this.renderer.draw(this.hands, this.gestures, {
      mirror,
      skeleton: this.flags.skeleton,
      outline: this.flags.outline,
      landmarkIds: this.flags.ids,
      gestureLabels: this.flags.gestures,
      hands: !this.flags.air,
      control: this.control?.isOn && !this.calib && !this.flags.air ? this.control.view : null,
      calibration: this.calib?.view ?? null,
    }, now);
    this.air.draw();
    if (this.tools.hidden === !!this.source) this.tools.hidden = !this.source;
    if (this.source) {
      this.ui.update({
        hands: this.hands,
        gestures: this.gestures,
        gesturesEnabled: this.flags.gestures,
        mirror,
        frameWidth: this.frameSize.w,
        frameHeight: this.frameSize.h,
      }, now);
    }
  };

  /**
   * Reads camera frames straight from the camera track (WebCodecs) and analyses each one as it
   * arrives. Unlike the on-screen <video>, this keeps the full frame rate while the window is
   * minimised or covered.
   */
  private frameReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  /** The reader works on a copy of the camera track; it must be stopped too, or the camera stays on. */
  private readerTrack: MediaStreamTrack | null = null;

  private startFrameReader(src: FrameSource) {
    const Processor = (window as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
    const stream = (src.element as HTMLVideoElement).srcObject as MediaStream | null;
    const track = stream?.getVideoTracks()[0];
    if (!Processor || !track) return; // falls back to the <video> + animation-frame path
    const copy = track.clone();
    // Keep only the newest frame: if analysis is ever slower than the camera, old frames are dropped
    // instead of queueing up (which would add delay and hold camera buffers).
    const reader = new Processor({ track: copy, maxBufferSize: 1 } as { track: MediaStreamTrack }).readable.getReader();
    this.frameReader = reader;
    this.readerTrack = copy;
    const pump = async () => {
      while (this.frameReader === reader) {
        let result: ReadableStreamReadResult<VideoFrame>;
        try {
          result = await reader.read();
        } catch {
          break;
        }
        if (result.done) break;
        const frame = result.value;
        try {
          if (this.detector && this.source === src) this.process(performance.now(), frame);
        } catch (err) {
          this.noteFrameError(err); // one bad frame never ends the loop
        } finally {
          frame.close();
        }
      }
      // The stream ended without being stopped: drop the reader so the on-screen video takes over,
      // and the watchdog starts a new reader.
      if (this.frameReader === reader) {
        this.frameReader = null;
        this.readerTrack?.stop();
        this.readerTrack = null;
      }
    };
    void pump();
  }

  private stopFrameReader() {
    const r = this.frameReader;
    this.frameReader = null;
    if (r) void r.cancel().catch(() => {});
    this.readerTrack?.stop();
    this.readerTrack = null;
  }

  private process(now: number, input?: VideoFrame) {
    const src = this.source!;
    let frame;
    try {
      frame = this.detector!.detect(input ?? src.element, now);
      this.detectErrors = 0;
    } catch (err) {
      if (++this.detectErrors === 30) {
        console.error('[detector]', err);
        this.recovered(`reloading the hand model after repeated errors: ${(err as Error).message ?? err}`);
        void this.reloadDetector();
      }
      return;
    }
    this.frameSize = { w: frame.width, h: frame.height };
    const aspect = frame.width / Math.max(1, frame.height);

    this.tracker.smoothing = this.flags.smoothing;
    const tracked = this.tracker.update(frame, now);
    this.hands = tracked.map((t) => this.analyzer.analyze(t, t.id, now, aspect));

    this.engine.options.aspect = aspect;
    this.engine.options.mirror = this.flags.mirror;
    this.gestures = new Map();
    if (this.flags.gestures) {
      const states = this.engine.update(this.hands, now);
      this.hands.forEach((h, i) => this.gestures.set(h.id, states[i]));
    }
    this.air.update(this.hands, this.flags.mirror, aspect, now);
    this.control?.update(this.hands, this.flags.mirror, now);
    if (this.control && this.badge) {
      if (this.calib || this.flags.air) this.badge.hide(); // calibrating or drawing: control is held
      else this.badge.update(this.control.view, this.control.view.state, this.gestures, pauseGesture());
    }
    if (this.calib) {
      const result = this.calib.feed(this.hands, this.flags.mirror, now);
      this.showCalibration();
      if (result) this.calibDone?.(result);
    }

    // Metrics.
    this.latency = this.latency ? this.latency * 0.9 + frame.inferenceMs * 0.1 : frame.inferenceMs;
    this.frameCount++;
    this.framesProcessed++;
    const elapsed = now - this.fpsWindowStart;
    if (elapsed >= 500) {
      this.fps = (this.frameCount * 1000) / elapsed;
      this.frameCount = 0;
      this.fpsWindowStart = now;
      this.ui.setMetrics({ fps: this.fps, backend: this.detector!.info.delegate });
    }
  }

  // ── Controls ──────────────────────────────────────────────────────────

  private setFlag(flag: Flag, value: boolean) {
    this.flags[flag] = value;
    ($(FLAG_INPUTS[flag]) as HTMLInputElement).checked = value;
    if (flag === 'mirror') {
      this.stage.classList.toggle('mirror', value);
      this.ui.setMirror(value);
    }
    if (flag === 'air') {
      this.air.enabled = value;
      const btn = $('btn-draw');
      btn.setAttribute('aria-pressed', String(value));
      btn.textContent = value ? 'Stop drawing' : 'Draw';
      $('btn-draw-clear').hidden = !value;
      this.applySuspend();
      this.describeControl();
    }
    if (flag === 'gestures' && !value) {
      this.engine.reset();
      this.gestures.clear();
    }
    try {
      localStorage.setItem(FLAGS_STORAGE, JSON.stringify(this.flags));
    } catch { /* ignore */ }
  }

  private restoreFlags() {
    let saved: Partial<Record<Flag, boolean>> = {};
    try {
      saved = JSON.parse(localStorage.getItem(FLAGS_STORAGE) ?? '{}');
    } catch { /* ignore */ }
    for (const f of Object.keys(this.flags) as Flag[]) {
      this.setFlag(f, f === 'air' ? false : typeof saved[f] === 'boolean' ? saved[f]! : this.flags[f]);
    }
  }

  /** PC control holds still while calibrating or drawing (pinching to draw must not click). */
  private applySuspend() {
    if (this.control) this.control.suspended = !!this.calib || this.flags.air;
  }

  private tools = $('stage-tools');

  private bindControls() {
    $('btn-draw').addEventListener('click', () => this.setFlag('air', !this.flags.air));
    $('btn-draw-clear').addEventListener('click', () => this.air.clear());
    this.cameraBtn.addEventListener('click', () => (this.source?.kind === 'camera' ? this.stopCamera() : this.startCamera()));
    $('btn-empty-camera').addEventListener('click', () => this.startCamera());
    this.cameraSelect.addEventListener('change', () => { if (this.source?.kind === 'camera') this.startCamera(); });
    this.backendSelect.addEventListener('change', async () => {
      this.backend = this.backendSelect.value as Backend;
      this.saveDetectorPrefs();
      this.backendSelect.disabled = true;
      await this.loadDetector();
      this.backendSelect.disabled = false;
    });
    this.handsSelect.addEventListener('change', async () => {
      this.numHands = Number(this.handsSelect.value);
      this.saveDetectorPrefs();
      await this.detector?.setNumHands(this.numHands);
    });

    const fileInput = $('file-input') as HTMLInputElement;
    const pick = () => fileInput.click();
    $('btn-file').addEventListener('click', pick);
    $('btn-empty-file').addEventListener('click', pick);
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) this.loadMedia(f);
      fileInput.value = '';
    });

    for (const [flag, id] of Object.entries(FLAG_INPUTS) as [Flag, string][]) {
      $(id).addEventListener('change', (e) => this.setFlag(flag, (e.target as HTMLInputElement).checked));
    }

    // Keyboard shortcuts: C camera, S skeleton, O outline, G signs, M mirror, F smoothing, I point numbers, D air draw.
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, select, textarea')) return;
      const k = e.key.toLowerCase();
      if (k === 'c' && !this.cameraBtn.disabled) this.cameraBtn.click();
      else if (FLAG_KEYS[k]) this.setFlag(FLAG_KEYS[k], !this.flags[FLAG_KEYS[k]]);
    });

    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.refreshCameras());
  }

  private bindEvents() {
    this.bus.onAny(() => { this.eventCount++; });
    this.bus.on('hand:lost', ({ hand }) => this.analyzer.forget(hand));
  }

  /**
   * In-page demo handlers: quiet visual feedback on the picture only. Replace or extend these
   * to control real applications (see actions/actionMapper.ts and the README).
   */
  private registerDemoActions() {
    const a = this.actions;
    const ripple = (big: boolean) => (p: unknown) => {
      const { x, y } = p as { x: number; y: number };
      this.renderer.addRipple(x, y, '#ebe7e1', big);
    };
    a.register('pointer.dragStart', ripple(false));
    a.register('canvas.clear', () => {
      if (this.air.enabled) this.air.clear();
    });
  }

  /** Compact state for debugging / automated tests (exposed as window.handGestures.snapshot()). */
  // ── PC control (desktop app only) ─────────────────────────────────────

  private setupControl() {
    const bridge = window.pcControl;
    const ctl = this.control;
    if (!bridge || !ctl) return;
    const btn = $('btn-control') as HTMLButtonElement;
    btn.hidden = false;
    $('set-control').hidden = false;
    $('btn-keybinds').hidden = false;
    new KeybindsPanel();
    // Settings → Saved settings: where the file is.
    $('set-file').hidden = false;
    void bridge.settingsFile.path().then((p) => { $('settings-file-path').textContent = p; });
    $('btn-settings-file').addEventListener('click', () => bridge.settingsFile.reveal());

    try {
      Object.assign(ctl.options, JSON.parse(localStorage.getItem(CONTROL_STORAGE) ?? '{}') as Partial<ControlOptions>);
    } catch { /* ignore */ }
    const save = () => {
      try { localStorage.setItem(CONTROL_STORAGE, JSON.stringify(ctl.options)); } catch { /* ignore */ }
    };

    const handSel = $('control-hand') as HTMLSelectElement;
    const margin = $('control-margin') as HTMLInputElement;
    const smooth = $('control-smoothing') as HTMLInputElement;
    const onTop = $('control-ontop') as HTMLInputElement;
    const screensSel = $('control-screens') as HTMLSelectElement;
    const applyScreens = () => bridge.setScreens(ctl.options.screens).then((area) => {
      if (area.width > 0 && area.height > 0) {
        ctl.screenAspect = area.width / area.height;
        ctl.screenWidth = area.width;
      }
    }).catch(() => {});
    screensSel.value = ctl.options.screens;
    screensSel.addEventListener('change', () => { ctl.options.screens = screensSel.value === 'all' ? 'all' : 'primary'; save(); void applyScreens(); });
    void applyScreens();
    const calibrated = $('btn-calibrate-reset') as HTMLButtonElement;
    const showValues = () => {
      const box = ctl.options.box;
      calibrated.hidden = !box;
      $('control-margin-out').textContent = box
        ? `Calibrated, ${Math.round((box.x1 - box.x0) * 100)}% × ${Math.round((box.y1 - box.y0) * 100)}% of the picture`
        : `${Math.round((1 - 2 * ctl.options.margin) * 100)}% of the picture`;
      $('control-smoothing-out').textContent = ctl.options.smoothing <= 0.8 ? 'Steady' : ctl.options.smoothing >= 2.5 ? 'Snappy' : 'Balanced';
    };
    handSel.value = ctl.options.hand;
    margin.value = String(ctl.options.margin);
    smooth.value = String(ctl.options.smoothing);
    showValues();
    handSel.addEventListener('change', () => { ctl.options.hand = handSel.value as ControlOptions['hand']; save(); this.describeControl(); });
    // Moving the slider goes back to a centred box.
    margin.addEventListener('input', () => { ctl.options.margin = Number(margin.value); ctl.options.box = null; showValues(); save(); });
    calibrated.addEventListener('click', () => { ctl.options.box = null; showValues(); save(); });
    $('btn-calibrate').addEventListener('click', () => this.calibrateReach(() => { showValues(); save(); }));
    $('btn-calib-cancel').addEventListener('click', () => this.calibDone?.(null));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.calib) this.calibDone?.(null); });
    const badgeBox = $('control-overlay') as HTMLInputElement;
    badgeBox.checked = ctl.options.badge !== false;
    if (this.badge) this.badge.enabled = badgeBox.checked;
    badgeBox.addEventListener('change', () => { ctl.options.badge = badgeBox.checked; if (this.badge) this.badge.enabled = badgeBox.checked; save(); });
    smooth.addEventListener('input', () => { ctl.options.smoothing = Number(smooth.value); showValues(); save(); });
    onTop.addEventListener('change', () => bridge.setAlwaysOnTop(onTop.checked));

    btn.addEventListener('click', () => ctl.toggle());
    bridge.onToggle(() => ctl.toggle());
    ctl.onChange = (_view, reason) => {
      this.reportRunState();
      if (reason === 'Started' || reason === 'Resumed') chime(true);
      else if (reason === 'Paused' || reason === 'Stopped') chime(false);
      if (reason === 'Started') {
        const pause = pauseGesture();
        this.ui.toast(`Your ${ctl.options.hand.toLowerCase()} hand now moves the mouse. ${pause ? `To turn it off, ${pause}. ` : ''}Press ${this.controlShortcut} to stop.`, 'info', 6000);
      }
      this.describeControl(reason);
    };
    bridge.info().then((info) => {
      this.controlShortcut = info.shortcut;
      void applyScreens();
      $('control-shortcut').textContent = info.shortcut;
      if (!info.available) {
        btn.disabled = true;
        btn.title = info.error ?? 'Mouse control is not available on this computer.';
      }
      if (info.dryRun) btn.title = 'Test mode: mouse actions are logged, not performed.';
    }).catch(() => {});
  }

  private controlShortcut = 'Ctrl+Alt+H';

  /** Settings → Calibrate reach: sweep the mouse hand over a comfortable area; it then covers the screen. */
  private calibrateReach(saved: () => void) {
    const ctl = this.control;
    if (!ctl || this.calib) return;
    if (this.source?.kind !== 'camera') {
      this.ui.toast('Start the camera first, then calibrate.', 'error');
      return;
    }
    this.settings.toggle(false);
    const handName = `${ctl.options.hand.toLowerCase()} hand`;
    this.calib = new ReachCalibrator(ctl.options.hand);
    this.applySuspend(); // nothing moves or clicks while you sweep
    $('calib').hidden = false;
    this.calibDone = (result) => {
      this.calib = null;
      this.calibDone = null;
      this.applySuspend();
      $('calib').hidden = true;
      if (!result) return;
      if (result.ok) {
        ctl.options.box = result.box;
        saved();
        this.ui.toast(`Reach calibrated. The box on the picture is the area that now covers your screen.`, 'info', 5000);
      } else if (result.reason === 'few') {
        this.ui.toast(`Your ${handName} was not seen long enough. Keep it in the picture and try again.`, 'error', 6000);
      } else {
        this.ui.toast('That area is too small to aim precisely. Move your hand over a larger area and try again.', 'error', 6000);
      }
    };
    this.calibHand = handName;
    this.showCalibration();
  }

  private calibHand = 'right hand';

  private showCalibration() {
    const v = this.calib?.view;
    if (!v) return;
    $('calib-title').textContent = v.phase === 'ready' ? `Get ready… ${v.secondsLeft}` : `Sweep your hand… ${v.secondsLeft}`;
    $('calib-text').textContent = !v.handSeen
      ? `Show your ${this.calibHand} to the camera.`
      : v.phase === 'ready'
        ? `Hold up your ${this.calibHand}, the one that moves the mouse.`
        : 'Move it slowly over the whole area you want to use, corners included, without stretching.';
    ($('calib-bar').style.width = `${Math.round(v.progress * 100)}%`);
  }

  private describeControl(reason = '') {
    const ctl = this.control;
    if (!ctl) return;
    const btn = $('btn-control') as HTMLButtonElement;
    const on = ctl.isOn;
    btn.classList.toggle('on', on);
    btn.textContent = on ? 'Stop control' : 'Control my PC';
    const hand = `${ctl.options.hand.toLowerCase()} hand`;
    const line = $('control-line');
    line.hidden = !on;
    if (!on) return;
    const v = ctl.view;
    line.dataset.state = v.state;
    const what = v.state === 'paused'
      ? `Off for now. ${pauseGesture() ? `To turn it back on, ${pauseGesture()}.` : `Press ${this.controlShortcut} to stop.`}`
      : this.flags.air ? 'Drawing: the mouse is held until you press Stop drawing.' : `Your ${hand} moves the mouse.`;
    line.textContent = reason && !['Started', 'Resumed', 'Paused'].includes(reason) ? `${what} Last action: ${reason.toLowerCase()}.` : what;
  }

  snapshot() {
    return {
      frameErrors: this.frameErrors,
      recoveries: this.recoveries.slice(-10),
      ready: !!this.detector,
      backend: this.detector?.info ?? null,
      source: this.source ? { kind: this.source.kind, label: this.source.label, width: this.frameSize.w, height: this.frameSize.h } : null,
      fps: Math.round(this.fps * 10) / 10,
      inferenceMs: Math.round(this.latency * 10) / 10,
      eventCount: this.eventCount,
      control: this.control ? { ...this.control.view } : null,
      status: $('status-text').textContent,
      hands: this.hands.map((h) => {
        const g = this.gestures.get(h.id);
        return {
          id: h.id,
          handedness: h.handedness,
          score: Math.round(h.score * 1000) / 1000,
          extended: Object.fromEntries(Object.entries(h.fingers).map(([k, f]) => [k, f.extended])),
          extension: Object.fromEntries(Object.entries(h.fingers).map(([k, f]) => [k, Math.round(f.extension * 100) / 100])),
          pinchDistance: Math.round(h.pinchDistance * 1000) / 1000,
          touching: h.contacts.filter((c) => c.state === 'touching').map((c) => c.key),
          primary: g?.primary ?? null,
          active: g?.active ?? [],
          topScores: g
            ? Object.entries(g.scores).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k}:${v.toFixed(2)}`)
            : [],
          wrist: { x: Math.round(h.image[0].x * 1000) / 1000, y: Math.round(h.image[0].y * 1000) / 1000 },
        };
      }),
    };
  }
}
