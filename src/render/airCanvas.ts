/**
 * "Air draw" demo layer: touch thumb & index to draw in the air,
 * hold a fist to clear. A small, self-contained example of building an interaction on top of
 * the tracking + contact pipeline.
 */
import { FINGER_COLORS, HAND_COLORS } from '../config';
import { LM, type HandFeatures } from '../types';
import { AngleSnapper, snapping } from '../control/angleSnap';

interface Stroke { color: string; width: number; pts: { x: number; y: number }[] }

const INK: Record<string, string> = HAND_COLORS;

export class AirCanvas {
  enabled = false;
  private ctx: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  private active = new Map<string, Stroke>();
  private snappers = new Map<string, AngleSnapper>();
  private cursors: { x: number; y: number; drawing: boolean; color: string }[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  clear(): void {
    this.strokes = [];
    this.active.clear();
  }

  get strokeCount(): number {
    return this.strokes.length;
  }

  /** @param aspect picture width / height, so snapped lines have true angles. */
  update(hands: HandFeatures[], mirror: boolean, aspect = 16 / 9): void {
    this.cursors = [];
    if (!this.enabled) {
      this.active.clear();
      return;
    }
    const seen = new Set<string>();
    for (const h of hands) {
      seen.add(h.id);
      const t = h.image[LM.THUMB_TIP];
      const i = h.image[LM.INDEX_TIP];
      const x = mirror ? 1 - (t.x + i.x) / 2 : (t.x + i.x) / 2;
      const y = (t.y + i.y) / 2;
      const drawing = h.contactMap['thumb-index'].state === 'touching';
      const color = INK[h.handedness] ?? FINGER_COLORS.index;
      this.cursors.push({ x, y, drawing, color });
      let stroke = this.active.get(h.id);
      if (drawing) {
        if (!stroke) {
          stroke = { color, width: Math.max(3, h.palmSizeImage * 40), pts: [] };
          this.active.set(h.id, stroke);
          this.strokes.push(stroke);
        }
        let p = { x, y };
        if (snapping.enabled) {
          let sn = this.snappers.get(h.id);
          if (!sn) this.snappers.set(h.id, (sn = new AngleSnapper()));
          if (stroke.pts.length === 0) sn.reset();
          p = sn.snap(x, y, performance.now(), aspect, snapping.increment);
        }
        const last = stroke.pts[stroke.pts.length - 1];
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.002) stroke.pts.push(p);
      } else if (stroke) {
        this.active.delete(h.id);
      }
    }
    for (const id of [...this.active.keys()]) if (!seen.has(id)) this.active.delete(id);
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

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of this.strokes) {
      if (s.pts.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 0;
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
    ctx.shadowBlur = 0;
    for (const cur of this.cursors) {
      ctx.beginPath();
      ctx.arc(cur.x * w, cur.y * h, (cur.drawing ? 7 : 12) * dpr, 0, Math.PI * 2);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = cur.color;
      ctx.fillStyle = cur.drawing ? cur.color : 'transparent';
      ctx.fill();
      ctx.stroke();
    }
  }
}
