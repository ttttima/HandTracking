/** Shared domain types used across the tracking → analysis → gesture → UI pipeline. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Handedness = 'Left' | 'Right';

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type FingerName = (typeof FINGERS)[number];

/** MediaPipe 21-point hand model indices. */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
} as const;

/** Joint chain (base → tip) of each finger. The thumb starts at its CMC joint. */
export const FINGER_JOINTS: Record<FingerName, readonly [number, number, number, number]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

export const FINGERTIPS: Record<FingerName, number> = {
  thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20,
};

export const LANDMARK_NAMES = [
  'Wrist',
  'Thumb CMC', 'Thumb MCP', 'Thumb IP', 'Thumb tip',
  'Index MCP', 'Index PIP', 'Index DIP', 'Index tip',
  'Middle MCP', 'Middle PIP', 'Middle DIP', 'Middle tip',
  'Ring MCP', 'Ring PIP', 'Ring DIP', 'Ring tip',
  'Pinky MCP', 'Pinky PIP', 'Pinky DIP', 'Pinky tip',
] as const;

/** One hand as returned by the detector (after optional smoothing). */
export interface RawHand {
  /** 21 points, x/y normalized to [0,1] of the *unmirrored* source frame, z = relative depth. */
  landmarks: Vec3[];
  /** 21 points in metres, origin near the hand's geometric centre. */
  worldLandmarks: Vec3[];
  handedness: Handedness;
  /** Handedness classifier confidence, 0..1. */
  score: number;
}

export interface DetectionFrame {
  hands: RawHand[];
  timestamp: number;
  inferenceMs: number;
  /** Source frame size in pixels. */
  width: number;
  height: number;
}

export interface FingerInfo {
  name: FingerName;
  /** Hysteresis-stabilised state. */
  extended: boolean;
  /** Continuous extension score: 1 = fully straight, 0 = fully curled. */
  extension: number;
  /** Weighted sum of joint bend angles in degrees (0 = straight). */
  bend: number;
}

export type ContactState = 'touching' | 'near' | 'apart';

export interface ContactInfo {
  key: string;
  a: FingerName;
  b: FingerName;
  /** Fingertip distance normalised by palm size (hand-size invariant). */
  distance: number;
  state: ContactState;
}

export interface HandFeatures {
  /** Stable per-session id, e.g. "Right" (or "Right#2" if two hands share a label). */
  id: string;
  handedness: Handedness;
  score: number;
  timestamp: number;
  /** Image-space landmarks (normalized, unmirrored). */
  image: Vec3[];
  /** World-space landmarks (metres). */
  world: Vec3[];
  /** Palm size (wrist → middle MCP) in world metres. */
  palmSize: number;
  /** Palm size in image units where x is aspect-corrected (fraction of frame height). */
  palmSizeImage: number;
  /** Centre of the palm in image space. */
  palmCenter: Vec3;
  fingers: Record<FingerName, FingerInfo>;
  extendedCount: number;
  contacts: ContactInfo[];
  contactMap: Record<string, ContactInfo>;
  /** Thumb–index tip distance normalised by palm size. */
  pinchDistance: number;
  /** Index fingertip distance from wrist normalised by palm size (reach). */
  indexReach: number;
  /** Mean angle in degrees between neighbouring fingers (index…pinky). ~0 = held together. */
  spread: number;
  /** Angles in degrees between neighbouring fingers: [index–middle, middle–ring, ring–pinky]. */
  gaps: [number, number, number];
  /**
   * Area of the opening between thumb and index as seen by the camera, in palm sizes squared.
   * Large = a visible ring, near zero = the ring is edge-on. Not used by any sign right now;
   * kept so an OK sign (visible ring) can be added back.
   */
  ringArea: number;
  /** In-plane rotation of the hand in degrees (0 = fingers pointing up). */
  roll: number;
  /** Whether the palm (vs. the back of the hand) faces the camera. */
  palmFacing: boolean;
}

export const GESTURE_IDS = [
  'open_palm',
  'closed_palm',
  'fist',
  'middle_finger',
  'pointing',
  'peace',
  'pinch',
  'thumbs_up',
  'thumbs_down',
  'vulcan',
] as const;
export type StaticGestureId = (typeof GESTURE_IDS)[number];
export type GestureId = StaticGestureId;

export interface HandGestureState {
  handId: string;
  handedness: Handedness;
  /** Raw (instantaneous) scores 0..1 for each static gesture. */
  scores: Record<StaticGestureId, number>;
  /** Gestures currently active after debounce/hysteresis. */
  active: StaticGestureId[];
  /** Highest-priority active gesture. */
  primary: StaticGestureId | null;
  /** How long the primary gesture has been held (ms). */
  primaryHeldMs: number;
  /** Thumb–index interaction phase used by drag recognition. */
  pinchPhase: 'idle' | 'touching' | 'dragging';
}
