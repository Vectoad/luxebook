/**
 * Frame-rate independent animation primitives. Nothing here owns a render
 * loop: callers step animations from whatever loop they already run.
 */

export interface SpringConfig {
  /** Higher = faster. ~120 is brisk, ~40 is languid. */
  stiffness: number;
  /** 2 * sqrt(stiffness) is critically damped (no overshoot). */
  damping: number;
}

/** A restrained, critically damped default suited to camera and page settles. */
export const GENTLE: SpringConfig = { stiffness: 60, damping: 2 * Math.sqrt(60) };

export class Spring {
  value: number;
  velocity = 0;
  target: number;

  constructor(
    value: number,
    readonly config: SpringConfig = GENTLE,
  ) {
    this.value = value;
    this.target = value;
  }

  /**
   * Advance by `dt` seconds (semi-implicit Euler, sub-stepped for stability
   * on long frames). Returns `true` once settled; a settled spring snaps to target.
   */
  step(dt: number): boolean {
    const { stiffness, damping } = this.config;
    let remaining = Math.min(dt, 0.1); // tab-switch hitches shouldn't fling things
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 120);
      const accel = stiffness * (this.target - this.value) - damping * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    if (Math.abs(this.target - this.value) < 1e-4 && Math.abs(this.velocity) < 1e-3) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    return false;
  }
}

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
