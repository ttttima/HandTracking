/**
 * Gesture engine: turns per-frame hand features into stable gestures and discrete events.
 *
 *  - Static gestures: score → threshold with hysteresis → must persist `stableMs` to start
 *    and be gone `releaseMs` to end. Fires gesture:start / gesture:end / gesture:hold.
 *  - Drag: thumb–index touch held longer than `dragHoldMs` (pinch-and-hold).
 *  - Contacts: any fingertip pair touching / separating / approaching / moving apart.
 *  - Swipe: fast palm motion with an open-ish hand, with cooldown.
 */
import { GESTURE_PRIORITY, isEnabled, thresholds as T, type Thresholds } from '../config';
import type { EventBus } from '../events/eventBus';
import {
  GESTURE_IDS, LM,
  type ContactState, type HandFeatures, type HandGestureState, type StaticGestureId,
} from '../types';
import { computeStaticScores } from './staticGestures';

interface Debounce {
  active: boolean;
  aboveSince: number;
  belowSince: number;
  activeSince: number;
  holdFired: boolean;
}

interface HandTrack {
  id: string;
  lastSeen: number;
  debounce: Record<StaticGestureId, Debounce>;
  contacts: Record<string, ContactState>;
  pinchPhase: 'idle' | 'touching' | 'dragging';
  touchStart: number;
  lastPinchPos: { x: number; y: number };
  swipeTrail: { t: number; x: number; y: number }[];
  lastSwipeAt: number;
  state: HandGestureState;
}

const newDebounce = (): Debounce => ({ active: false, aboveSince: -1, belowSince: -1, activeSince: 0, holdFired: false });

export interface EngineOptions {
  /** Is the view mirrored (selfie)? Affects event coordinates and swipe directions. */
  mirror: boolean;
  /** Source frame width / height. */
  aspect: number;
  /** Grace period before a missing hand is considered lost. */
  lostAfterMs: number;
}

export class GestureEngine {
  readonly options: EngineOptions = { mirror: true, aspect: 16 / 9, lostAfterMs: 250 };
  private tracks = new Map<string, HandTrack>();

  constructor(
    private bus: EventBus,
    private t: Thresholds = T,
  ) {}

  /** Map an image-space x to display space. */
  private dx(x: number): number {
    return this.options.mirror ? 1 - x : x;
  }

  reset(now = performance.now()): void {
    for (const track of this.tracks.values()) this.finalize(track, now);
    this.tracks.clear();
  }

  update(hands: HandFeatures[], now: number): HandGestureState[] {
    const seen = new Set<string>();
    for (const h of hands) {
      seen.add(h.id);
      let track = this.tracks.get(h.id);
      if (!track) {
        track = this.createTrack(h);
        this.tracks.set(h.id, track);
        this.bus.emit('hand:found', { hand: h.id, handedness: h.handedness });
      }
      track.lastSeen = now;
      this.step(track, h, now);
    }
    for (const [id, track] of this.tracks) {
      if (!seen.has(id) && now - track.lastSeen > this.options.lostAfterMs) {
        this.finalize(track, now);
        this.tracks.delete(id);
      }
    }
    return hands.map((h) => this.tracks.get(h.id)!.state);
  }

  private createTrack(h: HandFeatures): HandTrack {
    const debounce = {} as Record<StaticGestureId, Debounce>;
    const scores = {} as Record<StaticGestureId, number>;
    for (const g of GESTURE_IDS) {
      debounce[g] = newDebounce();
      scores[g] = 0;
    }
    return {
      id: h.id,
      lastSeen: 0,
      debounce,
      contacts: {},
      pinchPhase: 'idle',
      touchStart: 0,
      lastPinchPos: { x: 0.5, y: 0.5 },
      swipeTrail: [],
      lastSwipeAt: -Infinity,
      state: {
        handId: h.id,
        handedness: h.handedness,
        scores,
        active: [],
        primary: null,
        primaryHeldMs: 0,
        pinchPhase: 'idle',
      },
    };
  }

  private finalize(track: HandTrack, now: number): void {
    for (const g of GESTURE_IDS) {
      const d = track.debounce[g];
      if (d.active) this.bus.emit('gesture:end', { hand: track.id, gesture: g, durationMs: now - d.activeSince });
    }
    if (track.pinchPhase === 'dragging') this.bus.emit('drag:end', { hand: track.id, ...track.lastPinchPos });
    this.bus.emit('hand:lost', { hand: track.id });
  }

  private step(track: HandTrack, h: HandFeatures, now: number): void {
    const t = this.t;
    const scores = computeStaticScores(h, { aspect: this.options.aspect }, t);
    // Gestures switched off in Settings are never registered.
    for (const g of GESTURE_IDS) if (!isEnabled(g)) scores[g] = 0;
    const state = track.state;
    state.scores = scores;
    state.handedness = h.handedness;

    // ── Static gestures with hysteresis + timing ───────────────────────────
    const active: StaticGestureId[] = [];
    for (const g of GESTURE_IDS) {
      const d = track.debounce[g];
      const s = scores[g];
      if (!d.active) {
        if (s >= t.gestureOn) {
          if (d.aboveSince < 0) d.aboveSince = now;
          if (now - d.aboveSince >= t.stableMs) {
            d.active = true;
            d.activeSince = now;
            d.holdFired = false;
            d.belowSince = -1;
            this.bus.emit('gesture:start', { hand: h.id, gesture: g, score: s });
          }
        } else d.aboveSince = -1;
      } else {
        if (s < t.gestureOff) {
          if (d.belowSince < 0) d.belowSince = now;
          if (now - d.belowSince >= t.releaseMs) {
            d.active = false;
            d.aboveSince = -1;
            this.bus.emit('gesture:end', { hand: h.id, gesture: g, durationMs: now - d.activeSince });
          }
        } else d.belowSince = -1;
        if (d.active && !d.holdFired && now - d.activeSince >= t.holdMs) {
          d.holdFired = true;
          this.bus.emit('gesture:hold', { hand: h.id, gesture: g, durationMs: now - d.activeSince });
        }
      }
      if (d.active) active.push(g);
    }
    state.active = active;
    state.primary = GESTURE_PRIORITY.find((g) => track.debounce[g].active) ?? null;
    state.primaryHeldMs = state.primary ? now - track.debounce[state.primary].activeSince : 0;

    // ── Fingertip contacts (touch / separate / approach / move apart) ─────
    for (const c of h.contacts) {
      const prev = track.contacts[c.key] ?? 'apart';
      if (prev !== c.state) {
        const payload = { hand: h.id, a: c.a, b: c.b, distance: c.distance };
        if (c.state === 'touching') this.bus.emit('contact:start', payload);
        if (prev === 'touching') this.bus.emit('contact:end', payload);
        if (prev === 'apart') this.bus.emit('proximity:near', payload);
        if (c.state === 'apart') this.bus.emit('proximity:far', payload);
        track.contacts[c.key] = c.state;
      }
    }

    // ── Drag (pinch and hold) from the thumb–index contact ──────────────────────────
    const thumb = h.image[LM.THUMB_TIP];
    const index = h.image[LM.INDEX_TIP];
    const px = this.dx((thumb.x + index.x) / 2);
    const py = (thumb.y + index.y) / 2;
    const touching = h.contactMap['thumb-index'].state === 'touching';
    track.lastPinchPos = { x: px, y: py };

    switch (track.pinchPhase) {
      case 'idle':
        if (touching) {
          track.pinchPhase = 'touching';
          track.touchStart = now;
        }
        break;
      case 'touching':
        if (!touching) {
          track.pinchPhase = 'idle';
        } else if (now - track.touchStart >= t.dragHoldMs) {
          track.pinchPhase = 'dragging';
          this.bus.emit('drag:start', { hand: h.id, x: px, y: py });
        }
        break;
      case 'dragging':
        if (!touching) {
          track.pinchPhase = 'idle';
          this.bus.emit('drag:end', { hand: h.id, x: px, y: py });
        } else this.bus.emit('drag:move', { hand: h.id, x: px, y: py });
        break;
    }
    state.pinchPhase = track.pinchPhase;

    // ── Pointer (index fingertip) ──────────────────────────────────────────
    this.bus.emit('pointer:move', { hand: h.id, x: this.dx(index.x), y: index.y });

    // ── Swipe ──────────────────────────────────────────────────────────────
    const aspect = this.options.aspect;
    const trail = track.swipeTrail;
    const cx = this.dx(h.palmCenter.x) * aspect;
    trail.push({ t: now, x: cx / h.palmSizeImage, y: h.palmCenter.y / h.palmSizeImage });
    while (trail.length && now - trail[0].t > t.swipeWindowMs) trail.shift();
    if (isEnabled('swipe') && trail.length >= 3 && h.extendedCount >= t.swipeMinExtended && now - track.lastSwipeAt >= t.swipeCooldownMs) {
      const first = trail[0];
      const last = trail[trail.length - 1];
      const dt = (last.t - first.t) / 1000;
      const ddx = last.x - first.x;
      const ddy = last.y - first.y;
      const major = Math.max(Math.abs(ddx), Math.abs(ddy));
      const minor = Math.min(Math.abs(ddx), Math.abs(ddy));
      // A tracking jump (the hand "teleporting" in one frame) is not a swipe: real motion is spread over frames.
      const horizontal = Math.abs(ddx) >= Math.abs(ddy);
      let maxStep = 0;
      for (let i = 1; i < trail.length; i++) {
        maxStep = Math.max(maxStep, Math.abs(horizontal ? trail[i].x - trail[i - 1].x : trail[i].y - trail[i - 1].y));
      }
      const smooth = maxStep <= 0.7 * major;
      if (dt > 0.05 && major >= t.swipeMinDistance && major / dt >= t.swipeMinSpeed && major > 2 * minor && smooth) {
        const direction = Math.abs(ddx) > Math.abs(ddy) ? (ddx > 0 ? 'right' : 'left') : ddy > 0 ? 'down' : 'up';
        track.lastSwipeAt = now;
        trail.length = 0;
        this.bus.emit('swipe', { hand: h.id, direction, speed: major / dt });
      }
    }
  }
}
