/**
 * Turns raw landmarks into hand features: palm size, per-finger extension, fingertip
 * contacts, orientation. All distances are normalised by palm size, so thresholds are
 * independent of how far the hand is from the camera. Hysteresis state is kept per hand.
 */
import { thresholds as T, type Thresholds } from '../config';
import {
  FINGERS, FINGER_JOINTS, FINGERTIPS, LM,
  type ContactInfo, type ContactState, type FingerInfo, type FingerName, type HandFeatures, type RawHand, type Vec3,
} from '../types';
import { angleBetween, centroid, cross, dist, dist2D, jointBend, smoothstep, sub } from './vec';

export const CONTACT_PAIRS: [FingerName, FingerName][] = [];
for (let i = 0; i < FINGERS.length; i++)
  for (let j = i + 1; j < FINGERS.length; j++) CONTACT_PAIRS.push([FINGERS[i], FINGERS[j]]);

export const contactKey = (a: FingerName, b: FingerName) => `${a}-${b}`;

/** Weighted bend (degrees) of a finger. 0 = straight; ~200+ = tight fist. */
export function fingerBend(w: Vec3[], f: FingerName): number {
  const [a, b, c, d] = FINGER_JOINTS[f];
  if (f === 'thumb') return jointBend(w[a], w[b], w[c]) + jointBend(w[b], w[c], w[d]);
  const mcp = jointBend(w[LM.WRIST], w[a], w[b]);
  const pip = jointBend(w[a], w[b], w[c]);
  const dip = jointBend(w[b], w[c], w[d]);
  return pip + dip + 0.5 * mcp;
}

export function palmSize(w: Vec3[]): number {
  // Wrist → middle MCP is rigid and rotation-invariant in 3D world space.
  return Math.max(1e-4, dist(w[LM.WRIST], w[LM.MIDDLE_MCP]));
}

/**
 * How far the thumb tip reaches beyond its IP joint, measured away from the pinky base.
 * Positive = thumb sticking out, negative = thumb tucked across the palm.
 */
export function thumbOutness(w: Vec3[], palm: number): number {
  return (dist(w[LM.THUMB_TIP], w[LM.PINKY_MCP]) - dist(w[LM.THUMB_IP], w[LM.PINKY_MCP])) / palm;
}

/** Continuous extension score 0..1 for a finger. */
export function fingerExtension(w: Vec3[], f: FingerName, palm: number, t: Thresholds = T): number {
  const bend = fingerBend(w, f);
  if (f === 'thumb') {
    const straight = 1 - smoothstep(t.thumbStraightBend, t.thumbFoldedBend, bend);
    const out = smoothstep(t.thumbOutMin, t.thumbOutMax, thumbOutness(w, palm));
    return Math.min(straight, out);
  }
  return 1 - smoothstep(t.fingerStraightBend, t.fingerFoldedBend, bend);
}

/**
 * How far apart the four fingers are fanned: the mean angle (degrees) between the directions
 * of neighbouring fingers (knuckle → fingertip), measured in 3-D so it ignores hand rotation.
 */
export function fingerSpread(w: Vec3[]): number {
  const g = fingerGaps(w);
  return (g[0] + g[1] + g[2]) / 3;
}

/** Angle (degrees) between each pair of neighbouring fingers: [index–middle, middle–ring, ring–pinky]. */
export function fingerGaps(w: Vec3[]): [number, number, number] {
  const dirs = (['index', 'middle', 'ring', 'pinky'] as const).map((f) => {
    const [mcp, , , tip] = FINGER_JOINTS[f];
    return sub(w[tip], w[mcp]);
  });
  return [angleBetween(dirs[0], dirs[1]), angleBetween(dirs[1], dirs[2]), angleBetween(dirs[2], dirs[3])];
}

/** Image-space area enclosed by thumb (MCP→tip) and index (tip→MCP), in palm sizes squared. */
export function ringArea(img: Vec3[], aspect: number, palmImage: number): number {
  const loop = [LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_TIP, LM.INDEX_TIP, LM.INDEX_DIP, LM.INDEX_PIP, LM.INDEX_MCP];
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = img[loop[i]];
    const q = img[loop[(i + 1) % loop.length]];
    a += p.x * aspect * q.y - q.x * aspect * p.y;
  }
  return Math.abs(a) / 2 / (palmImage * palmImage);
}

/** Image-space direction of the thumb: +1 = pointing straight up, −1 = straight down. */
export function thumbVertical(img: Vec3[], aspect: number): number {
  const base = img[LM.THUMB_MCP];
  const tip = img[LM.THUMB_TIP];
  const dx = (tip.x - base.x) * aspect;
  const dy = tip.y - base.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-6 ? 0 : -dy / len;
}

interface HandMemory {
  extended: Record<FingerName, boolean>;
  contacts: Record<string, ContactState>;
}

function nextContactState(prev: ContactState | undefined, d: number, t: Thresholds): ContactState {
  if (d < t.touchEnter || (prev === 'touching' && d < t.touchExit)) return 'touching';
  if (d < t.nearEnter || ((prev === 'near' || prev === 'touching') && d < t.nearExit)) return 'near';
  return 'apart';
}

export class HandAnalyzer {
  private memory = new Map<string, HandMemory>();

  constructor(private t: Thresholds = T) {}

  forget(id: string): void {
    this.memory.delete(id);
  }

  /**
   * @param aspect frame width / height, used to make image-space distances isotropic.
   */
  analyze(hand: RawHand, id: string, timestamp: number, aspect: number): HandFeatures {
    const t = this.t;
    const img = hand.landmarks;
    // World landmarks give metric, depth-aware geometry. Fall back to image space if absent.
    const w = hand.worldLandmarks?.length === 21
      ? hand.worldLandmarks
      : img.map((p) => ({ x: p.x * aspect, y: p.y, z: p.z }));

    let mem = this.memory.get(id);
    if (!mem) {
      mem = {
        extended: { thumb: false, index: false, middle: false, ring: false, pinky: false },
        contacts: {},
      };
      this.memory.set(id, mem);
    }

    const palm = palmSize(w);
    const fingers = {} as Record<FingerName, FingerInfo>;
    let extendedCount = 0;
    for (const f of FINGERS) {
      const extension = fingerExtension(w, f, palm, t);
      const was = mem.extended[f];
      const extended = was ? extension > t.extendOff : extension >= t.extendOn;
      mem.extended[f] = extended;
      if (extended) extendedCount++;
      fingers[f] = { name: f, extended, extension, bend: fingerBend(w, f) };
    }

    const contacts: ContactInfo[] = [];
    const contactMap: Record<string, ContactInfo> = {};
    for (const [a, b] of CONTACT_PAIRS) {
      const key = contactKey(a, b);
      const d = dist(w[FINGERTIPS[a]], w[FINGERTIPS[b]]) / palm;
      const state = nextContactState(mem.contacts[key], d, t);
      mem.contacts[key] = state;
      const c: ContactInfo = { key, a, b, distance: d, state };
      contacts.push(c);
      contactMap[key] = c;
    }

    const wrist = img[LM.WRIST];
    const mid = img[LM.MIDDLE_MCP];
    const roll = (Math.atan2((mid.x - wrist.x) * aspect, -(mid.y - wrist.y)) * 180) / Math.PI;

    const normal = cross(sub(w[LM.INDEX_MCP], w[LM.WRIST]), sub(w[LM.PINKY_MCP], w[LM.WRIST]));
    const palmFacing = hand.handedness === 'Right' ? normal.z < 0 : normal.z > 0;

    return {
      id,
      handedness: hand.handedness,
      score: hand.score,
      timestamp,
      image: img,
      rawImage: (hand as RawHand & { rawLandmarks?: Vec3[] }).rawLandmarks ?? img,
      world: w,
      palmSize: palm,
      palmSizeImage: Math.max(1e-4, dist2D(wrist, mid, aspect)),
      palmCenter: centroid([0, 5, 9, 13, 17].map((i) => img[i])),
      fingers,
      extendedCount,
      contacts,
      contactMap,
      pinchDistance: contactMap[contactKey('thumb', 'index')].distance,
      indexReach: dist(w[LM.INDEX_TIP], w[LM.WRIST]) / palm,
      spread: fingerSpread(w),
      gaps: fingerGaps(w),
      ringArea: ringArea(img, aspect, Math.max(1e-4, dist2D(wrist, mid, aspect))),
      roll,
      palmFacing,
    };
  }
}
