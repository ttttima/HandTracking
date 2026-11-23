/**
 * Dashboard: the status line and one readout per hand (left and right are detected and shown
 * independently). Each readout shows the sign that hand is making right now, set large, with
 * letter width following how open the hand is, plus five finger bars explaining the reading.
 */
import { FINGER_COLORS, GESTURE_META } from '../config';
import { FINGERS, type FingerName, type HandFeatures, type HandGestureState, type Handedness } from '../types';
import { $, el, setText } from './dom';

export type StatusState = 'loading' | 'ready' | 'live' | 'error';

const FINGER_LABEL: Record<FingerName, string> = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' };
/** Archivo's width axis runs 62%–125%; a fist reads narrow, an open hand wide. */
const STRETCH_MIN = 64;
const STRETCH_MAX = 122;

export interface FrameView {
  hands: HandFeatures[];
  gestures: Map<string, HandGestureState>;
  gesturesEnabled: boolean;
  mirror: boolean;
  frameWidth: number;
  frameHeight: number;
}

interface Panel {
  side: Handedness;
  root: HTMLElement;
  sign: HTMLElement;
  meta: HTMLElement;
  bars: Record<FingerName, { li: HTMLElement; fill: HTMLElement }>;
}

export class Dashboard {
  private statusEl = $('status');
  private statusText = $('status-text');
  private panels: Record<Handedness, Panel>;
  private lastUpdate = 0;

  constructor() {
    this.panels = { Left: this.buildPanel('Left', $('hand-left')), Right: this.buildPanel('Right', $('hand-right')) };
  }

  private buildPanel(side: Handedness, root: HTMLElement): Panel {
    const list = root.querySelector('[data-role="fingers"]') as HTMLElement;
    const bars = {} as Panel['bars'];
    for (const f of FINGERS) {
      const li = el('li');
      const bar = el('span', 'bar');
      const fill = el('span');
      fill.style.background = FINGER_COLORS[f];
      bar.append(fill);
      li.append(bar, document.createTextNode(FINGER_LABEL[f]));
      list.append(li);
      bars[f] = { li, fill };
    }
    return {
      side,
      root,
      sign: root.querySelector('[data-role="sign"]') as HTMLElement,
      meta: root.querySelector('[data-role="meta"]') as HTMLElement,
      bars,
    };
  }

  // ── Status / overlays ─────────────────────────────────────────────────

  setStatus(state: StatusState, text: string): void {
    this.statusEl.dataset.state = state;
    setText(this.statusText, text);
  }

  setMetrics(m: { fps: number; backend: string; latency?: number; hands?: number }): void {
    setText($('m-fps'), m.fps ? m.fps.toFixed(0) : '0');
    setText($('m-backend'), m.backend);
  }

  setEmpty(state: { title: string; text: string; error?: boolean; camera?: boolean; file?: boolean } | null): void {
    const box = $('stage-empty');
    box.hidden = !state;
    if (!state) return;
    box.classList.toggle('error', !!state.error);
    setText($('empty-title'), state.title);
    setText($('empty-text'), state.text);
    $('btn-empty-camera').hidden = !state.camera;
    $('btn-empty-file').hidden = !state.file;
  }

  /** Keeps each readout on the same side of the screen as the hand it describes. */
  setMirror(mirror: boolean): void {
    $('layout').classList.toggle('unmirrored', !mirror);
  }

  toast(text: string, kind: 'info' | 'error' = 'info', ms = 4000): void {
    const t = el('div', `toast ${kind}`, text);
    $('toasts').append(t);
    window.setTimeout(() => t.remove(), ms);
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  update(view: FrameView, now: number): void {
    if (now - this.lastUpdate < 33) return;
    this.lastUpdate = now;
    const assigned = assignHands(view.hands);
    for (const side of ['Left', 'Right'] as const) {
      const hand = assigned[side];
      this.renderPanel(this.panels[side], hand, hand ? view.gestures.get(hand.id) : undefined, view.gesturesEnabled);
    }
  }

  renderEmptyPanels(): void {
    for (const side of ['Left', 'Right'] as const) this.renderPanel(this.panels[side], undefined, undefined, true);
  }

  private renderPanel(p: Panel, hand: HandFeatures | undefined, g: HandGestureState | undefined, enabled: boolean) {
    const present = !!hand;
    if (p.root.dataset.present !== String(present)) p.root.dataset.present = String(present);

    if (!hand) {
      setText(p.sign, 'Not in view');
      setText(p.meta, `Raise your ${p.side.toLowerCase()} hand`);
      p.sign.style.setProperty('--stretch', '100%');
      fitOneLine(p.sign);
      for (const f of FINGERS) {
        p.bars[f].fill.style.height = '0%';
        p.bars[f].li.classList.remove('out');
      }
      return;
    }

    const openness = FINGERS.reduce((a, f) => a + hand.fingers[f].extension, 0) / FINGERS.length;
    p.sign.style.setProperty('--stretch', `${(STRETCH_MIN + openness * (STRETCH_MAX - STRETCH_MIN)).toFixed(1)}%`);

    const out = hand.extendedCount;
    const fingersText = `${out} ${out === 1 ? 'finger' : 'fingers'} out`;
    if (!enabled) {
      setText(p.sign, 'Tracking');
      setText(p.meta, `${fingersText}, sign recognition is off`);
    } else if (g?.primary) {
      setText(p.sign, GESTURE_META[g.primary].label);
      const held = `Held for ${(g.primaryHeldMs / 1000).toFixed(1)} s`;
      setText(p.meta, g.pinchPhase === 'dragging' ? `${held}, dragging` : `${held}, ${Math.round(g.scores[g.primary] * 100)}% match`);
    } else {
      setText(p.sign, 'No sign');
      setText(p.meta, fingersText);
    }

    fitOneLine(p.sign);

    for (const f of FINGERS) {
      const info = hand.fingers[f];
      const h = `${(info.extension * 100).toFixed(0)}%`;
      if (p.bars[f].fill.style.height !== h) p.bars[f].fill.style.height = h;
      p.bars[f].li.classList.toggle('out', info.extended);
    }
  }
}

/** Shrink the font just enough for the text to fit on one line in its panel. */
function fitOneLine(e: HTMLElement): void {
  e.style.fontSize = '';
  const over = e.scrollWidth / Math.max(1, e.clientWidth);
  if (over > 1) e.style.fontSize = `${parseFloat(getComputedStyle(e).fontSize) / over / 1.02}px`;
}

/**
 * Decide which detected hand is the left and which the right. Normally MediaPipe's handedness
 * label decides; if both hands carry the same label, fall back to position (in the un-mirrored
 * camera image your left hand is the one further right).
 */
export function assignHands(hands: HandFeatures[]): Partial<Record<Handedness, HandFeatures>> {
  const left = hands.filter((h) => h.handedness === 'Left');
  const right = hands.filter((h) => h.handedness === 'Right');
  if (left.length <= 1 && right.length <= 1) return { Left: left[0], Right: right[0] };
  const byX = [...hands].sort((a, b) => b.image[0].x - a.image[0].x);
  return { Left: byX[0], Right: byX[1] };
}
