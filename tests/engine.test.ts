import { describe, expect, it } from 'vitest';
import { HandAnalyzer } from '../src/analysis/handAnalyzer';
import { DEFAULT_THRESHOLDS } from '../src/config';
import { EventBus, type AppEventName } from '../src/events/eventBus';
import { GestureEngine } from '../src/gestures/gestureEngine';
import { ASPECT, POSES, makeHand, type HandPose } from './synthetic';

const FRAME = 1000 / 30;

function rig() {
  const t = { ...DEFAULT_THRESHOLDS };
  const bus = new EventBus();
  const engine = new GestureEngine(bus, t);
  engine.options.aspect = ASPECT;
  const analyzer = new HandAnalyzer(t);
  const events: { name: AppEventName; payload: any; at: number }[] = [];
  let now = 0;
  bus.onAny((name, payload) => {
    if (name !== 'pointer:move' && name !== 'drag:move') events.push({ name, payload, at: now });
  });
  /** Feed `ms` worth of frames of a pose. */
  const play = (pose: HandPose | null, ms: number) => {
    const end = now + ms;
    while (now < end) {
      now += FRAME;
      const hands = pose ? [analyzer.analyze(makeHand(pose), 'Right', now, ASPECT)] : [];
      engine.update(hands, now);
    }
  };
  const names = () => events.map((e) => (e.name.startsWith('gesture') ? `${e.name}:${e.payload.gesture}` : e.name));
  return { t, play, events, names, engine };
}

const OPEN_PINCH: HandPose = { ...POSES.pinch, thumbTouchIndex: { x: 0.05, y: 0.025, z: 0 } };

describe('gesture engine', () => {
  it('debounces: a single-frame blip does not activate a gesture', () => {
    const r = rig();
    r.play(POSES.open_palm, 300);
    r.play(POSES.fist, FRAME); // one frame
    r.play(POSES.open_palm, 300);
    expect(r.names()).not.toContain('gesture:start:fist');
  });

  it('emits start/end and a hold event after holdMs', () => {
    const r = rig();
    r.play(POSES.peace, r.t.holdMs + 200);
    r.play(POSES.open_palm, 400);
    const n = r.names();
    expect(n).toContain('gesture:start:peace');
    expect(n).toContain('gesture:hold:peace');
    expect(n).toContain('gesture:end:peace');
    expect(n.filter((x) => x === 'gesture:hold:peace')).toHaveLength(1);
  });




  it('long thumb–index touch becomes a drag', () => {
    const r = rig();
    r.play(OPEN_PINCH, 300);
    r.play(POSES.pinch, r.t.dragHoldMs + 300);
    r.play(OPEN_PINCH, 200);
    const n = r.names();
    expect(n).toContain('drag:start');
    expect(n).toContain('drag:end');
  });

  it('detects swipes with an open hand (mirrored display)', () => {
    const r = rig();
    // Move the palm from image x=0.7 to x=0.2 over ~250 ms. Mirrored → user sees it move right.
    for (let i = 0; i <= 8; i++) r.play({ ...POSES.open_palm, at: { x: 0.7 - i * 0.0625, y: 0.5 } }, FRAME);
    const swipes = r.events.filter((e) => e.name === 'swipe');
    expect(swipes).toHaveLength(1);
    expect(swipes[0].payload.direction).toBe('right');
  });

  it('slow motion is not a swipe', () => {
    const r = rig();
    for (let i = 0; i <= 60; i++) r.play({ ...POSES.open_palm, at: { x: 0.7 - i * 0.008, y: 0.5 } }, FRAME);
    expect(r.names()).not.toContain('swipe');
  });

  it('emits hand:lost after the grace period and closes gestures', () => {
    const r = rig();
    r.play(POSES.fist, 300);
    r.play(null, 100);
    expect(r.names()).not.toContain('hand:lost');
    r.play(null, 300);
    expect(r.names()).toContain('gesture:end:fist');
    expect(r.names()).toContain('hand:lost');
  });
});

describe('no click gesture', () => {
  it('a quick thumb–index tap emits no click event', () => {
    const r = rig();
    r.play(OPEN_PINCH, 300);
    r.play(POSES.pinch, 150);
    r.play(OPEN_PINCH, 300);
    expect(r.names()).not.toContain('click');
    expect(r.names()).toContain('contact:start');
  });
});

describe('gestures switched off in Settings', () => {
  it('an unchecked sign is never registered, and swipes can be switched off', async () => {
    const { enabledGestures } = await import('../src/config');
    enabledGestures.fist = false;
    enabledGestures.swipe = false;
    try {
      const r = rig();
      r.play(POSES.fist, 600);
      for (let i = 0; i <= 8; i++) r.play({ ...POSES.open_palm, at: { x: 0.7 - i * 0.0625, y: 0.5 } }, FRAME);
      expect(r.names()).not.toContain('gesture:start:fist');
      expect(r.names()).not.toContain('swipe');
    } finally {
      enabledGestures.fist = true;
      enabledGestures.swipe = true;
    }
  });
});
