/**
 * Turns one hand into a mouse, and runs the keybinds of every other gesture.
 *
 *   Pointer      the hand's knuckles (index + middle base), not the fingertip, so pinching
 *                does not drag the pointer around
 *   Quick pinch  left click (two quick pinches = double click, as the OS counts it)
 *   Hold pinch   press and drag, release to drop
 *   Everything else (signs from either hand, swipes) runs its keybind (see keybinds.ts);
 *   by default peace = right click, middle finger = minimise, hold fist = turn control on / off, swipes = desktops and scroll.
 *
 * With angle snapping on (Settings), pointer movement and drags follow fixed directions.
 *
 * Only an inner "control box" of the picture is mapped to the screen, so you can reach the
 * screen edges without stretching to the edges of the camera view.
 */
import { OneEuroFilter } from '../analysis/oneEuro';
import { isEnabled, thresholds as T, type Thresholds } from '../config';
import { AngleSnapper, snapping } from './angleSnap';
import { keybinds, normalizeCombo, describeBind, type AppRef, type BindTarget, type Keybind } from './keybinds';
import type { EventBus } from '../events/eventBus';
import { LM, type HandFeatures, type Handedness } from '../types';
import { assignHands } from '../ui/dashboard';

/** What the controller needs from the host (Electron preload, or a fake in tests). */
export interface PcBridge {
  /**
   * Move the pointer (0..1 of the screen). The host glides the cursor there between camera frames;
   * `snap` jumps straight there (used just before a click, so it lands exactly).
   */
  move(x: number, y: number, snap?: boolean): void;
  button(which: 'left' | 'right', down: boolean): void;
  click(which: 'left' | 'right'): void;
  scroll(notches: number): void;
  releaseAll(): void;
  /** Minimise whichever window is currently in front. */
  minimizeActiveWindow(): void;
  /** Win+D: show the desktop, or restore the windows if it is already shown. */
  toggleDesktop(): void;
  /** Press a keyboard shortcut such as "Ctrl+Shift+T". */
  sendKeys(combo: string): void;
  /** Open an installed app or a chosen program. */
  openApp(app: AppRef): void;
  /** Second virtual desktop (created if missing) or back to the first; see electron/desktops.cjs. */
  switchDesktop(which: 'second' | 'first'): void;
}

export interface ControlOptions {
  hand: Handedness;
  /** Fraction of the picture ignored on every side (0.2 = the middle 60% maps to the screen). */
  margin: number;
  /** Pointer smoothing cutoff in Hz: lower = steadier, higher = snappier. */
  smoothing: number;
  /** Which screens the pointer covers: the main screen, or every monitor. */
  screens: 'primary' | 'all';
  /**
   * Calibrated reach (Settings → Calibrate): the part of the picture, as shown with `mirror`, that
   * covers the screen. Null = the centred box from `margin`.
   */
  box: ReachBox | null;
  /** Show the status badge next to the mouse pointer. */
  badge: boolean;
}

/** A rectangle of the picture (0..1), in display space; `mirror` = whether the view was mirrored. */
export interface ReachBox { x0: number; y0: number; x1: number; y1: number; mirror: boolean }

/** The rectangle that maps to the screen, for the current mirror setting. */
export function reachRect(o: Pick<ControlOptions, 'margin' | 'box'>, mirror: boolean): { x0: number; y0: number; x1: number; y1: number } {
  const b = o.box;
  if (b && b.x1 - b.x0 > 0.05 && b.y1 - b.y0 > 0.05) {
    return b.mirror === mirror ? { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : { x0: 1 - b.x1, y0: b.y0, x1: 1 - b.x0, y1: b.y1 };
  }
  const m = Math.min(0.45, Math.max(0, o.margin));
  return { x0: m, y0: m, x1: 1 - m, y1: 1 - m };
}

/**
 * The point the mouse follows: the middle of the four knuckles. They hardly move when you pinch
 * or bend a finger, and averaging four detected points cancels much of their frame-to-frame noise.
 */
export function pointerAnchor(img: { x: number; y: number }[]): { x: number; y: number } {
  const k = [LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  let x = 0, y = 0;
  for (const i of k) { x += img[i].x; y += img[i].y; }
  return { x: x / k.length, y: y / k.length };
}

/**
 * Pointer filter (One Euro, measured in screen widths). When the hand is still the cutoff is the
 * Pointer setting × CUTOFF_SCALE, so it barely wobbles; any real movement (faster than
 * SPEED_FLOOR) raises the cutoff by POINTER_BETA Hz per screen width per second, so it keeps up.
 * Tuned with tests/pointer.test.ts: about half a pixel of jitter and under 20 ms of lag.
 */
const CUTOFF_SCALE = 0.2;
const POINTER_BETA = 100;
const SPEED_FLOOR = 0.04;
/** The cursor only moves once the filtered position is this far from where it is (pixels). */
const JITTER_GATE_PX = 0.6;
/** A click goes where the pointer was this long before the pinch was detected (aiming, not pinching). */
const AIM_REWIND_MS = 70;

export type ControlState = 'off' | 'active' | 'paused';

export interface ControlView {
  state: ControlState;
  hand: Handedness;
  margin: number;
  /** The part of the picture (display space) that covers the screen. */
  rect: { x0: number; y0: number; x1: number; y1: number };
  /** 0..1 while a pinch is held on its way to becoming a drag; 0 otherwise. */
  pinch: number;
  /** Pointer anchor in display space (0..1), or null when the control hand is not in view. */
  anchor: { x: number; y: number } | null;
  dragging: boolean;
}

const CLICK_MAX_MS = 420;
/** Before a drag starts, a pinch that vanishes for less than this is a tracking blip, not a release. */
const PRESS_GRACE_MS = 100;
/** Pointer stays put this long around a pinch so the click lands where you aimed. */
const SETTLE_MS = 140;
const SCROLL_NOTCHES = 4;
/** The same keybind never fires twice within this time. */
const BIND_COOLDOWN_MS = 700;
/**
 * Hand openness = 1 − mean joint bend of index…pinky / FIST_BEND. Bend angles change evenly
 * as the hand closes, so timing between the open and closed levels reflects the real speed.
 */
const FIST_BEND = 200;
/**
 * If openness varied by more than this over the last OPENNESS_WINDOW_MS, the whole hand is opening
 * or closing, so a thumb–index touch is not a pinch. (A pinch moves only the index: about 0.07.)
 */
const HAND_MOVING_RANGE = 0.15;
const OPENNESS_WINDOW_MS = 400;

function opennessOf(hand: HandFeatures): number {
  const f = hand.fingers;
  const bend = (f.index.bend + f.middle.bend + f.ring.bend + f.pinky.bend) / 4;
  return 1 - Math.min(1, Math.max(0, bend / FIST_BEND));
}

export class PcController {
  readonly options: ControlOptions = { hand: 'Right', margin: 0.2, smoothing: 1.2, screens: 'primary', box: null, badge: true };
  /** While true (reach calibration) the hand is tracked but nothing moves, clicks or fires. */
  suspended = false;
  private mirror = true;
  /** Screen width / height, so snapped angles are true angles on screen. */
  screenAspect = 16 / 9;
  /** Width of the area the pointer covers, in pixels (for the jitter gate). */
  screenWidth = 1920;
  /** Recent pointer positions, to put a click where you were aiming. */
  private aimTrail: { t: number; x: number; y: number }[] = [];
  private snapper = new AngleSnapper();
  onChange?: (view: ControlView, reason: string) => void;

  private state: ControlState = 'off';
  private controlId: string | null = null;
  private fx = new OneEuroFilter(1.2 * CUTOFF_SCALE, POINTER_BETA, 1, SPEED_FLOOR);
  private fy = new OneEuroFilter(1.2 * CUTOFF_SCALE, POINTER_BETA, 1, SPEED_FLOOR);
  private touchStart = -1;
  /** When the pinch (or the hand) was last seen going away during a press, or -1. */
  private lostSince = -1;
  private dragging = false;
  private settleUntil = 0;
  private lastFired = new Map<BindTarget, number>();
  /** Time of the latest analysed frame (gesture events fire within a frame). */
  private frameNow = 0;
  /** Thumb touched the index while the hand was curling into a fist: wait for it to let go. */
  private pinchBlocked = false;
  private opennessTrail: { t: number; v: number }[] = [];
  private anchor: { x: number; y: number } | null = null;
  private lastSent: { x: number; y: number } | null = null;

  constructor(
    bus: EventBus,
    private bridge: PcBridge,
    private t: Thresholds = T,
  ) {
    // Keybinds: signs from either hand, plus swipes.
    bus.on('gesture:start', ({ gesture }) => {
      if (gesture !== 'pinch') this.runBind(gesture as BindTarget, 'made');
    });
    bus.on('gesture:hold', ({ gesture }) => {
      if (gesture !== 'pinch') this.runBind(gesture as BindTarget, 'held');
    });
    bus.on('swipe', ({ direction }) => this.runBind(`swipe_${direction}` as BindTarget, 'made'));
    // Losing the hand mid-drag starts the drop timer in update(); it does not drop at once.
    bus.on('hand:lost', ({ hand }) => {
      if (hand === this.controlId && this.dragging && this.lostSince < 0) this.lostSince = this.frameNow;
    });
  }

  get view(): ControlView {
    const pinch = this.dragging ? 1 : this.touchStart >= 0 && this.lostSince < 0
      ? Math.min(1, Math.max(0, (this.frameNow - this.touchStart) / this.t.dragHoldMs)) : 0;
    return {
      state: this.state, hand: this.options.hand, margin: this.options.margin, rect: reachRect(this.options, this.mirror),
      pinch, anchor: this.anchor, dragging: this.dragging,
    };
  }

  get isOn(): boolean {
    return this.state !== 'off';
  }

  start(): void {
    if (this.state === 'off') this.setState('active', 'Started');
  }

  stop(): void {
    if (this.state !== 'off') this.setState('off', 'Stopped');
  }

  toggle(): void {
    if (this.state === 'off') this.start();
    else this.stop();
  }

  private setState(next: ControlState, reason: string) {
    if (next !== 'active') this.releaseDrag();
    this.touchStart = -1;
    this.lostSince = -1;
    this.state = next;
    if (next === 'off') {
      this.anchor = null;
      this.bridge.releaseAll();
    }
    this.emit(reason);
  }

  private emit(reason: string) {
    this.onChange?.(this.view, reason);
  }

  /** Let go of any press now (the camera stopped, so no more frames will come). */
  cancelPress(): void {
    this.releaseDrag();
    this.touchStart = -1;
    this.lostSince = -1;
  }

  private releaseDrag() {
    this.lostSince = -1;
    if (this.dragging) {
      this.dragging = false;
      this.bridge.button('left', false);
    }
  }

  /** Run the keybind for a gesture, if one is set for this trigger. */
  private runBind(target: BindTarget, trigger: Keybind['trigger']) {
    const bind = keybinds[target];
    if (!bind || bind.action === 'none' || bind.trigger !== trigger) return;
    // The on/off sign works in every state (it can turn control on from stopped); everything else
    // only while control is active.
    if (this.suspended || (bind.action !== 'pause_control' && this.state !== 'active')) return;
    const now = this.frameNow;
    if (now - (this.lastFired.get(target) ?? -Infinity) < BIND_COOLDOWN_MS) return;
    this.lastFired.set(target, now);
    switch (bind.action) {
      case 'left_click': this.bridge.click('left'); break;
      case 'right_click': this.bridge.click('right'); break;
      case 'double_click': this.bridge.click('left'); this.bridge.click('left'); break;
      case 'scroll_up': this.bridge.scroll(SCROLL_NOTCHES); break;
      case 'scroll_down': this.bridge.scroll(-SCROLL_NOTCHES); break;
      case 'minimize_window': this.bridge.minimizeActiveWindow(); break;
      case 'show_desktop': this.bridge.toggleDesktop(); break;
      case 'desktop_second': this.bridge.switchDesktop('second'); break;
      case 'desktop_first': this.bridge.switchDesktop('first'); break;
      case 'pause_control':
        // Off: the hand stays tracked (so the same sign turns it back on) but nothing moves or clicks.
        if (this.state === 'active') this.setState('paused', 'Paused');
        else this.setState('active', this.state === 'off' ? 'Started' : 'Resumed');
        return;
      case 'open_app':
        if (!bind.app) return;
        this.bridge.openApp(bind.app);
        break;
      case 'keys': {
        const combo = bind.keys ? normalizeCombo(bind.keys) : null;
        if (!combo) return;
        this.bridge.sendKeys(combo);
        break;
      }
    }
    this.emit(describeBind(bind));
  }

  /** Call once per analysed frame. */
  update(hands: HandFeatures[], mirror: boolean, now: number): void {
    this.frameNow = now;
    this.mirror = mirror;
    if (this.state === 'off') return;
    const hand = assignHands(hands)[this.options.hand];
    if (!hand) {
      this.controlId = null;
      this.anchor = null;
      // Mid-drag, keep holding through a short tracking dropout; drop only after dragDropMs.
      if (this.dragging) {
        if (this.lostSince < 0) this.lostSince = now;
        if (now - this.lostSince < this.t.dragDropMs) return;
        this.releaseDrag();
        this.emit('Drop');
      }
      this.touchStart = -1;
      this.lostSince = -1;
      this.snapper.reset();
      return;
    }
    this.controlId = hand.id;

    // The raw (unsmoothed) knuckles: the pointer has its own filter below, so smoothing twice
    // would only add lag.
    const k = pointerAnchor(hand.rawImage ?? hand.image);
    if (!Number.isFinite(k.x) || !Number.isFinite(k.y)) return; // a bad frame: skip it, keep everything as is
    this.anchor = { x: mirror ? 1 - k.x : k.x, y: k.y };
    if (this.state !== 'active') return;
    if (this.suspended) {
      this.cancelPress();
      return;
    }

    // ── Pinch → click / drag ─────────────────────────────────────────────
    const contact = hand.contactMap['thumb-index'].state === 'touching';
    // A real pinch has the index reaching out. When the hand curls into a fist the thumb brushes
    // the index on the way; that must never click or drag.
    const openness = opennessOf(hand);
    const trail = this.opennessTrail;
    trail.push({ t: now, v: openness });
    while (trail.length && now - trail[0].t > OPENNESS_WINDOW_MS) trail.shift();
    let lo = 1, hi = 0;
    for (const p of trail) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
    const handMoving = hi - lo > HAND_MOVING_RANGE;
    const reachOk = hand.indexReach >= this.t.pinchMinIndexReach - 0.1;
    // (Once a drag is under way it is never cut off this way: only letting go drops it.)
    if (contact && (!reachOk || handMoving) && !this.dragging) {
      if (this.touchStart >= 0) {
        this.releaseDrag();
        this.touchStart = -1;
        this.settleUntil = now + SETTLE_MS;
      }
      this.pinchBlocked = true;
    } else if (!contact) {
      this.pinchBlocked = false;
    }
    const touching = contact && !this.pinchBlocked && isEnabled('pinch');
    if (touching) {
      this.lostSince = -1;
      if (this.touchStart < 0) {
        this.touchStart = now;
      } else if (!this.dragging && now - this.touchStart >= this.t.dragHoldMs) {
        this.dragging = true;
        this.aim(this.touchStart);
        this.bridge.button('left', true);
        this.snapper.reset(); // a drag starts a fresh straight line
        this.emit('Drag');
      }
    } else if (this.touchStart >= 0 && (!this.pinchBlocked || this.dragging)) {
      // The pinch is gone. Wait a moment before believing it: tracking often loses it for a frame
      // or two, and dropping a dragged window by accident is much worse than a slightly late drop.
      if (this.lostSince < 0) this.lostSince = now;
      const grace = this.dragging ? this.t.dragDropMs : PRESS_GRACE_MS;
      if (now - this.lostSince >= grace) {
        if (this.dragging) {
          this.releaseDrag();
          this.snapper.reset();
          this.emit('Drop');
        } else if (this.lostSince - this.touchStart <= CLICK_MAX_MS && !handMoving) {
          this.aim(this.touchStart);
          this.bridge.click('left');
          this.emit('Click');
        }
        this.touchStart = -1;
        this.lostSince = -1;
        this.settleUntil = now + SETTLE_MS;
      }
    }

    // ── Pointer ──────────────────────────────────────────────────────────
    const r = reachRect(this.options, mirror);
    const u = Math.min(1, Math.max(0, (this.anchor.x - r.x0) / (r.x1 - r.x0)));
    const v = Math.min(1, Math.max(0, (this.anchor.y - r.y0) / (r.y1 - r.y0)));
    this.fx.minCutoff = this.fy.minCutoff = this.options.smoothing * CUTOFF_SCALE;
    // Same speed scale on both axes: y is measured in screen widths too.
    let sx = this.fx.filter(u, now);
    let sy = this.fy.filter(v / this.screenAspect, now) * this.screenAspect;
    // Angle snapping (Settings): keep the pointer on fixed directions (0°, 45°, 90°, …).
    if (snapping.enabled) ({ x: sx, y: sy } = this.snapper.snap(sx, sy, now, this.screenAspect, snapping.increment));
    else this.snapper.reset();
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
      // Never send a broken position (the OS layer would park the cursor mid-screen): start the filters over.
      this.fx = new OneEuroFilter(1.2 * CUTOFF_SCALE, POINTER_BETA, 1, SPEED_FLOOR);
      this.fy = new OneEuroFilter(1.2 * CUTOFF_SCALE, POINTER_BETA, 1, SPEED_FLOOR);
      this.snapper.reset();
      return;
    }
    sx = Math.min(1, Math.max(0, sx));
    sy = Math.min(1, Math.max(0, sy));
    const aim = this.aimTrail;
    aim.push({ t: now, x: sx, y: sy });
    while (aim.length > 2 && now - aim[0].t > 1000) aim.shift();

    // Hold still while a pinch is starting or just released, so clicks land where you aimed.
    const settling = (this.touchStart >= 0 && !this.dragging && now - this.touchStart < CLICK_MAX_MS) || now < this.settleUntil;
    if (settling) return;
    // Ignore sub-pixel wobble: the cursor only moves for a real change.
    const gate = JITTER_GATE_PX / Math.max(1, this.screenWidth);
    if (this.lastSent && Math.hypot(this.lastSent.x - sx, (this.lastSent.y - sy) / this.screenAspect) < gate) return;
    this.lastSent = { x: sx, y: sy };
    this.bridge.move(sx, sy);
  }

  /** Put the cursor where it was just before the pinch began, so the click lands on what you aimed at. */
  private aim(touchStart: number) {
    const target = touchStart - AIM_REWIND_MS;
    let p: { x: number; y: number } | null = null;
    for (const e of this.aimTrail) { if (e.t > target) break; p = e; }
    if (!p) return;
    this.lastSent = { x: p.x, y: p.y };
    this.bridge.move(p.x, p.y, true);
  }
}
