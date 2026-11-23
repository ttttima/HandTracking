import { describe, expect, it } from 'vitest';
import { HandAnalyzer } from '../src/analysis/handAnalyzer';
import { DEFAULT_THRESHOLDS } from '../src/config';
import { CursorBadge, type BadgeState } from '../src/control/cursorBadge';
import { keybinds, resetKeybinds } from '../src/control/keybinds';
import { PcController, pointerAnchor, reachRect, type PcBridge } from '../src/control/pcController';
import { READY_MS, ReachCalibrator, SWEEP_MS, fitReach } from '../src/control/reachCalibration';
import { EventBus } from '../src/events/eventBus';
import { GestureEngine } from '../src/gestures/gestureEngine';
import type { HandGestureState, StaticGestureId } from '../src/types';
import { ASPECT, POSES, makeHand, type HandPose } from './synthetic';

const FRAME = 1000 / 30;
const POINT: HandPose = { middle: [80, 100, 65], ring: [80, 100, 65], pinky: [80, 100, 65], thumbAbduction: 50 };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

describe('fitting the reach box', () => {
  it('covers the swept area, ignores stray frames and pulls the edges in a little', () => {
    const r = rng(3);
    const pts = Array.from({ length: 300 }, () => ({ x: 0.3 + r() * 0.4, y: 0.25 + r() * 0.35 }));
    pts.push({ x: 0.98, y: 0.02 }, { x: 0.01, y: 0.99 }); // two tracking glitches
    const fit = fitReach(pts, true);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    const b = fit.box;
    expect(b.x0).toBeGreaterThan(0.3); expect(b.x0).toBeLessThan(0.34);
    expect(b.x1).toBeLessThan(0.7); expect(b.x1).toBeGreaterThan(0.66);
    expect(b.y0).toBeGreaterThan(0.25); expect(b.y1).toBeLessThan(0.6);
    expect(b.mirror).toBe(true);
  });

  it('refuses a hand that barely moved, or too few frames', () => {
    const still = Array.from({ length: 100 }, (_, i) => ({ x: 0.5 + (i % 5) * 0.01, y: 0.5 }));
    expect(fitReach(still, true)).toEqual({ ok: false, reason: 'small' });
    expect(fitReach(still.slice(0, 5), true)).toEqual({ ok: false, reason: 'few' });
  });

  it('flips with the mirror setting, and falls back to the slider box', () => {
    const o = { margin: 0.2, box: { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.7, mirror: true } };
    expect(reachRect(o, true)).toEqual({ x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.7 });
    const flipped = reachRect(o, false);
    expect(flipped.x0).toBeCloseTo(0.5); expect(flipped.x1).toBeCloseTo(0.9);
    expect(reachRect({ margin: 0.2, box: null }, true)).toEqual({ x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 });
  });
});

function rig() {
  const t = { ...DEFAULT_THRESHOLDS };
  const bus = new EventBus();
  const engine = new GestureEngine(bus, t);
  engine.options.aspect = ASPECT;
  const analyzer = new HandAnalyzer(t);
  const moves: { x: number; y: number }[] = [];
  const calls: string[] = [];
  const bridge: PcBridge = {
    move: (x, y) => { moves.push({ x, y }); },
    button: (b, d) => calls.push(`${b}:${d}`), click: (b) => calls.push(`click:${b}`), scroll: () => calls.push('scroll'),
    releaseAll: () => {}, minimizeActiveWindow: () => calls.push('minimize'), toggleDesktop: () => {}, sendKeys: () => {},
    openApp: () => {}, switchDesktop: () => {},
  };
  const ctl = new PcController(bus, bridge, t);
  ctl.screenAspect = 16 / 9;
  let now = 1000;
  const play = (pose: HandPose, ms: number, at = { x: 0.5, y: 0.5 }) => {
    const end = now + ms;
    while (now < end) {
      now += FRAME;
      const hands = [analyzer.analyze(makeHand({ ...pose, at }), 'Right', now, ASPECT)];
      engine.update(hands, now);
      ctl.update(hands, true, now);
    }
    return hands0(at);
  };
  const hands0 = (at: { x: number; y: number }) => pointerAnchor(makeHand({ ...POINT, at }).landmarks);
  return { t, ctl, play, moves, calls };
}

describe('calibrated reach in the controller', () => {
  it('the calibrated box edges are the screen edges', () => {
    const r = rig();
    const k = pointerAnchor(makeHand({ ...POINT, at: { x: 0.5, y: 0.5 } }).landmarks);
    const ax = 1 - k.x; // mirrored, as shown
    // Box whose left edge is exactly where the hand is, and whose bottom edge too.
    r.ctl.options.box = { x0: ax, y0: k.y - 0.3, x1: ax + 0.3, y1: k.y, mirror: true };
    r.ctl.start();
    r.play(POINT, 1500);
    const last = r.moves.at(-1)!;
    expect(last.x).toBeLessThan(0.01);
    expect(last.y).toBeGreaterThan(0.99);
  });

  it('while suspended (calibrating) nothing moves, clicks or fires', () => {
    const r = rig();
    r.ctl.start();
    r.play(POINT, 500);
    const before = r.moves.length;
    r.ctl.suspended = true;
    r.play(POINT, 300, { x: 0.3, y: 0.4 });
    r.play(POSES.middle_finger, 800);
    expect(r.moves.length).toBe(before);
    expect(r.calls).toEqual([]);
    r.ctl.suspended = false;
    r.play(POINT, 500, { x: 0.3, y: 0.4 });
    expect(r.moves.length).toBeGreaterThan(before);
  });
});

describe('calibration run', () => {
  it('waits, then collects the sweep and fits it', () => {
    const t = { ...DEFAULT_THRESHOLDS };
    const analyzer = new HandAnalyzer(t);
    const cal = new ReachCalibrator('Right');
    let now = 0, result = null;
    for (; now <= READY_MS + SWEEP_MS + 100 && !result; now += FRAME) {
      // A slow zig-zag over x 0.35–0.65, y 0.3–0.6 of the picture.
      const p = now / 1000;
      const at = { x: 0.5 + 0.15 * Math.sin(p * 2.1), y: 0.45 + 0.15 * Math.sin(p * 3.3) };
      result = cal.feed([analyzer.analyze(makeHand({ ...POINT, at }), 'Right', now, ASPECT)], true, now);
      if (now < READY_MS) expect(cal.view.phase).toBe('ready');
    }
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    const b = result.box;
    expect(b.x1 - b.x0).toBeGreaterThan(0.2);
    expect(b.y1 - b.y0).toBeGreaterThan(0.2);
  });
});

describe('pointer badge', () => {
  const gs = (primary: StaticGestureId | null, heldMs = 0): Map<string, HandGestureState> =>
    new Map([['h', { handId: 'h', handedness: 'Right', scores: {} as HandGestureState['scores'], active: primary ? [primary] : [], primary, primaryHeldMs: heldMs, pinchPhase: 'idle' }]]);
  const view = (over: Partial<Parameters<CursorBadge['update']>[0] & object> = {}) => ({
    state: 'active' as const, hand: 'Right' as const, margin: 0.2, rect: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }, pinch: 0, anchor: null, dragging: false, ...over,
  });
  const setup = () => {
    const sent: BadgeState[] = [];
    let now = 0;
    const badge = new CursorBadge(new EventBus(), (s) => sent.push(s), () => now);
    return { badge, sent, last: () => sent.at(-1)!, tick: (ms: number) => { now += ms; } };
  };

  it('shows a bound sign and what it does, nothing for unbound signs', () => {
    resetKeybinds();
    const b = setup();
    b.badge.update(view(), 'active', gs('peace'), null);
    expect(b.last()).toMatchObject({ show: true, title: 'Peace', detail: 'Right click', progress: -1 });
    b.badge.update(view(), 'active', gs('thumbs_up'), null);
    expect(b.last().show).toBe(false);
  });

  it('fills the ring while a pinch becomes a drag, then says Dragging', () => {
    const b = setup();
    b.badge.update(view({ pinch: 0.5 }), 'active', gs(null), null);
    expect(b.last()).toMatchObject({ title: 'Pinch', progress: 0.5 });
    b.badge.update(view({ pinch: 1, dragging: true }), 'active', gs(null), null);
    expect(b.last()).toMatchObject({ title: 'Dragging', tone: 'drag', progress: 1 });
  });

  it('shows the on/off sign filling up even while control is stopped, then flashes the new state', () => {
    resetKeybinds();
    const b = setup();
    b.badge.update(null, 'off', gs('fist', DEFAULT_THRESHOLDS.holdMs / 2), 'hold a fist');
    expect(b.last()).toMatchObject({ show: true, title: 'Fist', detail: 'Hold to turn control on', progress: 0.5 });
    b.badge.update(view(), 'active', gs('fist', DEFAULT_THRESHOLDS.holdMs + 50), 'hold a fist');
    expect(b.last()).toMatchObject({ title: 'Control on', tone: 'on' });
    b.tick(2000);
    b.badge.update(view(), 'paused', gs(null), 'hold a fist');
    expect(b.last()).toMatchObject({ title: 'Control off', detail: 'To turn it on, hold a fist' });
    b.tick(2000);
    b.badge.update(view({ state: 'paused' }), 'paused', gs('peace'), 'hold a fist');
    expect(b.last().show).toBe(false); // other signs do nothing while off, so they are not shown
  });

  it('can be switched off, and sends only changes', () => {
    const b = setup();
    b.badge.update(view(), 'active', gs('peace'), null);
    b.badge.update(view(), 'active', gs('peace'), null);
    expect(b.sent.length).toBe(1);
    b.badge.enabled = false;
    b.badge.update(view(), 'active', gs('peace'), null);
    expect(b.last().show).toBe(false);
    expect(keybinds.peace.action).toBe('right_click');
  });
});
