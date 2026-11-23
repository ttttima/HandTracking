/**
 * Static (single-frame) gesture scoring. Every gesture gets a soft score in 0..1 computed
 * from continuous finger-extension scores and normalised fingertip distances; the
 * gesture engine then applies thresholds + hysteresis + timing on top of these scores.
 *
 * To add a gesture: add its id to GESTURE_IDS (types.ts), its metadata to GESTURES
 * (config.ts) and a scoring rule below.
 */
import { thresholds as T, type Thresholds } from '../config';
import { thumbVertical } from '../analysis/handAnalyzer';
import { smoothstep } from '../analysis/vec';
import { FINGERS, type HandFeatures, type StaticGestureId } from '../types';

/** 1 = must be extended, 0 = must be folded, null = don't care. Order: thumb..pinky. */
type Pattern = readonly (0 | 1 | null)[];

export function patternScore(ext: readonly number[], pattern: Pattern): number {
  let s = 1;
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === null) continue;
    s = Math.min(s, p ? ext[i] : 1 - ext[i]);
  }
  return s;
}


export interface StaticScoreContext {
  aspect: number;
}

export function computeStaticScores(
  h: HandFeatures,
  ctx: StaticScoreContext,
  t: Thresholds = T,
): Record<StaticGestureId, number> {
  const ext = FINGERS.map((f) => h.fingers[f].extension);
  const [thumb] = ext;

  // Thumb–index interaction strengths.
  const d = h.pinchDistance;
  const pinchStrength = 1 - smoothstep(t.pinchFull, t.pinchNone, d);
  // A fist also brings the thumb near the index; require the index to reach out.
  const reach = smoothstep(t.pinchMinIndexReach - 0.15, t.pinchMinIndexReach + 0.1, h.indexReach);

  const vertical = thumbVertical(h.image, ctx.aspect);
  const up = smoothstep(t.thumbVerticalMin - 0.2, t.thumbVerticalMin + 0.1, vertical);
  const down = smoothstep(t.thumbVerticalMin - 0.2, t.thumbVerticalMin + 0.1, -vertical);
  const thumbOnly = patternScore(ext, [1, 0, 0, 0, 0]);

  // 0 = fingers held together, 1 = fanned out.
  const spread = smoothstep(t.fingersTogetherDeg, t.fingersSpreadDeg, h.spread);
  const fourOut = patternScore(ext, [null, 1, 1, 1, 1]);
  const closedPalm = Math.min(fourOut, 1 - spread);

  const pinch = Math.min(pinchStrength, reach);

  return {
    open_palm: Math.min(patternScore(ext, [1, 1, 1, 1, 1]), spread),
    closed_palm: closedPalm,
    middle_finger: patternScore(ext, [null, 0, 1, 0, 0]),
    // A pinch with a curled index looks fist-like; never let it count as a fist (holding a fist pauses PC control).
    fist: Math.min(patternScore(ext, [null, 0, 0, 0, 0]), 1 - smoothstep(0.75, 1, thumb), 1 - pinch),
    // Index out but thumb pressed onto it is a pinch, not pointing.
    pointing: Math.min(patternScore(ext, [null, 1, 0, 0, 0]), 1 - pinchStrength),
    peace: patternScore(ext, [0, 1, 1, 0, 0]),
    pinch,
    thumbs_up: Math.min(thumbOnly, up),
    thumbs_down: Math.min(thumbOnly, down),
  };
}
