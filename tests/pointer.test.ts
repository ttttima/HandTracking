/**
 * Pointer quality: jitter when the hand is still and lag when it moves, through the real
 * pipeline (tracker smoothing → analyser → controller), with landmark noise like MediaPipe's.
 */
import { describe, expect, it } from 'vitest';
import { HandAnalyzer } from '../src/analysis/handAnalyzer';
import { HandTracker } from '../src/analysis/handTracker';
import { DEFAULT_THRESHOLDS } from '../src/config';
import { PcController, pointerAnchor, type PcBridge } from '../src/control/pcController';
import { EventBus } from '../src/events/eventBus';
import { ASPECT, makeHand, type HandPose } from './synthetic';

const SCREEN_W = 2560;
const FPS = 30;
const POINT: HandPose = { middle: [80, 100, 65], ring: [80, 100, 65], pinky: [80, 100, 65], thumbAbduction: 50 };

/** Deterministic Gaussian noise. */
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

export function run(path: (tMs: number) => number, ms: number, noise = 0.0018) {
  const t = { ...DEFAULT_THRESHOLDS };
  const bus = new EventBus();
  const tracker = new HandTracker(t);
  const analyzer = new HandAnalyzer(t);
  const out: { t: number; x: number }[] = [];
  let now = 0;
  const bridge: PcBridge = {
    move: (x) => out.push({ t: now, x: x * SCREEN_W }),
    button: () => {}, click: () => {}, scroll: () => {}, releaseAll: () => {}, minimizeActiveWindow: () => {},
    toggleDesktop: () => {}, sendKeys: () => {}, openApp: () => {}, switchDesktop: () => {},
  };
  const ctl = new PcController(bus, bridge, t);
  ctl.screenAspect = 1;
  ctl.start();
  const g = rng(7);
  for (now = 0; now < ms; now += 1000 / FPS) {
    const raw = makeHand({ ...POINT, at: { x: path(now), y: 0.5 } });
    raw.landmarks = raw.landmarks.map((p) => ({ x: p.x + g() * noise, y: p.y + g() * noise * ASPECT, z: p.z }));
    const tracked = tracker.update({ hands: [raw], timestamp: now, inferenceMs: 10, width: 1280, height: 720 }, now);
    const hands = tracked.map((h) => analyzer.analyze(h, h.id, now, ASPECT));
    ctl.update(hands, true, now);
  }
  return out;
}

/** Pointer value at time t (last move sent at or before t). */
export const at = (out: { t: number; x: number }[], t: number) => {
  let v = out[0].x;
  for (const p of out) { if (p.t > t) break; v = p.x; }
  return v;
};

/** Where the pointer should be for a hand at image x (mirrored view, default reach). */
function truth(handX: number): number {
  const k = pointerAnchor(makeHand({ ...POINT, at: { x: handX, y: 0.5 } }).landmarks);
  const u = (1 - k.x - 0.2) / 0.6;
  return Math.min(1, Math.max(0, u)) * SCREEN_W;
}

function sweepLag(speedPerS: number, span = 0.3) {
  // Hold, then sweep at a steady speed; lag = how far behind the true position, in ms.
  const t0 = 1000, x0 = 0.62;
  const dur = (span / speedPerS) * 1000;
  const path = (tm: number) => (tm < t0 ? x0 : x0 - Math.min(span, ((tm - t0) / 1000) * speedPerS));
  const out = run(path, t0 + dur + 1200, 0);
  const lags: number[] = [];
  for (let tm = t0 + dur * 0.4; tm <= t0 + dur * 0.95; tm += 1000 / FPS) {
    const v = (truth(path(tm + 1)) - truth(path(tm - 1))) / 2; // px per ms
    lags.push((truth(path(tm)) - at(out, tm)) / v);
  }
  // After the hand stops: time until the pointer is within 2 px of where it should be.
  const end = truth(path(t0 + dur));
  let settle = -1;
  for (let tm = t0 + dur; tm < t0 + dur + 1200; tm += 1000 / FPS) {
    if (Math.abs(at(out, tm) - end) <= 2) { settle = tm - (t0 + dur); break; }
  }
  return { lagMs: Math.round(lags.reduce((a, b) => a + b, 0) / lags.length), settleMs: Math.round(settle) };
}

export function measure() {
  // Still hand: spread of the pointer (px) after it settles.
  const still = run(() => 0.5, 4000);
  let lo = Infinity, hi = -Infinity, n = 0, sum = 0, sum2 = 0;
  for (let tm = 1500; tm < 4000; tm += 1000 / FPS) {
    const x = at(still, tm);
    lo = Math.min(lo, x); hi = Math.max(hi, x); n++; sum += x; sum2 += x * x;
  }
  const jitterSd = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
  return {
    jitterSd: +jitterSd.toFixed(2),
    jitterRange: +(hi - lo).toFixed(1),
    fine: sweepLag(0.015, 0.05),
    slow: sweepLag(0.08),
    medium: sweepLag(0.25),
    fast: sweepLag(0.8),
  };
}

describe('pointer quality', () => {
  it('is steady when the hand is still and keeps up when it moves', () => {
    const m = measure();
    console.log('pointer', JSON.stringify(m));
    // Before the rewrite (pointer from the smoothed landmarks, filtered again): jitter 1.06 px SD,
    // lag 89 / 62 / 47 ms (slow / medium / fast), 167–300 ms to settle after stopping.
    expect(m.jitterSd).toBeLessThan(0.7);
    expect(m.jitterRange).toBeLessThan(3);
    expect(m.fine.lagMs).toBeLessThan(80);
    for (const s of [m.slow, m.medium, m.fast]) expect(s.lagMs).toBeLessThan(30);
    for (const s of [m.fine, m.slow, m.medium, m.fast]) {
      expect(s.settleMs).toBeGreaterThanOrEqual(0);
      expect(s.settleMs).toBeLessThan(200);
    }
  });
});
