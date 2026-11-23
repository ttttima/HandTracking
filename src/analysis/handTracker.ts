/**
 * Keeps hand identities stable across frames and applies One Euro smoothing.
 *
 * MediaPipe returns hands in arbitrary order and its handedness label can flicker for a
 * frame or two, so hands are matched to existing tracks by wrist proximity and the
 * handedness label is decided by a running vote.
 */
import { thresholds as T, type Thresholds } from '../config';
import type { DetectionFrame, Handedness, RawHand, Vec3 } from '../types';
import { PointSetFilter } from './oneEuro';
import { dist2D } from './vec';

export interface TrackedHand extends RawHand {
  id: string;
  /** The detector's landmarks before smoothing (the mouse pointer filters these itself). */
  rawLandmarks?: Vec3[];
}

interface Track {
  id: string;
  vote: number; // > 0 → Right, < 0 → Left
  handedness: Handedness;
  wrist: Vec3;
  lastSeen: number;
  img: PointSetFilter;
  world: PointSetFilter;
}

export class HandTracker {
  smoothing = true;
  /** Tracks unseen for longer than this are dropped (and their filters reset). */
  forgetAfterMs = 400;
  /** Max wrist movement between frames (fraction of frame height) to keep the same id. */
  matchRadius = 0.25;
  private tracks: Track[] = [];
  private nextSerial = 1;

  constructor(private t: Thresholds = T) {}

  reset(): void {
    this.tracks = [];
  }

  update(frame: DetectionFrame, now: number): TrackedHand[] {
    const aspect = frame.width / Math.max(1, frame.height);
    this.tracks = this.tracks.filter((tr) => now - tr.lastSeen <= this.forgetAfterMs);
    // The model occasionally returns a hand with a NaN coordinate; such a detection is useless and
    // would spread NaN into smoothing, gestures and the mouse pointer. Treat it as not detected.
    const valid = frame.hands.filter((h) => h.landmarks.length === 21 && h.landmarks.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
    frame = { ...frame, hands: dedupeHands(valid, aspect) };

    // Greedy nearest-wrist matching.
    const claimed = new Set<Track>();
    const assignments = frame.hands.map((hand) => {
      let best: Track | null = null;
      let bestD = this.matchRadius;
      for (const tr of this.tracks) {
        if (claimed.has(tr)) continue;
        const d = dist2D(tr.wrist, hand.landmarks[0], aspect);
        // Prefer tracks with the same label by penalising mismatches.
        const penalty = tr.handedness === hand.handedness ? 0 : 0.08;
        if (d + penalty < bestD) { bestD = d + penalty; best = tr; }
      }
      if (best) claimed.add(best);
      return best;
    });

    return frame.hands.map((hand, i) => {
      let tr = assignments[i];
      if (!tr) {
        const used = new Set(this.tracks.map((x) => x.id));
        let id: string = hand.handedness;
        if (used.has(id)) id = `${hand.handedness}#${++this.nextSerial}`;
        tr = {
          id,
          vote: hand.handedness === 'Right' ? 1 : -1,
          handedness: hand.handedness,
          wrist: hand.landmarks[0],
          lastSeen: now,
          img: new PointSetFilter(21, this.t.smoothMinCutoff, this.t.smoothBeta),
          world: new PointSetFilter(21, this.t.smoothMinCutoff, this.t.smoothBeta * 4),
        };
        this.tracks.push(tr);
        claimed.add(tr);
      }
      // Handedness vote: weighted by confidence, clamped so a real change flips within ~8 frames.
      tr.vote = Math.max(-4, Math.min(4, tr.vote + (hand.handedness === 'Right' ? 1 : -1) * hand.score));
      tr.handedness = tr.vote >= 0 ? 'Right' : 'Left';
      tr.wrist = hand.landmarks[0];
      tr.lastSeen = now;

      let landmarks = hand.landmarks;
      let worldLandmarks = hand.worldLandmarks;
      if (this.smoothing) {
        tr.img.setParams(this.t.smoothMinCutoff, this.t.smoothBeta);
        tr.world.setParams(this.t.smoothMinCutoff, this.t.smoothBeta * 4);
        landmarks = tr.img.apply(landmarks, now);
        if (worldLandmarks.length === 21) worldLandmarks = tr.world.apply(worldLandmarks, now);
      }
      return { ...hand, id: tr.id, handedness: tr.handedness, landmarks, worldLandmarks, rawLandmarks: hand.landmarks };
    });
  }
}

/**
 * MediaPipe occasionally reports one physical hand twice (two overlapping detections).
 * Two hands whose landmarks are, on average, closer than `overlap` palm sizes are treated as
 * the same hand and the more confident detection wins. Two genuinely separate hands are at
 * least about one palm apart on average, even when they touch.
 */
export function dedupeHands<T extends RawHand>(hands: T[], aspect: number, overlap = 0.5): T[] {
  if (hands.length < 2) return hands;
  const sorted = [...hands].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  const palmOf = (h: T) => dist2D(h.landmarks[0], h.landmarks[9], aspect);
  for (const h of sorted) {
    const duplicate = kept.some((k) => {
      // Normalise by the larger palm: a weak duplicate often has a shrunken palm estimate.
      const palm = Math.max(1e-4, palmOf(h), palmOf(k));
      let sum = 0;
      for (let i = 0; i < 21; i++) sum += dist2D(h.landmarks[i], k.landmarks[i], aspect);
      return sum / 21 / palm < overlap;
    });
    if (!duplicate) kept.push(h);
  }
  // Preserve MediaPipe's original order.
  return hands.filter((h) => kept.includes(h));
}
