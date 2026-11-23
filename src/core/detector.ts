/**
 * Thin wrapper around MediaPipe Tasks Vision HandLandmarker.
 *
 * - Prefers locally served assets (see scripts/setup-assets.mjs), falling back to the CDN.
 * - Backend "auto" starts on the fast GPU (WebGL) delegate. On some GPUs/drivers the GPU palm
 *   detector is noticeably less sensitive than the CPU (XNNPACK) one, so while the GPU sees no
 *   hand, a CPU "probe" occasionally double-checks the same frame. If the CPU repeatedly finds
 *   hands the GPU missed, the detector switches to CPU for the rest of the session.
 */
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { MODEL_CONFIG } from '../config';
import type { DetectionFrame, Handedness, RawHand } from '../types';

export type Backend = 'auto' | 'gpu' | 'cpu';
type Delegate = 'GPU' | 'CPU';
type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

/** True if `url` is served as a real asset (Vite's SPA fallback answers missing files with HTML). */
async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.ok && !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

export interface DetectorInfo {
  backend: Backend;
  delegate: Delegate;
  assets: 'local' | 'cdn';
  /** Set when "auto" fell back from GPU to CPU at runtime. */
  switchedReason?: string;
}

interface Instance {
  lm: HandLandmarker;
  lastTs: number;
}

export class HandDetector {
  private primary: Instance;
  private probe: Instance | null = null;
  private probeLoading = false;
  private lastProbeAt = 0;
  private probeHits = 0;
  private noHandSince = -1;
  private numHands: number = MODEL_CONFIG.numHands;
  /** Called when "auto" switches GPU → CPU. */
  onBackendSwitch?: (info: DetectorInfo) => void;

  private constructor(
    private fileset: WasmFileset,
    private modelPath: string,
    lm: HandLandmarker,
    readonly info: DetectorInfo,
  ) {
    this.primary = { lm, lastTs: -1 };
  }

  static async create(
    backend: Backend = 'auto',
    numHands: number = MODEL_CONFIG.numHands,
    onProgress: (msg: string) => void = () => {},
  ): Promise<HandDetector> {
    onProgress('Locating model files…');
    const localWasm = await assetExists(`${MODEL_CONFIG.wasmPath}/vision_wasm_internal.wasm`);
    const localModel = await assetExists(MODEL_CONFIG.modelPath);
    const wasmPath = localWasm ? MODEL_CONFIG.wasmPath : MODEL_CONFIG.wasmFallback;
    const modelPath = localModel ? MODEL_CONFIG.modelPath : MODEL_CONFIG.modelFallback;

    onProgress('Loading WebAssembly runtime…');
    const fileset = await FilesetResolver.forVisionTasks(wasmPath);

    onProgress('Loading hand landmark model…');
    let delegate: Delegate = backend === 'cpu' ? 'CPU' : 'GPU';
    let lm: HandLandmarker;
    try {
      lm = await HandDetector.make(fileset, modelPath, delegate, numHands);
    } catch (err) {
      if (delegate !== 'GPU') throw err;
      console.warn('[detector] GPU delegate unavailable, using CPU:', err);
      delegate = 'CPU';
      lm = await HandDetector.make(fileset, modelPath, 'CPU', numHands);
    }
    const det = new HandDetector(fileset, modelPath, lm, {
      backend,
      delegate,
      assets: localWasm && localModel ? 'local' : 'cdn',
    });
    det.numHands = numHands;
    return det;
  }

  private static make(fileset: WasmFileset, modelPath: string, delegate: Delegate, numHands: number) {
    return HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate },
      runningMode: 'VIDEO',
      numHands,
      minHandDetectionConfidence: MODEL_CONFIG.minHandDetectionConfidence,
      minHandPresenceConfidence: MODEL_CONFIG.minHandPresenceConfidence,
      minTrackingConfidence: MODEL_CONFIG.minTrackingConfidence,
    });
  }

  async setNumHands(n: number): Promise<void> {
    this.numHands = n;
    await this.primary.lm.setOptions({ numHands: n });
    await this.probe?.lm.setOptions({ numHands: n });
  }

  private run(inst: Instance, source: TexImageSource, now: number): HandLandmarkerResult {
    // MediaPipe requires strictly increasing timestamps per graph in VIDEO mode.
    const ts = Math.max(now, inst.lastTs + 1);
    inst.lastTs = ts;
    return inst.lm.detectForVideo(source, ts);
  }

  detect(source: HTMLVideoElement | HTMLImageElement | VideoFrame, now: number): DetectionFrame {
    const t0 = performance.now();
    let res = this.run(this.primary, source, now);

    if (this.info.backend === 'auto' && this.info.delegate === 'GPU') {
      res = this.maybeProbe(res, source, now);
    }

    const inferenceMs = performance.now() - t0;
    const hands: RawHand[] = res.landmarks.map((lm, i) => {
      const cat = res.handedness?.[i]?.[0];
      const label = (cat?.categoryName === 'Left' ? 'Left' : 'Right') as Handedness;
      return {
        landmarks: lm.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        worldLandmarks: (res.worldLandmarks?.[i] ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z })),
        handedness: MODEL_CONFIG.swapHandedness ? (label === 'Left' ? 'Right' : 'Left') : label,
        score: cat?.score ?? 0,
      };
    });

    const w = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : source.displayWidth;
    const h = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : source.displayHeight;
    return { hands, timestamp: now, inferenceMs, width: w, height: h };
  }

  /** "auto" mode: while the GPU sees nothing, let the CPU double-check about once a second. */
  private maybeProbe(gpuRes: HandLandmarkerResult, source: TexImageSource, now: number): HandLandmarkerResult {
    // Also double-check when the GPU sees fewer hands than we track (it may miss the second one).
    if (gpuRes.landmarks.length >= this.numHands) {
      this.noHandSince = -1;
      return gpuRes;
    }
    if (this.noHandSince < 0) this.noHandSince = now;
    if (now - this.noHandSince < 600 || now - this.lastProbeAt < 1000) return gpuRes;

    if (!this.probe) {
      if (!this.probeLoading) {
        this.probeLoading = true;
        HandDetector.make(this.fileset, this.modelPath, 'CPU', this.numHands)
          .then((lm) => { this.probe = { lm, lastTs: -1 }; })
          .catch((err) => console.warn('[detector] CPU probe unavailable:', err));
      }
      return gpuRes;
    }

    this.lastProbeAt = now;
    const cpuRes = this.run(this.probe, source, now);
    if (cpuRes.landmarks.length <= gpuRes.landmarks.length) {
      this.probeHits = Math.max(0, this.probeHits - 1);
      return gpuRes;
    }
    if (++this.probeHits >= 2) this.switchToCpu();
    return cpuRes;
  }

  private switchToCpu() {
    const old = this.primary;
    this.primary = this.probe!;
    this.probe = null;
    this.info.delegate = 'CPU';
    this.info.switchedReason = 'The GPU detector kept missing hands that the CPU detector found on this device.';
    console.info('[detector] auto backend switched GPU → CPU');
    queueMicrotask(() => old.lm.close());
    this.onBackendSwitch?.(this.info);
  }

  close(): void {
    this.primary.lm.close();
    this.probe?.lm.close();
  }
}
