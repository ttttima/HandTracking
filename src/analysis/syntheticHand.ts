/**
 * Synthetic hand generator, used by the unit tests and to draw the gesture reference glyphs.
 * Builds anatomically plausible 21-point landmarks
 * from joint angles, in the same coordinate conventions MediaPipe uses
 * (world: metres, x right, y down, z negative = towards the camera).
 * The model is a right hand with the palm facing the camera (thumb on +x).
 */
import type { FingerName, RawHand, Vec3 } from '../types';

type Flex = [number, number, number];

export interface HandPose {
  index?: Flex;
  middle?: Flex;
  ring?: Flex;
  pinky?: Flex;
  /** Thumb abduction from the finger direction, degrees (0 = along fingers, 90 = perpendicular). */
  thumbAbduction?: number;
  /** Multiplies the natural finger fan angles: 0 = fingers together, 2 = spread wide. */
  spread?: number;
  /** Exact fan angle per finger in degrees [index, middle, ring, pinky], overriding `spread`. */
  fan?: [number, number, number, number];
  /** Thumb flex [CMC, MCP, IP] in degrees, curling towards the palm / pinky side. */
  thumb?: Flex;
  /** Place the thumb tip at the index tip, plus this offset (metres). */
  thumbTouchIndex?: Vec3;
  /** Turn of the whole hand around the vertical axis, degrees (shows the thumb–index ring face-on). */
  yaw?: number;
  /** In-plane rotation of the whole hand, degrees (positive = clockwise on screen). */
  roll?: number;
  /** Uniform size factor (hand size invariance tests). */
  size?: number;
  /** Translation of the hand centre in normalised image space. */
  at?: { x: number; y: number };
  /** Image scale (how big the hand appears; distance from camera). */
  imageScale?: number;
}

const STRAIGHT: Flex = [0, 0, 0];
export const CURLED: Flex = [80, 100, 65];

const deg = (d: number) => (d * Math.PI) / 180;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const addv = (a: Vec3, b: Vec3) => v(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a: Vec3, s: number) => v(a.x * s, a.y * s, a.z * s);
const norm = (a: Vec3) => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return mul(a, 1 / l);
};
const dotv = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

const FINGER_BASE: Record<Exclude<FingerName, 'thumb'>, { mcp: Vec3; spread: number; seg: [number, number, number] }> = {
  index: { mcp: v(0.022, -0.088, 0), spread: 8, seg: [0.04, 0.025, 0.02] },
  middle: { mcp: v(0, -0.09, 0), spread: 0, seg: [0.045, 0.028, 0.022] },
  ring: { mcp: v(-0.02, -0.085, 0), spread: -8, seg: [0.042, 0.026, 0.021] },
  pinky: { mcp: v(-0.038, -0.075, 0), spread: -16, seg: [0.032, 0.02, 0.018] },
};
const TOWARD_CAMERA = v(0, 0, -1);

function chain(base: Vec3, u: Vec3, w: Vec3, seg: number[], flex: number[]): Vec3[] {
  const pts: Vec3[] = [];
  let p = base;
  let theta = 0;
  for (let i = 0; i < seg.length; i++) {
    theta += deg(flex[i]);
    const dir = addv(mul(u, Math.cos(theta)), mul(w, Math.sin(theta)));
    p = addv(p, mul(dir, seg[i]));
    pts.push(p);
  }
  return pts;
}

export function makeHand(pose: HandPose = {}): RawHand {
  const world: Vec3[] = new Array(21);
  world[0] = v(0, 0, 0);

  const fingerStart: Record<string, number> = { index: 5, middle: 9, ring: 13, pinky: 17 };
  for (const name of ['index', 'middle', 'ring', 'pinky'] as const) {
    const b = FINGER_BASE[name];
    const k = (['index', 'middle', 'ring', 'pinky'] as const).indexOf(name);
    const fan = pose.fan ? pose.fan[k] : b.spread * (pose.spread ?? 1);
    const u = v(Math.sin(deg(fan)), -Math.cos(deg(fan)), 0);
    const flex = pose[name] ?? STRAIGHT;
    const i0 = fingerStart[name];
    world[i0] = b.mcp;
    const pts = chain(b.mcp, u, TOWARD_CAMERA, b.seg, flex);
    world[i0 + 1] = pts[0];
    world[i0 + 2] = pts[1];
    world[i0 + 3] = pts[2];
  }

  // Thumb.
  const cmc = v(0.022, -0.025, -0.008);
  world[1] = cmc;
  if (pose.thumbTouchIndex) {
    const target = addv(world[8], pose.thumbTouchIndex);
    const mid = mul(addv(cmc, target), 0.5);
    const bow = v(0.012, 0, -0.01); // slight outward bow like a real thumb
    world[2] = addv(addv(mul(cmc, 0.65), mul(target, 0.35)), mul(bow, 0.8));
    world[3] = addv(addv(mul(mid, 0.4), mul(target, 0.6)), mul(bow, 0.6));
    world[4] = target;
  } else {
    const ab = deg(pose.thumbAbduction ?? 50);
    const u = v(Math.sin(ab), -Math.cos(ab), 0);
    // Curl direction: across the palm (−x) and towards the camera, orthogonalised against u.
    let w = v(-1, 0.2, -0.6);
    w = norm(addv(w, mul(u, -dotv(w, u))));
    const pts = chain(cmc, u, w, [0.038, 0.032, 0.027], pose.thumb ?? STRAIGHT);
    world[2] = pts[0];
    world[3] = pts[1];
    world[4] = pts[2];
  }

  // Roll + size.
  const r = deg(pose.roll ?? 0);
  const size = pose.size ?? 1;
  const yw = deg(pose.yaw ?? 0);
  const rolled = world.map((p0) => {
    const p = v(p0.x * Math.cos(yw) - p0.z * Math.sin(yw), p0.y, p0.x * Math.sin(yw) + p0.z * Math.cos(yw));
    const x = p.x * Math.cos(r) - p.y * Math.sin(r);
    const y = p.x * Math.sin(r) + p.y * Math.cos(r);
    return v(x * size, y * size, p.z * size);
  });

  // Centre world coords on the hand (as MediaPipe does) and project to image space.
  const c = rolled.reduce((a, p) => addv(a, mul(p, 1 / 21)), v(0, 0, 0));
  const worldLandmarks = rolled.map((p) => addv(p, mul(c, -1)));
  const scale = pose.imageScale ?? 3;
  const at = pose.at ?? { x: 0.5, y: 0.5 };
  const aspect = 16 / 9;
  const landmarks = worldLandmarks.map((p) => v(at.x + (p.x * scale) / aspect, at.y + p.y * scale, p.z * scale));

  return { landmarks, worldLandmarks, handedness: 'Right', score: 0.98 };
}

export const ASPECT = 16 / 9;

export const POSES: Record<string, HandPose> = {
  open_palm: { spread: 2 },
  closed_palm: { spread: 0.1, thumbAbduction: 20 },
  middle_finger: { index: CURLED, ring: CURLED, pinky: CURLED, thumbAbduction: 35, thumb: [25, 45, 60] },
  fist: { index: CURLED, middle: CURLED, ring: CURLED, pinky: CURLED, thumbAbduction: 35, thumb: [25, 45, 60] },
  pointing: { middle: CURLED, ring: CURLED, pinky: CURLED, thumbAbduction: 35, thumb: [25, 45, 60] },
  peace: { ring: CURLED, pinky: CURLED, thumbAbduction: 35, thumb: [25, 45, 60] },
  thumbs_up: { index: CURLED, middle: CURLED, ring: CURLED, pinky: CURLED, thumbAbduction: 85, roll: -90 },
  thumbs_down: { index: CURLED, middle: CURLED, ring: CURLED, pinky: CURLED, thumbAbduction: 85, roll: 90 },
  vulcan: { fan: [14, 11, -11, -14], thumbAbduction: 60 },
  pinch: { index: [35, 55, 35], middle: CURLED, ring: CURLED, pinky: CURLED, thumbTouchIndex: v(0.006, 0.004, 0) },
};
