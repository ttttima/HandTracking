import { describe, expect, it } from 'vitest';
import { AngleSnapper, snapAngle, snapping } from '../src/control/angleSnap';
import { PcController, type PcBridge } from '../src/control/pcController';
import { HandAnalyzer } from '../src/analysis/handAnalyzer';
import { DEFAULT_THRESHOLDS } from '../src/config';
import { EventBus } from '../src/events/eventBus';
import { GestureEngine } from '../src/gestures/gestureEngine';
import { ASPECT, makeHand } from './synthetic';

const deg = (rad: number) => (rad * 180) / Math.PI;

describe('snapAngle', () => {
  it('rounds to the nearest increment', () => {
    expect(snapAngle(37, 45)).toBe(45);
    expect(snapAngle(52, 45)).toBe(45);
    expect(snapAngle(68, 45)).toBe(90);
    expect(snapAngle(-20, 45)).toBe(-0);
    expect(snapAngle(100, 90)).toBe(90);
    expect(snapAngle(22, 15)).toBe(15);
    expect(snapAngle(23, 15)).toBe(30);
  });
});

describe('AngleSnapper', () => {
  /** Move from (x0,y0) by (dx,dy) in `steps` frames and return the snapped path. */
  function stroke(sn: AngleSnapper, x0: number, y0: number, dx: number, dy: number, aspect = 1, inc = 45, steps = 20) {
    const out: { x: number; y: number }[] = [];
    let t = 0;
    for (let i = 0; i <= steps; i++) out.push(sn.snap(x0 + (dx * i) / steps, y0 + (dy * i) / steps, (t += 33), aspect, inc));
    return out;
  }

  it('turns a 37° movement into an exact 45° line', () => {
    const path = stroke(new AngleSnapper(), 0.2, 0.2, 0.3 * Math.cos((37 * Math.PI) / 180), 0.3 * Math.sin((37 * Math.PI) / 180));
    const end = path[path.length - 1];
    expect(deg(Math.atan2(end.y - 0.2, end.x - 0.2))).toBeCloseTo(45, 6);
    // every point lies on that line
    for (const p of path.slice(1)) expect(Math.abs(p.y - 0.2 - (p.x - 0.2))).toBeLessThan(1e-9);
  });

  it('a nearly horizontal movement becomes perfectly horizontal', () => {
    const path = stroke(new AngleSnapper(), 0.1, 0.5, 0.5, 0.04);
    for (const p of path) expect(p.y).toBeCloseTo(0.5, 9);
  });

  it('measures true angles on a wide screen', () => {
    // On a 16:9 screen a true 45° line moves the same number of pixels across as down.
    const aspect = 16 / 9;
    const path = stroke(new AngleSnapper(), 0.2, 0.2, 0.2, 0.2 * aspect * 0.85, aspect);
    const end = path[path.length - 1];
    const pixelAngle = deg(Math.atan2(end.y - 0.2, (end.x - 0.2) * aspect));
    expect(pixelAngle).toBeCloseTo(45, 6);
  });

  it('holding still starts a new segment (turning a corner)', () => {
    const sn = new AngleSnapper();
    let t = 0;
    // Move right…
    for (let i = 0; i <= 10; i++) sn.snap(0.2 + i * 0.02, 0.5, (t += 33), 1, 45);
    // …pause…
    for (let i = 0; i < 10; i++) sn.snap(0.4, 0.5, (t += 33), 1, 45);
    // …then move down: snaps to 90°, starting from the corner.
    let p = { x: 0, y: 0 };
    for (let i = 1; i <= 10; i++) p = sn.snap(0.4 + i * 0.002, 0.5 + i * 0.02, (t += 33), 1, 45);
    expect(p.x).toBeCloseTo(0.4, 6);
    expect(p.y).toBeGreaterThan(0.65);
  });
});

describe('PC control with angle snapping', () => {
  it('pointer moves along a straight snapped line', () => {
    const bus = new EventBus();
    const t = { ...DEFAULT_THRESHOLDS };
    const engine = new GestureEngine(bus, t);
    engine.options.aspect = ASPECT;
    const analyzer = new HandAnalyzer(t);
    const moves: { x: number; y: number }[] = [];
    const bridge: PcBridge = {
      move: (x, y) => moves.push({ x, y }),
      button: () => {}, click: () => {}, scroll: () => {}, releaseAll: () => {},
      minimizeActiveWindow: () => {}, toggleDesktop: () => {}, sendKeys: () => {}, openApp: () => {},
      switchDesktop: () => {},
    };
    const ctl = new PcController(bus, bridge, t);
    ctl.screenAspect = 1;
    snapping.enabled = true;
    snapping.increment = 90;
    try {
      ctl.start();
      let now = 1000;
      // Hand drifts diagonally but mostly sideways: with 90° snapping the pointer must stay level.
      for (let i = 0; i <= 40; i++) {
        now += 33;
        const hands = [analyzer.analyze(makeHand({ at: { x: 0.65 - i * 0.008, y: 0.5 + i * 0.002 } }), 'Right', now, ASPECT)];
        engine.update(hands, now);
        ctl.update(hands, true, now);
      }
      const ys = moves.slice(3).map((m) => m.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-9);
      expect(moves[moves.length - 1].x).toBeGreaterThan(moves[3].x + 0.2);
    } finally {
      snapping.enabled = false;
      snapping.increment = 45;
    }
  });
});
