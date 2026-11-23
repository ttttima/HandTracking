/**
 * What the badge next to the mouse pointer says (the window itself is electron/overlay.cjs).
 *
 *   Control just turned on / off   "Control on" / "Control off" for FLASH_MS
 *   Dragging                       "Dragging", full ring
 *   Pinch held                     "Pinch – hold to drag", the ring fills up to the drag
 *   A bound sign                   the sign and what it does; for "when held" binds the ring
 *                                  fills up to the moment it fires
 *   A bound swipe                  the swipe and what it did, for FLASH_MS
 *
 * The on/off sign shows its ring in every state (so you can see it about to turn control on);
 * everything else only while control is on. Signs with no keybind are not shown.
 */
import { GESTURE_META, isEnabled, thresholds as T } from '../config';
import type { EventBus } from '../events/eventBus';
import type { HandGestureState, Handedness } from '../types';
import { BIND_TARGETS, describeBind, keybinds, type BindTarget } from './keybinds';
import type { ControlState, ControlView } from './pcController';

export interface BadgeState {
  show: boolean;
  title: string;
  detail: string;
  /** 0..1 ring, or -1 for no ring. */
  progress: number;
  tone: 'on' | 'off' | 'drag' | 'pinch' | 'sign';
  hand: Handedness;
}

const FLASH_MS = 1400;
const HIDDEN: BadgeState = { show: false, title: '', detail: '', progress: -1, tone: 'sign', hand: 'Right' };

const targetLabel = (t: BindTarget) => BIND_TARGETS.find((x) => x.id === t)?.label ?? GESTURE_META[t]?.label ?? t;

export class CursorBadge {
  enabled = true;
  private flash: { until: number; state: BadgeState } | null = null;
  private lastState: ControlState | null = null;
  private lastSent = '';

  constructor(bus: EventBus, private send: (s: BadgeState) => void, private now: () => number = () => performance.now()) {
    bus.on('swipe', ({ direction }) => {
      const target = `swipe_${direction}` as BindTarget;
      const bind = keybinds[target];
      if (!bind || bind.action === 'none' || this.lastState !== 'active') return;
      this.flash = { until: this.now() + FLASH_MS, state: { ...HIDDEN, show: true, title: targetLabel(target), detail: describeBind(bind), tone: 'sign' } };
    });
  }

  /** Call once per frame with the controller's view (or null when there is no controller). */
  update(view: ControlView | null, state: ControlState, gestures: Map<string, HandGestureState>, onOffHint: string | null): void {
    const now = this.now();
    // Control switched on or off: say so.
    if (this.lastState !== null && state !== this.lastState) {
      const on = state === 'active';
      this.flash = {
        until: now + FLASH_MS,
        state: { ...HIDDEN, show: true, title: on ? 'Control on' : 'Control off', detail: on ? '' : onOffHint ? `To turn it on, ${onOffHint}` : '', tone: on ? 'on' : 'off', hand: view?.hand ?? 'Right' },
      };
    }
    this.lastState = state;
    this.emit(this.enabled ? this.compute(view, state, gestures, now) : HIDDEN);
  }

  private compute(view: ControlView | null, state: ControlState, gestures: Map<string, HandGestureState>, now: number): BadgeState {
    const hand = view?.hand ?? 'Right';
    // Holding the on/off sign beats everything: it is about to change the state.
    const sign = this.heldSign(gestures, hand, state);
    if (sign && sign.toggle && sign.progress < 1) return sign.badge;
    if (this.flash && now < this.flash.until) return this.flash.state;
    this.flash = null;
    if (state !== 'active' || !view) return HIDDEN;
    if (view.dragging) return { ...HIDDEN, show: true, title: 'Dragging', detail: 'Open your fingers to drop', progress: 1, tone: 'drag', hand };
    if (view.pinch > 0) return { ...HIDDEN, show: true, title: 'Pinch', detail: 'Hold to drag', progress: view.pinch, tone: 'pinch', hand };
    if (sign) return sign.badge;
    return HIDDEN;
  }

  /** The bound sign shown by a hand (the mouse hand first), with its hold progress. */
  private heldSign(gestures: Map<string, HandGestureState>, mouseHand: Handedness, state: ControlState) {
    const states = [...gestures.values()].sort((a, b) => Number(b.handedness === mouseHand) - Number(a.handedness === mouseHand));
    for (const g of states) {
      const id = g.primary;
      if (!id || id === 'pinch' || !isEnabled(id)) continue;
      const bind = keybinds[id as BindTarget];
      if (!bind || bind.action === 'none') continue;
      const toggle = bind.action === 'pause_control';
      if (!toggle && state !== 'active') continue;
      const held = bind.trigger === 'held';
      const progress = held ? Math.min(1, g.primaryHeldMs / Math.max(1, T.holdMs)) : -1;
      const detail = toggle ? (state === 'active' ? 'Hold to turn control off' : 'Hold to turn control on') : held && progress < 1 ? `Hold: ${describeBind(bind)}` : describeBind(bind);
      return { toggle, progress, badge: { ...HIDDEN, show: true, title: targetLabel(id as BindTarget), detail, progress, tone: 'sign' as const, hand: g.handedness } };
    }
    return null;
  }

  /** No more frames are coming (the camera stopped): take the badge away. */
  hide(): void {
    this.flash = null;
    this.emit(HIDDEN);
  }

  private emit(s: BadgeState) {
    // Only send changes; the ring moves in 5% steps.
    const key = s.show ? JSON.stringify({ ...s, progress: s.progress < 0 ? -1 : Math.round(s.progress * 20) / 20 }) : 'hidden';
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.send(s.show ? { ...s, progress: s.progress < 0 ? -1 : Math.round(s.progress * 20) / 20 } : HIDDEN);
  }
}
