/**
 * Action layer: maps gesture events to named actions.
 *
 * This is the extension point for controlling other things with your hands. Bindings are
 * plain data ("when event X (optionally with gesture Y / direction Z) happens, run action A"),
 * and actions are handlers registered by name. The app registers safe in-page demo handlers;
 * a future OS-control module would register e.g. `pointer.dragStart` to press the real mouse
 * (for instance through a small local WebSocket bridge to a native helper).
 */
import type { AppEventMap, AppEventName, EventBus } from '../events/eventBus';
import type { StaticGestureId } from '../types';

export interface Binding {
  event: AppEventName;
  /** Only for gesture:* events. */
  gesture?: StaticGestureId;
  /** Only for swipe events. */
  direction?: AppEventMap['swipe']['direction'];
  action: string;
  description: string;
}

export type ActionHandler = (payload: unknown, event: AppEventName) => void;

export interface ActionFired {
  binding: Binding;
  payload: unknown;
  at: number;
}

export const DEFAULT_BINDINGS: Binding[] = [
  { event: 'drag:start', action: 'pointer.dragStart', description: 'Pinch & hold → start drag' },
  { event: 'drag:end', action: 'pointer.dragEnd', description: 'Release pinch → drop' },
  { event: 'gesture:start', gesture: 'open_palm', action: 'media.pause', description: 'Open palm → pause' },
  { event: 'gesture:start', gesture: 'fist', action: 'media.stop', description: 'Fist → stop' },
  { event: 'gesture:hold', gesture: 'fist', action: 'canvas.clear', description: 'Hold fist → clear air canvas' },
  { event: 'gesture:hold', gesture: 'thumbs_up', action: 'app.confirm', description: 'Hold thumbs up → confirm' },
  { event: 'swipe', direction: 'left', action: 'nav.previous', description: 'Swipe left → previous' },
  { event: 'swipe', direction: 'right', action: 'nav.next', description: 'Swipe right → next' },
  { event: 'swipe', direction: 'up', action: 'nav.up', description: 'Swipe up → scroll up' },
  { event: 'swipe', direction: 'down', action: 'nav.down', description: 'Swipe down → scroll down' },
];

function matches(b: Binding, name: AppEventName, payload: Record<string, unknown>): boolean {
  if (b.event !== name) return false;
  if (b.gesture && payload.gesture !== b.gesture) return false;
  if (b.direction && payload.direction !== b.direction) return false;
  return true;
}

export class ActionMapper {
  enabled = true;
  private handlers = new Map<string, ActionHandler>();
  private firedListeners = new Set<(f: ActionFired) => void>();

  constructor(
    bus: EventBus,
    public bindings: Binding[] = DEFAULT_BINDINGS,
  ) {
    bus.onAny((name, payload) => {
      if (!this.enabled) return;
      for (const b of this.bindings) {
        if (!matches(b, name, payload as Record<string, unknown>)) continue;
        this.handlers.get(b.action)?.(payload, name);
        const fired = { binding: b, payload, at: performance.now() };
        for (const fn of this.firedListeners) fn(fired);
      }
    });
  }

  register(action: string, handler: ActionHandler): () => void {
    this.handlers.set(action, handler);
    return () => this.handlers.delete(action);
  }

  onFired(fn: (f: ActionFired) => void): () => void {
    this.firedListeners.add(fn);
    return () => this.firedListeners.delete(fn);
  }
}
