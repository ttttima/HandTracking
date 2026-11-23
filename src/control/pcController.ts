/**
 * Turns one hand into a mouse, and runs the keybinds of every other gesture.
 *
 *   Pointer      the hand's knuckles (index + middle base), not the fingertip, so pinching
 *                does not drag the pointer around
 *   Quick pinch  left click (two quick pinches = double click, as the OS counts it)
 *   Hold pinch   press and drag, release to drop
 *   Everything else (signs from either hand, swipes) runs its keybind (see keybinds.ts);
 *   by default peace = right click, middle finger = minimise, hold fist = pause, swipe = scroll.
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
  move(x: number, y: number): void;
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
}

export interface ControlOptions {
  hand: Handedness;
  /** Fraction of the picture ignored on every side (0.2 = the middle 60% maps to the screen). */
  margin: number;
  /** Pointer smoothing cutoff in Hz: lower = steadier, higher = snappier. */
  smoothing: number;
}

export type ControlState = 'off' | 'active' | 'paused';

export interface ControlView {
  state: ControlState;
  hand: Handedness;
  margin: number;
  /** Pointer anchor in display space (0..1), or null when the control hand is not in view. */
  anchor: { x: number; y: number } | null;
  dragging: boolean;
}

const CLICK_MAX_MS = 420;
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
  readonly options: ControlOptions = { hand: 'Right', margin: 0.2, smoothing: 1.2 };
  /** Screen width / height, so snapped angles are true angles on screen. */
  screenAspect = 16 / 9;
  private snapper = new AngleSnapper();
  onChange?: (view: ControlView, reason: string) => void;

  private state: ControlState = 'off';
  private controlId: string | null = null;
  private fx = new OneEuroFilter(1.2, 10);
  private fy = new OneEuroFilter(1.2, 10);
  private touchStart = -1;
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
    bus.on('hand:lost', ({ hand }) => {
      if (hand === this.controlId) this.releaseDrag();
    });
  }

  get view(): ControlView {
    return { state: this.state, hand: this.options.hand, margin: this.options.margin, anchor: this.anchor, dragging: this.dragging };
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

  private releaseDrag() {
    if (this.dragging) {
      this.dragging = false;
      this.bridge.button('left', false);
    }
  }

  /** Run the keybind for a gesture, if one is set for this trigger. */
  private runBind(target: BindTarget, trigger: Keybind['trigger']) {
    const bind = keybinds[target];
    if (!bind || bind.action === 'none' || bind.trigger !== trigger) return;
    // Pausing works while paused (to resume); everything else only while control is active.
    if (this.state === 'off' || (this.state === 'paused' && bind.action !== 'pause_control')) return;
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
      case 'pause_control':
        this.setState(this.state === 'active' ? 'paused' : 'active', this.state === 'active' ? 'Paused' : 'Resumed');
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
    if (this.state === 'off') return;
    const hand = assignHands(hands)[this.options.hand];
    if (!hand) {
      this.controlId = null;
      this.anchor = null;
      this.touchStart = -1;
      this.releaseDrag();
      this.snapper.reset();
      return;
    }
    this.controlId = hand.id;

    const a = hand.image[LM.INDEX_MCP];
    const b = hand.image[LM.MIDDLE_MCP];
    const ax = (a.x + b.x) / 2;
    this.anchor = { x: mirror ? 1 - ax : ax, y: (a.y + b.y) / 2 };
    if (this.state !== 'active') return;

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
    if (contact && (!reachOk || handMoving)) {
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
    if (touching && this.touchStart < 0) {
      this.touchStart = now;
    } else if (touching && !this.dragging && now - this.touchStart >= this.t.dragHoldMs) {
      this.dragging = true;
      this.bridge.button('left', true);
      this.snapper.reset(); // a drag starts a fresh straight line
      this.emit('Drag');
    } else if (!touching && this.touchStart >= 0 && !this.pinchBlocked) {
      if (this.dragging) {
        this.releaseDrag();
        this.snapper.reset();
        this.emit('Drop');
      } else if (now - this.touchStart <= CLICK_MAX_MS && !handMoving) {
        this.bridge.click('left');
        this.emit('Click');
      }
      this.touchStart = -1;
      this.settleUntil = now + SETTLE_MS;
    }

    // ── Pointer ──────────────────────────────────────────────────────────
    const m = Math.min(0.45, Math.max(0, this.options.margin));
    const u = Math.min(1, Math.max(0, (this.anchor.x - m) / (1 - 2 * m)));
    const v = Math.min(1, Math.max(0, (this.anchor.y - m) / (1 - 2 * m)));
    this.fx.minCutoff = this.fy.minCutoff = this.options.smoothing;
    let sx = this.fx.filter(u, now);
    let sy = this.fy.filter(v, now);
    // Angle snapping (Settings): keep the pointer on fixed directions (0°, 45°, 90°, …).
    if (snapping.enabled) ({ x: sx, y: sy } = this.snapper.snap(sx, sy, now, this.screenAspect, snapping.increment));
    else this.snapper.reset();

    // Hold still while a pinch is starting or just released, so clicks land where you aimed.
    const settling = (touching && !this.dragging && now - this.touchStart < CLICK_MAX_MS) || now < this.settleUntil;
    if (settling) return;
    if (this.lastSent && Math.abs(this.lastSent.x - sx) < 0.0004 && Math.abs(this.lastSent.y - sy) < 0.0004) return;
    this.lastSent = { x: sx, y: sy };
    this.bridge.move(sx, sy);
  }
}
