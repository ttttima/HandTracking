/**
 * Reach calibration: you sweep the hand that moves the mouse over the area you find comfortable,
 * and that area (not a fixed centred box) becomes the part of the picture that covers the screen.
 *
 *   1. Get ready   (READY_MS)  a short countdown so you can bring your hand up
 *   2. Sweep       (SWEEP_MS)  every frame's knuckle position is collected
 *   3. Fit         the 3rd–97th percentile on each axis (a stray frame does not stretch the box),
 *                  pulled in a little so the screen edges are reachable without a full stretch
 */
import { assignHands } from '../ui/dashboard';
import type { HandFeatures, Handedness } from '../types';
import { pointerAnchor, type ReachBox } from './pcController';

export const READY_MS = 2000;
export const SWEEP_MS = 6000;
/** Smallest box (fraction of the picture per side) that still gives usable precision. */
export const MIN_SPAN = 0.12;
/** Pull each edge in by this share of the swept size. */
const INSET = 0.04;
const LOW_PCT = 0.03;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

export type FitResult = { ok: true; box: ReachBox } | { ok: false; reason: 'few' | 'small' };

/** Fit the reach box to the swept positions (display space). */
export function fitReach(points: { x: number; y: number }[], mirror: boolean): FitResult {
  if (points.length < 20) return { ok: false, reason: 'few' };
  const xs = points.map((p) => p.x).sort((a, b) => a - b);
  const ys = points.map((p) => p.y).sort((a, b) => a - b);
  let x0 = percentile(xs, LOW_PCT), x1 = percentile(xs, 1 - LOW_PCT);
  let y0 = percentile(ys, LOW_PCT), y1 = percentile(ys, 1 - LOW_PCT);
  if (x1 - x0 < MIN_SPAN || y1 - y0 < MIN_SPAN) return { ok: false, reason: 'small' };
  const ix = (x1 - x0) * INSET, iy = (y1 - y0) * INSET;
  x0 += ix; x1 -= ix; y0 += iy; y1 -= iy;
  const r = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  return { ok: true, box: { x0: r(x0), y0: r(y0), x1: r(x1), y1: r(y1), mirror } };
}

export type CalibrationPhase = 'ready' | 'sweep';

export interface CalibrationView {
  phase: CalibrationPhase;
  /** 0..1 through the current phase. */
  progress: number;
  secondsLeft: number;
  points: { x: number; y: number }[];
  /** Box from the points so far (for drawing while you sweep). */
  rect: { x0: number; y0: number; x1: number; y1: number } | null;
  handSeen: boolean;
}

/** Runs one calibration: feed it every analysed frame until it reports a result. */
export class ReachCalibrator {
  private startedAt = -1;
  private points: { x: number; y: number }[] = [];
  private handSeen = false;
  private now = 0;

  constructor(private hand: Handedness) {}

  /** Returns a result once the sweep is over, else null. */
  feed(hands: HandFeatures[], mirror: boolean, now: number): FitResult | null {
    if (this.startedAt < 0) this.startedAt = now;
    this.now = now;
    const h = assignHands(hands)[this.hand];
    this.handSeen = !!h;
    const t = now - this.startedAt;
    if (t < READY_MS) return null;
    if (h) {
      const k = pointerAnchor(h.rawImage ?? h.image);
      this.points.push({ x: mirror ? 1 - k.x : k.x, y: k.y });
    }
    if (t < READY_MS + SWEEP_MS) return null;
    return fitReach(this.points, mirror);
  }

  get view(): CalibrationView {
    const t = this.startedAt < 0 ? 0 : this.now - this.startedAt;
    const sweeping = t >= READY_MS;
    const total = sweeping ? SWEEP_MS : READY_MS;
    const elapsed = sweeping ? t - READY_MS : t;
    let rect: CalibrationView['rect'] = null;
    if (this.points.length >= 2) {
      const xs = this.points.map((p) => p.x), ys = this.points.map((p) => p.y);
      rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
    return {
      phase: sweeping ? 'sweep' : 'ready',
      progress: Math.min(1, elapsed / total),
      secondsLeft: Math.max(0, Math.ceil((total - elapsed) / 1000)),
      points: this.points,
      rect,
      handSeen: this.handSeen,
    };
  }
}
