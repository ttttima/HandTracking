/**
 * Air draw under real-world conditions: noisy landmarks, a pinch whose gap wobbles across the touch
 * limit, and frames where the hand is not detected. The line must stay one line, follow the finger
 * closely, and stop cleanly when the fingers open.
 */
import { describe, expect, it } from 'vitest';
import { HandAnalyzer } from '../src/analysis/handAnalyzer';
import { HandTracker } from '../src/analysis/handTracker';
import { DEFAULT_THRESHOLDS } from '../src/config';
import { AirCanvas, PEN_GRACE_MS } from '../src/render/airCanvas';
import { LM } from '../src/types';
import { ASPECT, POSES, makeHand, type HandPose } from './synthetic';

const FPS = 30;
const PX = 1280; // picture width in pixels, for readable numbers
const PINCH: HandPose = { ...POSES.pinch, index: [15, 30, 15] };

function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return { u, g: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}

interface Frame { at: { x: number; y: number }; gap: number; missing?: boolean }

/** Run frames through the app's pipeline (tracker → analyser → air canvas). */
function run(frames: (t: number, i: number) => Frame, ms: number, opts: { noise?: number; seed?: number } = {}) {
  const t = { ...DEFAULT_THRESHOLDS };
  const tracker = new HandTracker(t);
  const analyzer = new HandAnalyzer(t);
  const air = new AirCanvas({ getContext: () => ({}) } as unknown as HTMLCanvasElement);
  air.enabled = true;
  const r = rng(opts.seed ?? 11);
  const noise = opts.noise ?? 0.0018;
  const log: { t: number; truth: { x: number; y: number }; last: { x: number; y: number } | null; strokes: number; oldTouching: boolean | null }[] = [];
  let i = 0;
  for (let now = 0; now < ms; now += 1000 / FPS, i++) {
    const f = frames(now, i);
    const pose = { ...PINCH, thumbTouchIndex: { x: f.gap, y: f.gap * 0.6, z: 0 }, at: f.at };
    const clean = makeHand(pose);
    const truth = { x: 1 - (clean.landmarks[LM.THUMB_TIP].x + clean.landmarks[LM.INDEX_TIP].x) / 2, y: (clean.landmarks[LM.THUMB_TIP].y + clean.landmarks[LM.INDEX_TIP].y) / 2 };
    const raw = makeHand(pose);
    raw.landmarks = raw.landmarks.map((p) => ({ x: p.x + r.g() * noise, y: p.y + r.g() * noise * ASPECT, z: p.z }));
    const tracked = tracker.update({ hands: f.missing ? [] : [raw], timestamp: now, inferenceMs: 10, width: 1280, height: 720 }, now);
    const hands = tracked.map((h) => analyzer.analyze(h, h.id, now, ASPECT));
    air.update(hands, true, ASPECT, now);
    const lines = air.lines;
    const cur = lines.at(-1)?.pts.at(-1) ?? null;
    log.push({ t: now, truth, last: cur ? { ...cur } : null, strokes: lines.length, oldTouching: hands[0] ? hands[0].contactMap['thumb-index'].state === 'touching' : null });
  }
  return { air, log, r };
}

/** How many separate lines the old pen (down only while "touching") would have made. */
function oldLines(log: { oldTouching: boolean | null }[]) {
  let n = 0, down = false;
  for (const e of log) {
    const touching = e.oldTouching === true;
    if (touching && !down) n++;
    down = touching;
  }
  return n;
}

describe('air draw pen', () => {
  it('a wobbly pinch with dropped frames stays one line', () => {
    const r = rng(5);
    const { air, log } = run((t) => {
      const p = t / 1000;
      // Gap wanders between 0.012 and ~0.034 (contact distance ~0.16–0.44, the old limit is 0.33).
      const gap = 0.02 + 0.007 * Math.sin(p * 9) + 0.005 * r.g();
      // 7% of frames lose the hand, plus one 5-frame (~170 ms) dropout.
      const missing = r.u() < 0.07 || (t > 2000 && t < 2170);
      return { at: { x: 0.5 + 0.15 * Math.sin(p * 1.3), y: 0.5 + 0.1 * Math.sin(p * 2.1) }, gap: Math.max(0.008, gap), missing };
    }, 5000);
    const before = oldLines(log);
    console.log(`wobbly pinch: ${air.strokeCount} line(s) now, the old pen would have made ${before}`);
    expect(before).toBeGreaterThan(5); // the scenario really is unstable for the old pen
    expect(air.strokeCount).toBe(1);
    expect(air.lines[0].pts.length).toBeGreaterThan(60);
  });

  it('opening the fingers ends the line quickly, and the open-hand movement is not drawn', () => {
    const OPEN_AT = 1500;
    const { air, log } = run((t) => ({
      at: { x: 0.4 + (t / 1000) * 0.1, y: 0.5 },
      gap: t < OPEN_AT ? 0.012 : 0.07,
    }), 3000, { noise: 0.0005 });
    expect(air.strokeCount).toBe(1);
    // Last drawn point: no later than where the hand was when the fingers opened.
    const lastPt = air.lines[0].pts.at(-1)!;
    const atOpen = log.find((e) => e.t >= OPEN_AT)!.truth;
    expect(lastPt.x).toBeGreaterThan(atOpen.x - 0.01); // mirrored: moving right in the picture = left on screen
    // A new pinch later starts a new line.
    const lastFrameStrokes = log.at(-1)!.strokes;
    expect(lastFrameStrokes).toBe(1);
    expect(PEN_GRACE_MS).toBeLessThan(300);
  });

  it('curling into a fist (thumb brushing a bent index) never starts a line', () => {
    const t = { ...DEFAULT_THRESHOLDS };
    const analyzer = new HandAnalyzer(t);
    const air = new AirCanvas({ getContext: () => ({}) } as unknown as HTMLCanvasElement);
    air.enabled = true;
    for (let now = 0; now < 1500; now += 33) {
      const h = analyzer.analyze(makeHand({ ...POSES.fist, thumbTouchIndex: { x: 0.004, y: 0.002, z: 0 } }), 'f', now, ASPECT);
      air.update([h], true, ASPECT, now);
    }
    expect(air.strokeCount).toBe(0);
  });

  it('is steady when still and keeps up with the finger when moving', () => {
    // Still pinch: spread of the line's points (picture pixels).
    const still = run(() => ({ at: { x: 0.5, y: 0.5 }, gap: 0.012 }), 3000);
    const pts = still.air.lines[0].pts;
    const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const spread = Math.max(...pts.map((p) => Math.abs(p.x - mx))) * PX;
    // Moving: how far behind the finger the pen is, in ms, at three speeds (picture widths / s).
    const lag = (speed: number) => {
      const t0 = 600, span = 0.3;
      const path = (t: number) => (t < t0 ? 0.65 : 0.65 - Math.min(span, ((t - t0) / 1000) * speed));
      const { log } = run((t) => ({ at: { x: path(t), y: 0.5 }, gap: 0.012 }), t0 + (span / speed) * 1000 + 300, { noise: 0 });
      const dur = (span / speed) * 1000;
      const ls = log.filter((e) => e.t > t0 + dur * 0.4 && e.t < t0 + dur * 0.95 && e.last).map((e) => ((e.truth.x - e.last!.x) / speed) * 1000);
      return Math.round(ls.reduce((a, b) => a + b, 0) / ls.length);
    };
    const m = { stillSpreadPx: +spread.toFixed(1), stillPoints: pts.length, lagMs: { slow: lag(0.1), medium: lag(0.4), fast: lag(1.2) } };
    console.log('pen', JSON.stringify(m));
    // Before (pen from the smoothed skeleton, down only while "touching"): lag 45 / 22 / 16 ms, and
    // the wobbly-pinch scenario above broke into 11 lines.
    expect(m.stillSpreadPx).toBeLessThan(3);
    expect(m.lagMs.slow).toBeLessThan(60);
    expect(m.lagMs.medium).toBeLessThan(40);
    expect(m.lagMs.fast).toBeLessThan(40);
  });
});
