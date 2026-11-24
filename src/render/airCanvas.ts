/**
 * "Air draw": pinch thumb and index to draw in the air, hold a fist to clear.
 *
 * The pen is built to hold a line through a real, slightly wobbly pinch:
 *   Pen down   thumb and index touching, index reaching out (so curling into a fist never draws)
 *   Holding    stays down until the fingertips are clearly apart (PEN_UP_DIST palm sizes, much
 *              looser than the touch that starts it), so jitter around the touch limit never breaks
 *              the line
 *   Dropouts   if the pinch (or the whole hand) is lost for under PEN_GRACE_MS, the line carries on
 *              as if nothing happened; only a longer gap lifts the pen, and that tail is not drawn
 *   Position   the middle of the two raw fingertips through its own One Euro filter (not the
 *              smoothed skeleton), so the line follows the finger closely; see tests/draw.test.ts
 */
import { OneEuroFilter } from '../analysis/oneEuro';
import { FINGER_COLORS, HAND_COLORS, thresholds as T } from '../config';
import { LM, type HandFeatures } from '../types';
import { AngleSnapper, snapping } from '../control/angleSnap';

interface Stroke { color: string; width: number; pts: { x: number; y: number }[] }

interface Pen {
  down: boolean;
  stroke: Stroke | null;
  /** When the pinch was last lost while the pen was down (-1 = not lost). */
  lostAt: number;
  /** Points seen while the pinch is lost: kept if it comes back, dropped if the pen lifts. */
  pending: { x: number; y: number }[];
  fx: OneEuroFilter;
  fy: OneEuroFilter;
  seenAt: number;
}

const INK: Record<string, string> = HAND_COLORS;
/** The pen lifts only once thumb and index are this far apart (palm sizes). Touch starts at T.touchEnter. */
export const PEN_UP_DIST = 0.5;
/** A pinch (or hand) lost for less than this does not lift the pen. */
export const PEN_GRACE_MS = 220;
/** Pen position filter (picture units): steady when still, close behind when moving. */
const PEN_MIN_CUTOFF = 1.5;
const PEN_BETA = 40;
const PEN_SPEED_FLOOR = 0.03;

export class AirCanvas {
  enabled = false;
  private ctx: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  private pens = new Map<string, Pen>();
  private snappers = new Map<string, AngleSnapper>();
  private cursors: { x: number; y: number; drawing: boolean; color: string }[] = [];
  /**
   * Finished lines are drawn once into this picture and copied each frame, so drawing stays just as
   * fast however much has been drawn (only the lines being drawn right now are redrawn every frame).
   */
  private cache: HTMLCanvasElement | null = null;
  private cached = new Set<Stroke>();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  clear(): void {
    this.strokes = [];
    this.cached.clear();
    this.cache?.getContext('2d')?.clearRect(0, 0, this.cache.width, this.cache.height);
    for (const pen of this.pens.values()) { pen.stroke = null; pen.pending = []; }
  }

  get strokeCount(): number {
    return this.strokes.length;
  }

  /** The drawn lines (for tests). */
  get lines(): readonly { pts: readonly { x: number; y: number }[] }[] {
    return this.strokes;
  }

  /** @param aspect picture width / height, so snapped lines have true angles. */
  update(hands: HandFeatures[], mirror: boolean, aspect = 16 / 9, now = performance.now()): void {
    this.cursors = [];
    if (!this.enabled) {
      this.pens.clear();
      return;
    }
    const seen = new Set<string>();
    for (const h of hands) {
      const img = h.rawImage ?? h.image;
      const t = img[LM.THUMB_TIP];
      const i = img[LM.INDEX_TIP];
      const rx = mirror ? 1 - (t.x + i.x) / 2 : (t.x + i.x) / 2;
      const ry = (t.y + i.y) / 2;
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) continue;
      seen.add(h.id);
      let pen = this.pens.get(h.id);
      if (!pen) {
        pen = {
          down: false, stroke: null, lostAt: -1, pending: [], seenAt: now,
          fx: new OneEuroFilter(PEN_MIN_CUTOFF, PEN_BETA, 1, PEN_SPEED_FLOOR),
          fy: new OneEuroFilter(PEN_MIN_CUTOFF, PEN_BETA, 1, PEN_SPEED_FLOOR),
        };
        this.pens.set(h.id, pen);
      }
      pen.seenAt = now;
      // y is filtered in x units so both axes respond the same to the same real movement.
      const x = pen.fx.filter(rx, now);
      const y = pen.fy.filter(ry / aspect, now) * aspect;

      const contact = h.contactMap['thumb-index'];
      const touching = contact.state === 'touching';
      const pinched = pen.down ? contact.distance < PEN_UP_DIST : touching && h.indexReach >= T.pinchMinIndexReach - 0.1;
      const color = INK[h.handedness] ?? FINGER_COLORS.index;

      if (pinched) {
        if (!pen.down) {
          pen.down = true;
          pen.stroke = null;
        }
        pen.lostAt = -1;
        if (!pen.stroke) {
          pen.stroke = { color, width: Math.max(3, h.palmSizeImage * 40), pts: [] };
          this.strokes.push(pen.stroke);
        }
        for (const p of pen.pending) this.addPoint(h.id, pen.stroke, p, aspect, now);
        pen.pending = [];
        this.addPoint(h.id, pen.stroke, { x, y }, aspect, now);
      } else if (pen.down) {
        if (pen.lostAt < 0) pen.lostAt = now;
        if (now - pen.lostAt < PEN_GRACE_MS) pen.pending.push({ x, y });
        else this.lift(pen);
      }
      this.cursors.push({ x, y, drawing: pen.down, color });
    }
    // Hands not in this frame: a short gap keeps the line, a long one lifts the pen.
    for (const [id, pen] of this.pens) {
      if (seen.has(id)) continue;
      if (pen.down) {
        if (pen.lostAt < 0) pen.lostAt = now;
        if (now - pen.lostAt >= PEN_GRACE_MS) this.lift(pen);
      }
      if (now - pen.seenAt > 1500) this.pens.delete(id);
    }
  }

  private lift(pen: Pen) {
    pen.down = false;
    pen.stroke = null;
    pen.pending = [];
    pen.lostAt = -1;
  }

  private addPoint(id: string, stroke: Stroke, p: { x: number; y: number }, aspect: number, now: number) {
    if (snapping.enabled) {
      let sn = this.snappers.get(id);
      if (!sn) this.snappers.set(id, (sn = new AngleSnapper()));
      if (stroke.pts.length === 0) sn.reset();
      p = sn.snap(p.x, p.y, now, aspect, snapping.increment);
    }
    const last = stroke.pts[stroke.pts.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.002) stroke.pts.push(p);
  }

  private strokeLine(ctx: CanvasRenderingContext2D, s: Stroke, w: number, h: number, dpr: number) {
    if (s.pts.length < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width * dpr;
    ctx.beginPath();
    ctx.moveTo(s.pts[0].x * w, s.pts[0].y * h);
    for (let i = 1; i < s.pts.length - 1; i++) {
      const mx = ((s.pts[i].x + s.pts[i + 1].x) / 2) * w;
      const my = ((s.pts[i].y + s.pts[i + 1].y) / 2) * h;
      ctx.quadraticCurveTo(s.pts[i].x * w, s.pts[i].y * h, mx, my);
    }
    const last = s.pts[s.pts.length - 1];
    ctx.lineTo(last.x * w, last.y * h);
    ctx.stroke();
  }

  draw(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled) return;

    // Finished lines: add any new ones to the cached picture (all of them again after a resize).
    let cache = this.cache;
    if (!cache || cache.width !== w || cache.height !== h) {
      cache = this.cache ??= document.createElement('canvas');
      cache.width = w;
      cache.height = h;
      this.cached.clear();
    }
    const live = new Set<Stroke>();
    for (const pen of this.pens.values()) if (pen.stroke) live.add(pen.stroke);
    const cctx = cache.getContext('2d')!;
    for (const s of this.strokes) {
      if (live.has(s) || this.cached.has(s)) continue;
      this.strokeLine(cctx, s, w, h, dpr);
      this.cached.add(s);
    }
    ctx.drawImage(cache, 0, 0);
    // Lines being drawn right now.
    for (const s of live) this.strokeLine(ctx, s, w, h, dpr);
    // The pen: a ring while hovering, a filled dot while drawing (pinched). A dark edge keeps it
    // visible on any background.
    for (const cur of this.cursors) {
      const x = cur.x * w, y = cur.y * h;
      ctx.beginPath();
      ctx.arc(x, y, (cur.drawing ? 8 : 12) * dpr, 0, Math.PI * 2);
      if (cur.drawing) {
        ctx.fillStyle = cur.color;
        ctx.fill();
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = 'rgba(34, 30, 27, 0.85)';
        ctx.stroke();
      } else {
        ctx.lineWidth = 5.5 * dpr;
        ctx.strokeStyle = 'rgba(34, 30, 27, 0.6)';
        ctx.stroke();
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = cur.color;
        ctx.stroke();
      }
    }
  }
}
