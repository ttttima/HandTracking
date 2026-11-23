/**
 * Central application configuration.
 *
 * All gesture thresholds are expressed in hand-size-normalised units (distance / palm size)
 * or in degrees, so they behave the same whether your hand is close to or far from the camera.
 * Every value in `thresholds` can be tuned live from the ⚙ Sensitivity panel; changes are
 * persisted to localStorage. Edit the defaults here to change the out-of-the-box behaviour.
 */
import type { FingerName, StaticGestureId } from './types';

export const MODEL_CONFIG = {
  /** Local copies created by `npm run setup` (served from /public). */
  wasmPath: `${import.meta.env.BASE_URL}mediapipe/wasm`,
  modelPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`,
  /** Fallbacks used automatically if the local files are missing. */
  wasmFallback: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm',
  modelFallback:
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  numHands: 2,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  /** Try the GPU (WebGL) delegate first; fall back to CPU (WASM SIMD) on failure. */
  preferGpu: true,
  /**
   * MediaPipe reports the subject's real hand for un-mirrored frames (which is what we feed it;
   * mirroring is purely visual). Flip this if your camera driver already mirrors its output.
   */
  swapHandedness: false,
};

export const CAMERA_CONFIG = {
  idealWidth: 1280,
  idealHeight: 720,
  idealFrameRate: 60,
  facingMode: 'user' as const,
};

export interface Thresholds {
  // ── Finger extension (degrees of weighted joint bend) ──────────────────────
  /** Bend below which a finger counts as fully extended. */
  fingerStraightBend: number;
  /** Bend above which a finger counts as fully folded. */
  fingerFoldedBend: number;
  /** Thumb joint bend below which the thumb counts as straight. */
  thumbStraightBend: number;
  /** Thumb joint bend above which the thumb counts as folded. */
  thumbFoldedBend: number;
  /**
   * "Thumb out" measure = (tip→pinky-MCP − IP→pinky-MCP) / palm size. Positive when the thumb
   * tip points away from the palm, negative when it is tucked across it.
   * Below `thumbOutMin` the thumb counts as tucked, above `thumbOutMax` as clearly out.
   */
  thumbOutMin: number;
  thumbOutMax: number;
  /** Extension score needed to flip a finger to "extended" (hysteresis upper bound). */
  extendOn: number;
  /** Extension score needed to flip a finger back to "folded" (hysteresis lower bound). */
  extendOff: number;

  // ── Fingertip contacts (palm-size-normalised distance) ─────────────────────
  touchEnter: number;
  touchExit: number;
  nearEnter: number;
  nearExit: number;
  /** Thumb–index distance at which pinch strength is 100%. */
  pinchFull: number;
  /** Thumb–index distance at which pinch strength falls to 0%. */
  pinchNone: number;
  /** Minimum index fingertip reach (palm sizes from wrist) for a pinch — rejects fists. */
  pinchMinIndexReach: number;

  // ── Gesture activation ─────────────────────────────────────────────────────
  gestureOn: number;
  gestureOff: number;
  /** Score must stay above `gestureOn` this long before a gesture activates. */
  stableMs: number;
  /** Score must stay below `gestureOff` this long before a gesture deactivates. */
  releaseMs: number;
  /** Thumb direction (−1..1, 1 = straight up) needed for thumbs up / down. */
  thumbVerticalMin: number;
  /** Mean angle between neighbouring fingers below which they count as held together (closed palm). */
  fingersTogetherDeg: number;
  /** Mean angle between neighbouring fingers above which they count as spread (open palm). */
  fingersSpreadDeg: number;

  // ── Temporal gestures ──────────────────────────────────────────────────────
  /** Hold a thumb–index touch this long to start a drag. */
  dragHoldMs: number;
  /** Hold a static gesture this long to fire a `gesture:hold` event (e.g. OK hold). */
  holdMs: number;
  /** Swipe: minimum travel in palm sizes within the window. */
  swipeMinDistance: number;
  /** Swipe: minimum speed in palm sizes per second. */
  swipeMinSpeed: number;
  swipeWindowMs: number;
  swipeCooldownMs: number;
  swipeMinExtended: number;

  // ── Smoothing (One Euro filter) ────────────────────────────────────────────
  smoothMinCutoff: number;
  smoothBeta: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  fingerStraightBend: 55,
  fingerFoldedBend: 125,
  thumbStraightBend: 35,
  thumbFoldedBend: 80,
  thumbOutMin: -0.02,
  thumbOutMax: 0.12,
  extendOn: 0.6,
  extendOff: 0.4,

  touchEnter: 0.25,
  touchExit: 0.33,
  nearEnter: 0.55,
  nearExit: 0.65,
  pinchFull: 0.2,
  pinchNone: 0.55,
  pinchMinIndexReach: 1.05,

  gestureOn: 0.6,
  gestureOff: 0.45,
  stableMs: 90,
  releaseMs: 140,
  thumbVerticalMin: 0.55,
  fingersTogetherDeg: 6,
  fingersSpreadDeg: 10,

  dragHoldMs: 480,
  holdMs: 900,
  swipeMinDistance: 1.6,
  swipeMinSpeed: 5,
  swipeWindowMs: 320,
  swipeCooldownMs: 750,
  swipeMinExtended: 3,

  smoothMinCutoff: 1.4,
  smoothBeta: 9,
};

export interface ThresholdField {
  key: keyof Thresholds;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  help: string;
}

/** Schema used to auto-generate the Sensitivity panel. */
export const THRESHOLD_GROUPS: { title: string; fields: ThresholdField[] }[] = [
  {
    title: 'Finger extension',
    fields: [
      { key: 'fingerStraightBend', label: 'Straight below', min: 10, max: 120, step: 1, unit: '°', help: 'Joint bend under which a finger reads as fully extended.' },
      { key: 'fingerFoldedBend', label: 'Folded above', min: 60, max: 220, step: 1, unit: '°', help: 'Joint bend over which a finger reads as fully folded.' },
      { key: 'thumbStraightBend', label: 'Thumb straight below', min: 5, max: 90, step: 1, unit: '°', help: 'Thumb MCP+IP bend under which the thumb is straight.' },
      { key: 'thumbFoldedBend', label: 'Thumb folded above', min: 30, max: 160, step: 1, unit: '°', help: 'Thumb MCP+IP bend over which the thumb is folded.' },
      { key: 'thumbOutMin', label: 'Thumb tucked below', min: -0.4, max: 0.3, step: 0.01, unit: '×palm', help: 'How far the thumb tip reaches beyond its IP joint (away from the pinky). Below this the thumb is tucked.' },
      { key: 'thumbOutMax', label: 'Thumb out above', min: -0.2, max: 0.6, step: 0.01, unit: '×palm', help: 'Above this the thumb counts as clearly sticking out.' },
    ],
  },
  {
    title: 'Touch & pinch',
    fields: [
      { key: 'touchEnter', label: 'Touch distance', min: 0.05, max: 0.6, step: 0.01, unit: '×palm', help: 'Fingertips closer than this are touching.' },
      { key: 'touchExit', label: 'Release distance', min: 0.1, max: 0.8, step: 0.01, unit: '×palm', help: 'Touching fingertips separate once further than this (hysteresis).' },
      { key: 'nearEnter', label: 'Near distance', min: 0.2, max: 1.2, step: 0.01, unit: '×palm', help: 'Fingertips closer than this count as approaching.' },
      { key: 'pinchFull', label: 'Pinch 100% at', min: 0.05, max: 0.5, step: 0.01, unit: '×palm', help: 'Thumb–index distance giving full pinch strength.' },
      { key: 'fingersTogetherDeg', label: 'Fingers together under', min: 1, max: 20, step: 0.5, unit: '°', help: 'Average angle between neighbouring fingers below which a flat hand is a closed palm.' },
      { key: 'fingersSpreadDeg', label: 'Fingers spread over', min: 3, max: 30, step: 0.5, unit: '°', help: 'Average angle between neighbouring fingers above which a flat hand is an open palm.' },
      { key: 'pinchNone', label: 'Pinch 0% at', min: 0.2, max: 1.2, step: 0.01, unit: '×palm', help: 'Thumb–index distance where pinch strength reaches zero.' },
    ],
  },
  {
    title: 'Gesture timing',
    fields: [
      { key: 'gestureOn', label: 'Activate score', min: 0.3, max: 0.95, step: 0.01, help: 'Score a gesture must reach to activate.' },
      { key: 'stableMs', label: 'Stable for', min: 0, max: 500, step: 10, unit: 'ms', help: 'How long a gesture must persist before it activates.' },
      { key: 'releaseMs', label: 'Release after', min: 0, max: 600, step: 10, unit: 'ms', help: 'How long a gesture must be gone before it deactivates.' },
      { key: 'holdMs', label: 'Hold to trigger', min: 200, max: 3000, step: 50, unit: 'ms', help: 'Hold a sign (e.g. thumbs up) this long to fire a hold action.' },
      { key: 'swipeMinSpeed', label: 'Swipe speed', min: 1, max: 15, step: 0.1, unit: 'palm/s', help: 'Minimum hand speed for a swipe.' },
    ],
  },
  {
    title: 'Smoothing',
    fields: [
      { key: 'smoothMinCutoff', label: 'Jitter cutoff', min: 0.1, max: 6, step: 0.1, unit: 'Hz', help: 'Lower = smoother but laggier when still.' },
      { key: 'smoothBeta', label: 'Speed response', min: 0, max: 40, step: 0.5, help: 'Higher = less lag during fast motion.' },
    ],
  },
];

const STORAGE_KEY = 'handgestures.thresholds.v1';

/** Live, mutable thresholds object shared by every module (mutated in place by the settings panel). */
export const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };

export function loadThresholds(): void {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Thresholds>;
    for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
      if (typeof saved[k] === 'number' && Number.isFinite(saved[k])) thresholds[k] = saved[k] as number;
    }
  } catch {
    /* storage unavailable or corrupt — keep defaults */
  }
}

export function saveThresholds(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(thresholds));
  } catch {
    /* ignore */
  }
}

export function resetThresholds(): void {
  Object.assign(thresholds, DEFAULT_THRESHOLDS);
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ── Visual style ─────────────────────────────────────────────────────────────
// A tonal palette built around stone #A69F98, with muted earthy neighbours for fingers and hands.

export const PALETTE = {
  stone: '#a69f98',
  bone: '#ebe7e1',
  umber: '#3a3430',
  soot: '#221e1b',
  left: '#9fb3bb', // cool slate, the left hand
  right: '#d9a58c', // warm clay, the right hand
} as const;

export const FINGER_COLORS: Record<FingerName, string> = {
  thumb: '#c9785d', // clay
  index: '#d8ae5c', // ochre
  middle: '#9db27f', // sage
  ring: '#7fa3b4', // slate
  pinky: '#b48bab', // mauve
};
export const HAND_COLORS: Record<string, string> = { Left: PALETTE.left, Right: PALETTE.right };
export const PALM_COLOR = PALETTE.bone;
export const WRIST_COLOR = PALETTE.bone;
export const SIGNAL_COLOR = PALETTE.bone;

export interface GestureMeta {
  id: StaticGestureId;
  label: string;
  description: string;
}

/** Display metadata, in priority order (first active one becomes the primary gesture). */
export const GESTURES: GestureMeta[] = [
  { id: 'pinch', label: 'Pinch', description: 'Thumb and index fingertips together' },
  { id: 'thumbs_up', label: 'Thumbs up', description: 'Thumb points up, the rest are folded' },
  { id: 'thumbs_down', label: 'Thumbs down', description: 'Thumb points down, the rest are folded' },
  { id: 'middle_finger', label: 'Middle finger', description: 'Only the middle finger out' },
  { id: 'peace', label: 'Peace', description: 'Index and middle out, the rest folded' },
  { id: 'pointing', label: 'Pointing', description: 'Only the index finger out' },
  { id: 'closed_palm', label: 'Closed palm', description: 'Flat hand, four fingers out and held together' },
  { id: 'open_palm', label: 'Open palm', description: 'All five fingers out and spread apart' },
  { id: 'fist', label: 'Fist', description: 'All fingers folded' },
];

export const GESTURE_PRIORITY: StaticGestureId[] = GESTURES.map((g) => g.id);

// ── Which gestures are registered at all (Settings → Gestures) ──────────────

/** Movements that can be switched off in addition to the signs. */
export type MovementId = 'swipe';
export type ToggleId = StaticGestureId | MovementId;

/** Shown in Settings. `pc` notes fixed PC behaviour; everything else is set in Keybinds. */
export const GESTURE_TOGGLES: { id: ToggleId; label: string; pc?: string }[] = [
  { id: 'open_palm', label: 'Open palm' },
  { id: 'closed_palm', label: 'Closed palm' },
  { id: 'fist', label: 'Fist' },
  { id: 'pointing', label: 'Pointing' },
  { id: 'peace', label: 'Peace' },
  { id: 'middle_finger', label: 'Middle finger' },
  { id: 'pinch', label: 'Pinch', pc: 'click and drag' },
  { id: 'thumbs_up', label: 'Thumbs up' },
  { id: 'thumbs_down', label: 'Thumbs down' },
  { id: 'swipe', label: 'Swipe' },
];

/** Live, mutable on/off map shared by every module. Missing = on. */
export const enabledGestures: Record<ToggleId, boolean> = Object.fromEntries(
  GESTURE_TOGGLES.map((g) => [g.id, true]),
) as Record<ToggleId, boolean>;

export const isEnabled = (id: ToggleId): boolean => enabledGestures[id] !== false;

const TOGGLES_STORAGE = 'handgestures.enabled.v1';

export function loadEnabledGestures(): void {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(TOGGLES_STORAGE) ?? '{}') as Partial<Record<ToggleId, boolean>>;
    for (const g of GESTURE_TOGGLES) if (typeof saved[g.id] === 'boolean') enabledGestures[g.id] = saved[g.id]!;
  } catch {
    /* keep defaults */
  }
}

export function saveEnabledGestures(): void {
  try {
    globalThis.localStorage?.setItem(TOGGLES_STORAGE, JSON.stringify(enabledGestures));
  } catch {
    /* ignore */
  }
}

export const GESTURE_META: Record<string, { label: string }> = {
  ...Object.fromEntries(GESTURES.map((g) => [g.id, { label: g.label }])),
};
