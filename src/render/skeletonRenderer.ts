/**
 * Canvas overlay renderer: hand outline (tinted per hand), palm, colour-coded finger bones,
 * depth-scaled joints, larger fingertips, wrist, fingertip contacts and the current sign label.
 * Landmarks arrive in un-mirrored image space; mirroring is applied here so text stays readable.
 */
import { FINGER_COLORS, GESTURE_META, HAND_COLORS, PALETTE } from '../config';
import { FINGERS, FINGER_JOINTS, FINGERTIPS, LM, type HandFeatures, type HandGestureState } from '../types';
import type { ControlView } from '../control/pcController';

export interface RenderOptions {
  mirror: boolean;
  skeleton: boolean;
  outline: boolean;
  landmarkIds: boolean;
  gestureLabels: boolean;
  /** When PC control is on: the control box and pointer anchor to draw. */
  control?: ControlView | null;
}

interface Ripple { x: number; y: number; t0: number; color: string; big: boolean }
interface Pt { x: number; y: number; z: number }

const PALM_RING = [LM.WRIST, LM.THUMB_CMC, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
const FINGER_WIDTH: Record<string, number> = { thumb: 0.3, index: 0.26, middle: 0.27, ring: 0.25, pinky: 0.21 };
const UNDERLAY = 'rgba(34, 30, 27, 0.55)';
const FONT = `"Archivo Variable", Archivo, "Segoe UI", system-ui, sans-serif`;

export class SkeletonRenderer {
  private ctx: CanvasRenderingContext2D;
  private off = document.createElement('canvas');
  private offCtx = this.off.getContext('2d')!;
  private ripples: Ripple[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Match the backing store to the displayed size (crisp on HiDPI). */
  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = this.off.width = w;
    this.canvas.height = this.off.height = h;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
  }

  /** Display-space (0..1, already mirrored) ripple, e.g. when a drag starts. */
  addRipple(x: number, y: number, color: string = PALETTE.bone, big = false): void {
    this.ripples.push({ x, y, t0: performance.now(), color, big });
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  draw(hands: HandFeatures[], gestures: Map<string, HandGestureState>, opts: RenderOptions, now: number): void {
    this.resize();
    this.ctx.clearRect(0, 0, this.w, this.h);
    for (const hand of hands) {
      const pts = hand.image.map((p) => this.toPx(p, opts.mirror));
      const palmPx = Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y);
      const tint = HAND_COLORS[hand.handedness] ?? PALETTE.bone;
      if (opts.outline) this.drawOutline(pts, palmPx, tint);
      if (opts.skeleton) {
        this.drawPalm(pts, palmPx);
        this.drawContacts(hand, pts, palmPx);
        this.drawBones(pts, palmPx);
        this.drawJoints(pts, palmPx);
        if (opts.landmarkIds) this.drawIds(pts, palmPx);
      }
      this.drawLabel(hand, opts.gestureLabels ? gestures.get(hand.id) : undefined, pts, palmPx, tint);
    }
    if (opts.control) this.drawControl(opts.control);
    this.drawRipples(now);
  }

  /** The part of the picture that maps to the screen, plus where the pointer is anchored. */
  private drawControl(c: ControlView) {
    const ctx = this.ctx;
    const m = c.margin;
    const tint = HAND_COLORS[c.hand] ?? PALETTE.bone;
    ctx.save();
    ctx.setLineDash(c.state === 'paused' ? [6 * this.dpr, 6 * this.dpr] : []);
    ctx.lineWidth = 2 * this.dpr;
    ctx.strokeStyle = c.state === 'paused' ? 'rgba(235, 231, 225, 0.5)' : tint;
    ctx.strokeRect(m * this.w, m * this.h, (1 - 2 * m) * this.w, (1 - 2 * m) * this.h);
    ctx.setLineDash([]);
    if (c.anchor && c.state === 'active') {
      const x = c.anchor.x * this.w;
      const y = c.anchor.y * this.h;
      const r = 9 * this.dpr;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.dragging ? tint : 'transparent';
      ctx.fill();
      ctx.lineWidth = 2.5 * this.dpr;
      ctx.strokeStyle = tint;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - r * 1.8, y); ctx.lineTo(x - r * 0.6, y);
      ctx.moveTo(x + r * 0.6, y); ctx.lineTo(x + r * 1.8, y);
      ctx.moveTo(x, y - r * 1.8); ctx.lineTo(x, y - r * 0.6);
      ctx.moveTo(x, y + r * 0.6); ctx.lineTo(x, y + r * 1.8);
      ctx.stroke();
    }
    ctx.restore();
  }

  private toPx(p: { x: number; y: number; z: number }, mirror: boolean): Pt {
    return { x: (mirror ? 1 - p.x : p.x) * this.w, y: p.y * this.h, z: p.z };
  }

  /** Depth cue: points closer to the camera than the wrist are drawn a little larger. */
  private depthScale(p: Pt): number {
    return Math.max(0.8, Math.min(1.3, 1 - p.z * 4));
  }

  private chain(f: (typeof FINGERS)[number]): number[] {
    return [f === 'thumb' ? LM.WRIST : FINGER_JOINTS[f][0], ...FINGER_JOINTS[f]];
  }

  private path(ctx: CanvasRenderingContext2D, pts: Pt[], idx: number[], close = false) {
    ctx.beginPath();
    idx.forEach((i, n) => (n ? ctx.lineTo(pts[i].x, pts[i].y) : ctx.moveTo(pts[i].x, pts[i].y)));
    if (close) ctx.closePath();
  }

  private silhouette(ctx: CanvasRenderingContext2D, pts: Pt[], palmPx: number, extra: number) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const f of FINGERS) {
      ctx.lineWidth = palmPx * FINGER_WIDTH[f] + extra * 2;
      this.path(ctx, pts, this.chain(f));
      ctx.stroke();
    }
    ctx.lineWidth = palmPx * 0.3 + extra * 2;
    this.path(ctx, pts, PALM_RING, true);
    ctx.fill();
    ctx.stroke();
  }

  /** Hand-shaped outline: the silhouette of finger capsules + palm, drawn as a ring in the hand's tint. */
  private drawOutline(pts: Pt[], palmPx: number, tint: string) {
    const o = this.offCtx;
    const ring = Math.max(1.5, palmPx * 0.02);
    o.globalCompositeOperation = 'source-over';
    o.clearRect(0, 0, this.w, this.h);
    o.fillStyle = o.strokeStyle = tint;
    this.silhouette(o, pts, palmPx, ring);
    o.globalCompositeOperation = 'destination-out';
    this.silhouette(o, pts, palmPx, 0);
    o.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(this.off, 0, 0);
  }

  private drawPalm(pts: Pt[], palmPx: number) {
    const ctx = this.ctx;
    this.path(ctx, pts, PALM_RING, true);
    ctx.fillStyle = 'rgba(235, 231, 225, 0.12)';
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, palmPx * 0.022);
    ctx.strokeStyle = 'rgba(235, 231, 225, 0.75)';
    ctx.stroke();
  }

  private drawBones(pts: Pt[], palmPx: number) {
    const ctx = this.ctx;
    const width = Math.max(2, palmPx * 0.045);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const f of FINGERS) {
      const idx = this.chain(f).slice(f === 'thumb' ? 0 : 1); // non-thumb MCP→wrist edges belong to the palm
      this.path(ctx, pts, idx);
      ctx.lineWidth = width + 3 * this.dpr;
      ctx.strokeStyle = UNDERLAY;
      ctx.stroke();
      ctx.lineWidth = width;
      ctx.strokeStyle = FINGER_COLORS[f];
      ctx.stroke();
    }
  }

  private drawJoints(pts: Pt[], palmPx: number) {
    const ctx = this.ctx;
    const base = Math.max(2.5, palmPx * 0.035);
    for (const f of FINGERS) {
      const [first, j1, j2, tip] = FINGER_JOINTS[f];
      for (const idx of [first, j1, j2]) {
        const p = pts[idx];
        const r = base * this.depthScale(p);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = PALETTE.bone;
        ctx.fill();
        ctx.lineWidth = Math.max(1.2, r * 0.45);
        ctx.strokeStyle = PALETTE.soot;
        ctx.stroke();
      }
      const p = pts[tip];
      const r = base * 1.55 * this.depthScale(p);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = FINGER_COLORS[f];
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.3);
      ctx.strokeStyle = PALETTE.bone;
      ctx.stroke();
    }
    // Wrist: a square, so it never reads as a joint.
    const w = pts[LM.WRIST];
    const s = base * 1.8;
    ctx.beginPath();
    ctx.rect(w.x - s, w.y - s, s * 2, s * 2);
    ctx.fillStyle = PALETTE.bone;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, s * 0.25);
    ctx.strokeStyle = PALETTE.soot;
    ctx.stroke();
  }

  private drawContacts(hand: HandFeatures, pts: Pt[], palmPx: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    for (const c of hand.contacts) {
      if (c.state === 'apart') continue;
      const a = pts[FINGERTIPS[c.a]];
      const b = pts[FINGERTIPS[c.b]];
      const touching = c.state === 'touching';
      ctx.setLineDash(touching ? [] : [4 * this.dpr, 5 * this.dpr]);
      ctx.lineWidth = touching ? Math.max(3, palmPx * 0.05) : Math.max(1.5, palmPx * 0.018);
      ctx.strokeStyle = touching ? PALETTE.bone : 'rgba(235, 231, 225, 0.7)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (touching) {
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(8, palmPx * 0.13), 0, Math.PI * 2);
        ctx.lineWidth = 2 * this.dpr;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawIds(pts: Pt[], palmPx: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `600 ${Math.max(10, palmPx * 0.08)}px ${FONT}`;
    ctx.fillStyle = PALETTE.bone;
    ctx.strokeStyle = PALETTE.soot;
    ctx.lineWidth = 3;
    ctx.textBaseline = 'bottom';
    pts.forEach((p, i) => {
      ctx.strokeText(String(i), p.x + 5, p.y - 4);
      ctx.fillText(String(i), p.x + 5, p.y - 4);
    });
    ctx.restore();
  }

  /** One tag per hand, above it: hand name plus the sign it is making. */
  private drawLabel(hand: HandFeatures, g: HandGestureState | undefined, pts: Pt[], palmPx: number, tint: string) {
    let minY = Infinity, minX = Infinity, maxX = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p.y); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
    const sign = g?.primary ? GESTURE_META[g.primary].label : null;
    const text = sign ? `${hand.handedness}: ${sign}` : hand.handedness;
    this.tag(text, (minX + maxX) / 2, minY - Math.max(22, palmPx * 0.28), tint);
  }

  private tag(text: string, x: number, y: number, tint: string) {
    const ctx = this.ctx;
    const size = Math.round(14 * this.dpr);
    ctx.save();
    ctx.font = `650 ${size}px ${FONT}`;
    const tw = ctx.measureText(text).width;
    const padX = size * 0.6;
    const h = size * 1.8;
    const sw = size * 0.55; // tint swatch
    const bw = tw + padX * 2 + sw + size * 0.45;
    const bx = Math.max(4, Math.min(this.w - bw - 4, x - bw / 2));
    const by = Math.max(4, Math.min(this.h - h - 4, y - h / 2));
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, h, 5 * this.dpr);
    ctx.fillStyle = PALETTE.soot;
    ctx.fill();
    ctx.fillStyle = tint;
    ctx.fillRect(bx + padX, by + (h - sw) / 2, sw, sw);
    ctx.fillStyle = PALETTE.bone;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + padX + sw + size * 0.45, by + h / 2 + 1);
    ctx.restore();
  }

  private drawRipples(now: number) {
    const ctx = this.ctx;
    this.ripples = this.ripples.filter((r) => now - r.t0 < 500);
    for (const r of this.ripples) {
      const k = (now - r.t0) / 500;
      ctx.beginPath();
      ctx.arc(r.x * this.w, r.y * this.h, (r.big ? 70 : 44) * this.dpr * (0.25 + k), 0, Math.PI * 2);
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = (r.big ? 4 : 2.5) * this.dpr;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}
