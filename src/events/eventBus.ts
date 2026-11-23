/**
 * Strongly-typed event bus. The gesture engine publishes high-level interaction events here;
 * the UI, the demo canvas and the action mapper subscribe. Anything you build later
 * (mouse control, media keys, a WebSocket bridge to a desktop agent…) should subscribe here too.
 */
import type { FingerName, Handedness, StaticGestureId } from '../types';

/** All coordinates are in *display* space: normalised 0..1, mirrored if the view is mirrored. */
export interface AppEventMap {
  'hand:found': { hand: string; handedness: Handedness };
  'hand:lost': { hand: string };
  'gesture:start': { hand: string; gesture: StaticGestureId; score: number };
  'gesture:end': { hand: string; gesture: StaticGestureId; durationMs: number };
  /** Fired once when a gesture has been held continuously for `thresholds.holdMs`. */
  'gesture:hold': { hand: string; gesture: StaticGestureId; durationMs: number };
  'drag:start': { hand: string; x: number; y: number };
  'drag:move': { hand: string; x: number; y: number };
  'drag:end': { hand: string; x: number; y: number };
  /** Two fingertips started touching. */
  'contact:start': { hand: string; a: FingerName; b: FingerName; distance: number };
  /** Two touching fingertips separated. */
  'contact:end': { hand: string; a: FingerName; b: FingerName; distance: number };
  /** Two fingertips moved close to each other. */
  'proximity:near': { hand: string; a: FingerName; b: FingerName; distance: number };
  /** Two fingertips moved apart. */
  'proximity:far': { hand: string; a: FingerName; b: FingerName; distance: number };
  swipe: { hand: string; direction: 'left' | 'right' | 'up' | 'down'; speed: number };
  /** Index fingertip position every frame — the future mouse cursor. */
  'pointer:move': { hand: string; x: number; y: number };
}

export type AppEventName = keyof AppEventMap;
export type Listener<K extends AppEventName> = (payload: AppEventMap[K], name: K) => void;
type AnyListener = <K extends AppEventName>(name: K, payload: AppEventMap[K]) => void;

export class EventBus {
  private listeners = new Map<AppEventName, Set<Listener<never>>>();
  private anyListeners = new Set<AnyListener>();

  on<K extends AppEventName>(name: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set!.delete(fn as Listener<never>);
  }

  /** Subscribe to every event (used by the event log and action mapper). */
  onAny(fn: AnyListener): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  emit<K extends AppEventName>(name: K, payload: AppEventMap[K]): void {
    const set = this.listeners.get(name);
    if (set) for (const fn of set) (fn as Listener<K>)(payload, name);
    for (const fn of this.anyListeners) fn(name, payload);
  }
}
