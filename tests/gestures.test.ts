import { describe, expect, it } from 'vitest';
import { HandAnalyzer } from '../src/analysis/handAnalyzer';
import { DEFAULT_THRESHOLDS, GESTURE_PRIORITY } from '../src/config';
import { computeStaticScores } from '../src/gestures/staticGestures';
import { FINGERS, type StaticGestureId } from '../src/types';
import { ASPECT, POSES, makeHand, type HandPose } from './synthetic';

const t = { ...DEFAULT_THRESHOLDS };

function analyze(pose: HandPose) {
  return new HandAnalyzer(t).analyze(makeHand(pose), 'Right', 0, ASPECT);
}

function topGesture(pose: HandPose): { winner: StaticGestureId | null; scores: Record<StaticGestureId, number> } {
  const scores = computeStaticScores(analyze(pose), { aspect: ASPECT }, t);
  const winner = GESTURE_PRIORITY.find((g) => scores[g] >= t.gestureOn) ?? null;
  return { winner, scores };
}

describe('finger state', () => {
  it('open palm → all five fingers extended', () => {
    const h = analyze(POSES.open_palm);
    expect(FINGERS.map((f) => h.fingers[f].extended)).toEqual([true, true, true, true, true]);
    expect(h.extendedCount).toBe(5);
  });

  it('fist → all five fingers folded', () => {
    const h = analyze(POSES.fist);
    expect(FINGERS.map((f) => h.fingers[f].extended)).toEqual([false, false, false, false, false]);
  });

  it('peace → only index & middle extended', () => {
    const h = analyze(POSES.peace);
    expect(FINGERS.filter((f) => h.fingers[f].extended)).toEqual(['index', 'middle']);
  });

  it('finger states have hysteresis (no flicker around the threshold)', () => {
    const a = new HandAnalyzer(t);
    // PIP bend sweeps into the fold zone, then back into the hysteresis band (~85°–95°), then out.
    const seq = [40, 80, 105, 92, 88, 65];
    const states = seq.map((b) => a.analyze(makeHand({ index: [0, b, 0] }), 'R', 0, ASPECT).fingers.index.extended);
    // Inside the band the previous state is kept, so the finger stays folded until clearly straight.
    expect(states).toEqual([true, true, false, false, false, true]);
  });

  it('detects palm vs back facing the camera', () => {
    expect(analyze(POSES.open_palm).palmFacing).toBe(true);
    const back = makeHand(POSES.open_palm);
    back.worldLandmarks = back.worldLandmarks.map((p) => ({ x: -p.x, y: p.y, z: -p.z })); // rotate 180° about y
    expect(new HandAnalyzer(t).analyze(back, 'R', 0, ASPECT).palmFacing).toBe(false);
  });
});

describe('static gestures', () => {
  for (const name of Object.keys(POSES) as StaticGestureId[]) {
    it(`recognises ${name}`, () => {
      const { winner, scores } = topGesture(POSES[name]);
      expect(winner, JSON.stringify(scores)).toBe(name);
    });
  }

  it('does not report pinch for a fist (thumb near curled index)', () => {
    expect(topGesture(POSES.fist).scores.pinch).toBeLessThan(t.gestureOn);
  });


  it('is invariant to hand size, distance from camera, position and rotation', () => {
    const variants: HandPose[] = [
      { size: 0.75 },
      { size: 1.3 },
      { imageScale: 1.2, at: { x: 0.2, y: 0.7 } },
      { imageScale: 6 },
      { roll: 35 },
      { roll: -50 },
    ];
    for (const name of ['open_palm', 'fist', 'peace', 'pinch', 'pointing'] as StaticGestureId[]) {
      for (const v of variants) {
        if (v.roll !== undefined && POSES[name].roll !== undefined) continue;
        expect(topGesture({ ...POSES[name], ...v }).winner, `${name} ${JSON.stringify(v)}`).toBe(name);
      }
    }
  });

  it('pinch strength grows continuously as thumb approaches index', () => {
    const offsets = [0.06, 0.04, 0.025, 0.012, 0.004];
    const scores = offsets.map(
      (o) => topGesture({ ...POSES.pinch, thumbTouchIndex: { x: o, y: o * 0.5, z: 0 } }).scores.pinch,
    );
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    expect(scores[0]).toBeLessThan(0.3);
    expect(scores[scores.length - 1]).toBeGreaterThan(0.9);
  });
});

describe('hand de-duplication', () => {
  it('merges two overlapping detections of the same hand, keeps two real hands', async () => {
    const { dedupeHands } = await import('../src/analysis/handTracker');
    const a = makeHand({ ...POSES.peace, at: { x: 0.6, y: 0.5 } });
    const dup = { ...makeHand({ ...POSES.pointing, at: { x: 0.605, y: 0.51 } }), score: 0.7 };
    const other = { ...makeHand({ ...POSES.open_palm, at: { x: 0.3, y: 0.5 } }), handedness: 'Left' as const };
    expect(dedupeHands([a, dup], ASPECT)).toEqual([a]);
    expect(dedupeHands([dup, a, other], ASPECT)).toEqual([a, other]);
  });
});

describe('pinch at any rotation', () => {
  it('thumb–index together is a pinch whether or not the ring faces the camera', () => {
    const ring = { index: [35, 55, 35] as [number, number, number], thumbTouchIndex: { x: 0.006, y: 0.004, z: 0 } };
    for (const yaw of [0, 45, 70, -60]) expect(topGesture({ ...ring, yaw }).winner, `yaw ${yaw}`).toBe('pinch');
  });
});

describe('pinch is never a fist', () => {
  it('a pinch with a curled index does not score as a fist', () => {
    expect(topGesture(POSES.pinch).scores.fist).toBeLessThan(t.gestureOff);
  });
});

describe('key combos', () => {
  it('normalises and validates shortcuts', async () => {
    const { normalizeCombo } = await import('../src/control/keybinds');
    expect(normalizeCombo('ctrl + shift + t')).toBe('Ctrl+Shift+T');
    expect(normalizeCombo('win+d')).toBe('Win+D');
    expect(normalizeCombo('Shift+Control+Escape')).toBe('Ctrl+Shift+Esc');
    expect(normalizeCombo('alt+f4')).toBe('Alt+F4');
    expect(normalizeCombo('playpause')).toBe('MediaPlayPause');
    expect(normalizeCombo('Ctrl+Bogus')).toBeNull();
    expect(normalizeCombo('A+B')).toBeNull();
    expect(normalizeCombo('')).toBeNull();
  });
});
