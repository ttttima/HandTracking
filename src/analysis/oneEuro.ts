/**
 * One Euro filter (Casiez et al., CHI 2012): an adaptive low-pass filter that removes
 * jitter when the hand is still while keeping latency low during fast motion.
 */
import type { Vec3 } from '../types';

class LowPass {
  private y = 0;
  private initialised = false;
  filter(x: number, alpha: number): number {
    if (!this.initialised) {
      this.initialised = true;
      this.y = x;
    } else {
      this.y = alpha * x + (1 - alpha) * this.y;
    }
    return this.y;
  }
  get value(): number {
    return this.y;
  }
  get ready(): boolean {
    return this.initialised;
  }
}

const alphaFor = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT = -1;

  constructor(
    public minCutoff = 1.4,
    public beta = 9,
    public dCutoff = 1.0,
  ) {}

  filter(value: number, tMs: number): number {
    const dt = this.lastT < 0 ? 1 / 60 : Math.max(1e-3, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    const prev = this.x.ready ? this.x.value : value;
    const rawD = (value - prev) / dt;
    const edx = this.dx.filter(rawD, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }
}

/** Filters an array of 3D points (e.g. 21 landmarks) with one filter per coordinate. */
export class PointSetFilter {
  private filters: OneEuroFilter[] = [];

  constructor(
    private count: number,
    private minCutoff: number,
    private beta: number,
  ) {
    this.build();
  }

  private build() {
    this.filters = Array.from({ length: this.count * 3 }, () => new OneEuroFilter(this.minCutoff, this.beta));
  }

  setParams(minCutoff: number, beta: number): void {
    if (minCutoff === this.minCutoff && beta === this.beta) return;
    this.minCutoff = minCutoff;
    this.beta = beta;
    for (const f of this.filters) {
      f.minCutoff = minCutoff;
      f.beta = beta;
    }
  }

  apply(points: Vec3[], tMs: number): Vec3[] {
    return points.map((p, i) => ({
      x: this.filters[i * 3].filter(p.x, tMs),
      y: this.filters[i * 3 + 1].filter(p.y, tMs),
      z: this.filters[i * 3 + 2].filter(p.z, tMs),
    }));
  }
}
