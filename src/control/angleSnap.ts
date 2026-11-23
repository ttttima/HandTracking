/**
 * Angle snapping: restricts movement to fixed directions (e.g. every 45°: 0°, 45°, 90°, …)
 * so pointer moves, drags and air-drawn lines come out perfectly straight.
 *
 * Movement is measured from a segment origin. Its angle is rounded to the nearest increment and
 * the position is projected onto that direction. Holding the hand still briefly starts a new
 * segment from where the pointer is, so you can turn corners.
 */

export const SNAP_INCREMENTS = [15, 30, 45, 90] as const;

/** Live, mutable snapping settings (Settings → Angle snapping). */
export const snapping = { enabled: false, increment: 45 };

const STORAGE = 'handgestures.snapping.v1';

export function loadSnapping(): void {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE) ?? '{}');
    if (typeof saved.enabled === 'boolean') snapping.enabled = saved.enabled;
    if (SNAP_INCREMENTS.includes(saved.increment)) snapping.increment = saved.increment;
  } catch {
    /* keep defaults */
  }
}

export function saveSnapping(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE, JSON.stringify(snapping));
  } catch {
    /* ignore */
  }
}

/** Round an angle (degrees) to the nearest multiple of `increment`. */
export function snapAngle(angle: number, increment = 45): number {
  return Math.round(angle / increment) * increment;
}

/**
 * Snaps a moving point. Coordinates are normalised (0..1); `aspect` = width / height of the
 * surface (screen or picture) so angles are measured in real pixels, not stretched units.
 */
export class AngleSnapper {
  /** Hold still this long to start a new segment (turn a corner). */
  pauseMs = 200;
  /** Movement per frame (normalised) below which the hand counts as still. */
  stillSpeed = 0.0015;

  private originRaw: { x: number; y: number } | null = null;
  private originOut = { x: 0, y: 0 };
  private last: { x: number; y: number } | null = null;
  private output = { x: 0, y: 0 };
  private stillSince = -1;

  /** Forget the current segment; the next point starts a new one. */
  reset(): void {
    this.originRaw = null;
    this.last = null;
    this.stillSince = -1;
  }

  snap(x: number, y: number, now: number, aspect: number, increment: number): { x: number; y: number } {
    if (!this.originRaw) {
      this.originRaw = { x, y };
      this.originOut = { x, y };
      this.output = { x, y };
      this.last = { x, y };
      return { x, y };
    }

    // A short pause re-anchors the segment where the snapped output currently is.
    const step = Math.hypot((x - this.last!.x) * aspect, y - this.last!.y);
    this.last = { x, y };
    if (step < this.stillSpeed) {
      if (this.stillSince < 0) this.stillSince = now;
      if (now - this.stillSince >= this.pauseMs) {
        this.originRaw = { x, y };
        this.originOut = { ...this.output };
      }
    } else {
      this.stillSince = -1;
    }

    // Work in pixel-proportional space, snap the direction, project onto it.
    const dx = (x - this.originRaw.x) * aspect;
    const dy = y - this.originRaw.y;
    if (Math.hypot(dx, dy) < 1e-6) return { ...this.output };
    const angle = snapAngle((Math.atan2(dy, dx) * 180) / Math.PI, increment);
    const ux = Math.cos((angle * Math.PI) / 180);
    const uy = Math.sin((angle * Math.PI) / 180);
    const along = Math.max(0, dx * ux + dy * uy);
    this.output = {
      x: Math.min(1, Math.max(0, this.originOut.x + (along * ux) / aspect)),
      y: Math.min(1, Math.max(0, this.originOut.y + along * uy)),
    };
    return { ...this.output };
  }
}
