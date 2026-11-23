import { describe, expect, it } from 'vitest';
import { HandAnalyzer } from '../src/analysis/handAnalyzer';
import { DEFAULT_THRESHOLDS } from '../src/config';
import { PcController, type PcBridge } from '../src/control/pcController';
import { EventBus } from '../src/events/eventBus';
import { GestureEngine } from '../src/gestures/gestureEngine';
import { ASPECT, POSES, makeHand, type HandPose } from './synthetic';

const FRAME = 1000 / 30;

function rig() {
  const t = { ...DEFAULT_THRESHOLDS };
  const bus = new EventBus();
  const engine = new GestureEngine(bus, t);
  engine.options.aspect = ASPECT;
  const analyzer = new HandAnalyzer(t);
  const calls: string[] = [];
  const moves: { x: number; y: number }[] = [];
  const bridge: PcBridge = {
    move: (x, y) => { moves.push({ x, y }); calls.push('move'); },
    button: (b, down) => calls.push(`${b}:${down ? 'down' : 'up'}`),
    click: (b) => calls.push(`click:${b}`),
    scroll: (n) => calls.push(`scroll:${n}`),
    releaseAll: () => calls.push('releaseAll'),
    minimizeActiveWindow: () => calls.push('minimize'),
    toggleDesktop: () => calls.push('win+d'),
    sendKeys: (combo) => calls.push(`keys:${combo}`),
    openApp: (app) => calls.push(`open:${app.name}`),
  };
  const ctl = new PcController(bus, bridge, t);
  let now = 1000;
  const play = (pose: HandPose | null, ms: number) => {
    const end = now + ms;
    while (now < end) {
      now += FRAME;
      const hands = pose ? [analyzer.analyze(makeHand(pose), 'Right', now, ASPECT)] : [];
      engine.update(hands, now);
      ctl.update(hands, true, now);
    }
  };
  const actions = () => calls.filter((c) => c !== 'move');
  /** Curl the hand from open (k=from) to closed (k=to) over `ms`. */
  const curl = (from: number, to: number, ms: number) => {
    const steps = Math.max(1, Math.round(ms / FRAME));
    for (let i = 1; i <= steps; i++) play(handAt(from + ((to - from) * i) / steps), FRAME);
  };
  return { t, ctl, play, calls, moves, actions, curl };
}

/** k = 0 open palm … 1 fist. */
function handAt(k: number): HandPose {
  const f = (a: number, b: number, c: number): [number, number, number] => [a * k, b * k, c * k];
  return {
    index: f(80, 100, 65), middle: f(80, 100, 65), ring: f(80, 100, 65), pinky: f(80, 100, 65),
    thumbAbduction: 50 - 15 * k, thumb: f(25, 45, 60), spread: 2 - 1.5 * k,
  };
}

// An open-ish pointing hand, and the same hand pinching (thumb onto index).
const POINT: HandPose = { middle: [80, 100, 65], ring: [80, 100, 65], pinky: [80, 100, 65], thumbAbduction: 50 };
const PINCH: HandPose = { ...POSES.pinch, index: [15, 30, 15] };
const OPEN_PINCH: HandPose = { ...PINCH, thumbTouchIndex: { x: 0.05, y: 0.025, z: 0 } };

describe('PC control', () => {
  it('does nothing until switched on', () => {
    const r = rig();
    r.play(POINT, 500);
    expect(r.calls).toEqual([]);
  });

  it('moves the pointer, mapping the control box to the screen (mirrored)', () => {
    const r = rig();
    r.ctl.start();
    r.play({ ...POINT, at: { x: 0.5, y: 0.5 } }, 600);
    const centre = r.moves[r.moves.length - 1];
    // The knuckles sit slightly above the hand centre; x is mirrored.
    expect(centre.x).toBeGreaterThan(0.3);
    expect(centre.x).toBeLessThan(0.7);
    r.play({ ...POINT, at: { x: 0.25, y: 0.5 } }, 800); // hand moves to image-left = screen-right when mirrored
    expect(r.moves[r.moves.length - 1].x).toBeGreaterThan(centre.x + 0.2);
  });

  it('quick pinch = one left click, and the pointer holds still while clicking', () => {
    const r = rig();
    r.ctl.start();
    r.play(OPEN_PINCH, 400);
    const movesBefore = r.moves.length;
    r.play(PINCH, 200);
    const movesDuring = r.moves.length - movesBefore;
    r.play(OPEN_PINCH, 300);
    expect(r.actions()).toEqual(['click:left']);
    expect(movesDuring).toBe(0);
  });

  it('pinch and hold = drag (press, move, release), no click', () => {
    const r = rig();
    r.ctl.start();
    r.play(OPEN_PINCH, 400);
    r.play(PINCH, r.t.dragHoldMs + 300);
    expect(r.ctl.view.dragging).toBe(true);
    r.play(OPEN_PINCH, r.t.dragDropMs + 300);
    expect(r.actions()).toEqual(['left:down', 'left:up']);
  });

  it('a drag survives brief tracking dropouts (pinch or hand gone for a moment)', () => {
    const r = rig();
    r.ctl.start();
    r.play(OPEN_PINCH, 400);
    r.play(PINCH, r.t.dragHoldMs + 200);
    expect(r.ctl.view.dragging).toBe(true);
    r.play(OPEN_PINCH, 150); // pinch flickers off
    r.play(PINCH, 300);
    r.play(null, 250); // hand lost for a moment
    r.play(PINCH, 300);
    expect(r.ctl.view.dragging).toBe(true);
    expect(r.actions()).toEqual(['left:down']);
    // A real release still drops, about dragDropMs later.
    r.play(OPEN_PINCH, r.t.dragDropMs - 150);
    expect(r.ctl.view.dragging).toBe(true);
    r.play(OPEN_PINCH, 400);
    expect(r.ctl.view.dragging).toBe(false);
    expect(r.actions()).toEqual(['left:down', 'left:up']);
  });

  it('a one-frame pinch dropout while pressing does not click and restart', () => {
    const r = rig();
    r.ctl.start();
    r.play(OPEN_PINCH, 400);
    r.play(PINCH, 250);
    r.play(OPEN_PINCH, 40);
    r.play(PINCH, r.t.dragHoldMs);
    expect(r.ctl.view.dragging).toBe(true);
    expect(r.actions()).toEqual(['left:down']);
  });

  it('peace sign = right click', () => {
    const r = rig();
    r.ctl.start();
    r.play(POINT, 300);
    r.play(POSES.peace, 400);
    expect(r.actions()).toEqual(['click:right']);
  });

  it('middle finger minimises the window in front, once per gesture', () => {
    const r = rig();
    r.ctl.start();
    r.play(POINT, 300);
    r.play(POSES.middle_finger, 1500);
    expect(r.actions()).toEqual(['minimize']);
  });

  it('middle finger does nothing while control is off', () => {
    const r = rig();
    r.play(POSES.middle_finger, 600);
    expect(r.calls).toEqual([]);
  });

  it('holding a fist pauses, holding it again resumes', () => {
    const r = rig();
    r.ctl.start();
    r.play(POINT, 300);
    r.play(POSES.fist, r.t.holdMs + 300);
    expect(r.ctl.view.state).toBe('paused');
    const moves = r.moves.length;
    r.play(POINT, 600);
    expect(r.moves.length).toBe(moves); // no movement while paused
    r.play(POSES.fist, r.t.holdMs + 300);
    expect(r.ctl.view.state).toBe('active');
  });

  it('never leaves the button stuck: losing the hand mid-drag releases it', () => {
    const r = rig();
    r.ctl.start();
    r.play(OPEN_PINCH, 400);
    r.play(PINCH, r.t.dragHoldMs + 200);
    r.play(null, r.t.dragDropMs + 300);
    expect(r.actions()).toEqual(['left:down', 'left:up']);
  });

  it('stopping control releases everything', () => {
    const r = rig();
    r.ctl.start();
    r.play(POINT, 200);
    r.ctl.stop();
    expect(r.calls[r.calls.length - 1]).toBe('releaseAll');
    expect(r.ctl.view.state).toBe('off');
  });
});


describe('gestures switched off in Settings', () => {
  const reset = async () => {
    const { enabledGestures, GESTURE_TOGGLES } = await import('../src/config');
    for (const g of GESTURE_TOGGLES) enabledGestures[g.id] = true;
  };

  it('unchecked Pinch: no click or drag', async () => {
    const { enabledGestures } = await import('../src/config');
    enabledGestures.pinch = false;
    const r = rig();
    r.ctl.start();
    r.play(OPEN_PINCH, 400);
    r.play(PINCH, 200);
    r.play(OPEN_PINCH, 300);
    r.play(PINCH, r.t.dragHoldMs + 300);
    r.play(OPEN_PINCH, 300);
    await reset();
    expect(r.actions()).toEqual([]);
  });

  it('unchecked Peace: no right click', async () => {
    const { enabledGestures } = await import('../src/config');
    enabledGestures.peace = false;
    const r = rig();
    r.ctl.start();
    r.play(POINT, 300);
    r.play(POSES.peace, 400);
    await reset();
    expect(r.actions()).toEqual([]);
  });

});

describe('making or opening a fist never clicks', () => {
  it('closing and reopening the hand at any speed sends no mouse button', () => {
    const r = rig();
    r.ctl.start();
    r.play(handAt(0), 400);
    r.curl(0, 1, 1200);
    r.play(handAt(1), 300);
    r.curl(1, 0, 300);
    r.curl(0, 1, 200);
    r.curl(1, 0, 1200);
    expect(r.actions().filter((a) => a.startsWith('click') || a.startsWith('left'))).toEqual([]);
  });
});

describe('keybinds', () => {
  const restore = async () => {
    const { resetKeybinds } = await import('../src/control/keybinds');
    resetKeybinds();
  };

  it('defaults: peace = right click, middle finger = minimise, swipe = scroll', () => {
    const r = rig();
    r.ctl.start();
    r.play(POINT, 300);
    r.play(POSES.peace, 400);
    r.play(POINT, 300);
    r.play(POSES.middle_finger, 400);
    r.play({ ...POSES.open_palm, at: { x: 0.5, y: 0.8 } }, 800); // settle before swiping
    for (let i = 0; i <= 8; i++) r.play({ ...POSES.open_palm, at: { x: 0.5, y: 0.8 - i * 0.075 } }, FRAME);
    expect(r.actions()).toEqual(['click:right', 'minimize', 'scroll:4']);
  });

  it('a gesture can be rebound to a keyboard shortcut', async () => {
    const { keybinds } = await import('../src/control/keybinds');
    keybinds.thumbs_up = { action: 'keys', keys: 'ctrl + shift + t', trigger: 'made' };
    try {
      const r = rig();
      r.ctl.start();
      r.play(POINT, 300);
      r.play(POSES.thumbs_up, 400);
      expect(r.actions()).toEqual(['keys:Ctrl+Shift+T']);
    } finally {
      await restore();
    }
  });

  it('"held" bindings wait for the hold, "made" ones fire straight away', async () => {
    const { keybinds } = await import('../src/control/keybinds');
    keybinds.thumbs_up = { action: 'show_desktop', trigger: 'held' };
    try {
      const r = rig();
      r.ctl.start();
      r.play(POINT, 300);
      r.play(POSES.thumbs_up, 400);
      expect(r.actions()).toEqual([]);
      r.play(POSES.thumbs_up, r.t.holdMs);
      expect(r.actions()).toEqual(['win+d']);
    } finally {
      await restore();
    }
  });

  it('setting a gesture to Nothing disables it, and nothing fires while control is off', async () => {
    const { keybinds } = await import('../src/control/keybinds');
    keybinds.peace = { action: 'none', trigger: 'made' };
    try {
      const r = rig();
      r.ctl.start();
      r.play(POINT, 300);
      r.play(POSES.peace, 400);
      r.ctl.stop();
      r.play(POSES.middle_finger, 400);
      expect(r.actions()).toEqual(['releaseAll']);
    } finally {
      await restore();
    }
  });

  it('either hand can trigger a keybind', () => {
    const r = rig();
    r.ctl.options.hand = 'Left'; // the mouse hand is the left one; the right hand still triggers binds
    r.ctl.start();
    r.play(POSES.middle_finger, 400);
    expect(r.actions()).toEqual(['minimize']);
  });
});

describe('open an app', () => {
  it('a gesture bound to an app opens it', async () => {
    const { keybinds, resetKeybinds } = await import('../src/control/keybinds');
    keybinds.thumbs_up = { action: 'open_app', app: { name: 'Calculator', id: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }, trigger: 'made' };
    try {
      const r = rig();
      r.ctl.start();
      r.play(POINT, 300);
      r.play(POSES.thumbs_up, 400);
      expect(r.actions()).toEqual(['open:Calculator']);
    } finally {
      resetKeybinds();
    }
  });

  it('"Open an app" with no app chosen does nothing', async () => {
    const { keybinds, resetKeybinds } = await import('../src/control/keybinds');
    keybinds.thumbs_up = { action: 'open_app', trigger: 'made' };
    try {
      const r = rig();
      r.ctl.start();
      r.play(POINT, 300);
      r.play(POSES.thumbs_up, 400);
      expect(r.actions()).toEqual([]);
    } finally {
      resetKeybinds();
    }
  });
});
