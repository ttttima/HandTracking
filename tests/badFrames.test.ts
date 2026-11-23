/**
 * A hand with a NaN coordinate from the model used to jam the mouse pointer in the middle of the
 * screen for good: the NaN got into the pointer filter, and the OS layer turned NaN into "centre".
 */
import { describe, expect, it } from 'vitest';
import { HandAnalyzer } from '../src/analysis/handAnalyzer';
import { HandTracker } from '../src/analysis/handTracker';
import { OneEuroFilter } from '../src/analysis/oneEuro';
import { DEFAULT_THRESHOLDS } from '../src/config';
import { PcController, type PcBridge } from '../src/control/pcController';
import { EventBus } from '../src/events/eventBus';
import { ASPECT, makeHand, type HandPose } from './synthetic';

const POINT: HandPose = { middle: [80, 100, 65], ring: [80, 100, 65], pinky: [80, 100, 65], thumbAbduction: 50 };

function rig() {
  const t = { ...DEFAULT_THRESHOLDS };
  const moves: { x: number; y: number }[] = [];
  const bridge: PcBridge = {
    move: (x, y) => moves.push({ x, y }), button() {}, click() {}, scroll() {}, releaseAll() {},
    minimizeActiveWindow() {}, toggleDesktop() {}, sendKeys() {}, openApp() {}, switchDesktop() {},
  };
  const ctl = new PcController(new EventBus(), bridge, t);
  ctl.start();
  const tracker = new HandTracker(t);
  const analyzer = new HandAnalyzer(t);
  let now = 0;
  const frame = (x: number, bad?: 'one' | 'all') => {
    now += 33;
    const raw = makeHand({ ...POINT, at: { x, y: 0.5 } });
    if (bad === 'one') raw.landmarks[9] = { x: NaN, y: NaN, z: NaN };
    if (bad === 'all') raw.landmarks = raw.landmarks.map(() => ({ x: NaN, y: Infinity, z: 0 }));
    const tracked = tracker.update({ hands: [raw], timestamp: now, inferenceMs: 5, width: 1280, height: 720 }, now);
    ctl.update(tracked.map((h) => analyzer.analyze(h, h.id, now, ASPECT)), true, now);
    return tracked;
  };
  return { frame, moves };
}

describe('bad frames from the hand model', () => {
  it('a NaN landmark never reaches the pointer, and it keeps following the hand afterwards', () => {
    const r = rig();
    for (let i = 0; i < 30; i++) r.frame(0.3);
    expect(r.frame(0.3, 'one')).toEqual([]); // the bad detection is dropped
    r.frame(0.3, 'all');
    const before = r.moves.at(-1)!;
    for (let i = 0; i < 40; i++) r.frame(0.3 + i * 0.008);
    expect(r.moves.every((m) => Number.isFinite(m.x) && Number.isFinite(m.y))).toBe(true);
    // Hand moved right in the picture = left on the mirrored screen, well away from where it was.
    expect(before.x - r.moves.at(-1)!.x).toBeGreaterThan(0.2);
  });

  it('the smoothing filter skips a bad sample instead of breaking', () => {
    const f = new OneEuroFilter(1, 0.1);
    f.filter(0.4, 0);
    expect(f.filter(NaN, 33)).toBeCloseTo(0.4);
    expect(f.filter(0.4, Infinity)).toBeCloseTo(0.4);
    expect(Number.isFinite(f.filter(0.5, 66))).toBe(true);
  });
});
