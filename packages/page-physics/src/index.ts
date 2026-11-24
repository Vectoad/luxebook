/**
 * Page deformation: cylindrical curl model (reference implementation).
 *
 * Milestone 3 ports `curlVertex` to a GLSL vertex shader; this CPU version is
 * the specification the shader is tested against and is what interaction
 * code uses for hit-testing. See docs/PAGE_CURL.md for the derivation.
 *
 * Coordinate system (page-local, matches the renderer's page geometry):
 *   - spine along the y axis at x = 0, page spans x ∈ [0, width]
 *   - the flat page lies in z = 0, front face towards +z
 *   - curling lifts the page towards +z (towards the reader)
 */

export interface CurlParams {
  /** A point on the curl axis (the line where the page starts to bend). */
  axisX: number;
  axisY: number;
  /**
   * Unit vector in the page plane, perpendicular to the axis, pointing at
   * the part of the page that lifts.
   */
  dirX: number;
  dirY: number;
  /** Radius of the roll at the fold. Must be > 0. */
  radius: number;
  /** Sign of the lift direction; -1 for a leaf whose local +z points away from the reader. */
  bendDirection?: 1 | -1;
}

export interface CurlResult {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Bend a point on the page around a cylinder lying on the curl axis: paper
 * past the axis rolls over it and, after half a turn, lies flat again,
 * face down, on top of the page. Arc length is preserved (no stretching).
 * Writes into `out` to avoid per-vertex allocation.
 */
export function curlVertex(x: number, y: number, p: CurlParams, out: CurlResult): CurlResult {
  const { dirX, dirY, radius: r } = p;
  const bendDirection = p.bendDirection ?? 1;
  const s = (x - p.axisX) * dirX + (y - p.axisY) * dirY;
  out.y = y;
  if (s <= 0) {
    out.x = x;
    out.z = 0;
    out.nx = 0;
    out.ny = 0;
    out.nz = 1;
    return out;
  }
  // Foot of the point on the axis line, then move back out along `dir`.
  const footX = x - s * dirX;
  const footY = y - s * dirY;
  let offset: number;
  let z: number;
  let sinT: number;
  let cosT: number;
  const halfTurn = Math.PI * r;
  if (s <= halfTurn) {
    const theta = s / r;
    sinT = Math.sin(theta);
    cosT = Math.cos(theta);
    offset = r * sinT;
    z = r * (1 - cosT);
  } else {
    sinT = 0;
    cosT = -1;
    offset = -(s - halfTurn);
    z = 2 * r;
  }
  out.x = footX + offset * dirX;
  out.y = footY + offset * dirY;
  out.z = z * bendDirection;
  // The front normal (0,0,1) rotates with the surface: (−sinθ·dir, cosθ).
  out.nx = -sinT * dirX * bendDirection;
  out.ny = -sinT * dirY * bendDirection;
  out.nz = cosT;
  return out;
}

/**
 * Fold a leaf so its point `g` lands on `c` (both page-local): the fold axis
 * is the perpendicular bisector of g→c, shifted so the roll of `radius`
 * still puts `g` exactly on `c`. Null when there is nothing to fold.
 */
export function foldTo(gx: number, gy: number, cx: number, cy: number, radius: number, bendDirection: 1 | -1 = 1): CurlParams | null {
  const d = Math.hypot(gx - cx, gy - cy);
  if (d < 1e-6) return null;
  const dirX = (gx - cx) / d;
  const dirY = (gy - cy) / d;
  const r = Math.max(1e-4, radius);
  const s = (d + Math.PI * r) / 2; // g's distance past the axis
  return { axisX: gx - s * dirX, axisY: gy - s * dirY, dirX, dirY, radius: r, bendDirection };
}

export type TurnDirection = "forward" | "backward";
export type TurnPhase = "idle" | "dragging" | "settling" | "completed" | "cancelled";

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/**
 * A page turn as a fold: the grabbed point of the leaf (page-local, spine at
 * x = 0, page y ∈ [−height/2, height/2]) follows a target, the pointer while
 * dragging, then a path to the opposite side (or back) once released. The
 * leaf stays bound at the spine: the point never gets further from either
 * end of the spine than it started. Coordinates are page units; time is ms.
 */
export class PageTurnPhysics {
  phase: TurnPhase = "idle";
  direction: TurnDirection = "forward";
  /** 0 = lying where it started, 1 = turned over onto the other side. */
  progress = 0;
  velocity = 0;
  /** Where the grabbed point is now. */
  cornerX = 0;
  cornerY = 0;
  /** The grabbed point of the leaf (page-local), set by `begin`. */
  grabX = 0;
  grabY = 0;
  private targetX = 0;
  private targetY = 0;
  private target = 0;
  private lastProgress = 0;
  private lastTime = 0;
  /** Release: where the point was, and the progress then. */
  private fromX = 0;
  private fromY = 0;
  private fromProgress = 0;
  /** Seconds into a timed turn (`stepTimed`) or a release glide, −1 when not started. */
  private clock = -1;
  /** How long the glide after a release takes. */
  private settleSeconds = 0.3;

  constructor(
    readonly width: number,
    readonly height = 1,
  ) {
    if (!Number.isFinite(width) || width <= 0) throw new RangeError("Page width must be > 0.");
  }

  /** Grab the leaf at (x, y). A grab near the top or bottom takes the corner. */
  begin(direction: TurnDirection, x: number, y: number, time = 0): void {
    const half = this.height / 2;
    this.direction = direction;
    this.grabX = clamp(x, this.width * 0.25, this.width);
    this.grabY = Math.abs(y) > half * 0.7 ? Math.sign(y) * half : clamp(y, -half, half);
    this.cornerX = this.targetX = this.grabX;
    this.cornerY = this.targetY = this.grabY;
    this.progress = this.velocity = this.target = this.lastProgress = 0;
    this.lastTime = time;
    this.clock = -1;
    this.phase = "dragging";
  }

  /** Move the grabbed point towards (x, y); `step` eases it there. */
  drag(x: number, y: number, time: number): void {
    if (this.phase !== "dragging") return;
    [this.targetX, this.targetY] = this.bind(x, y);
    const next = this.progressAt(this.targetX);
    // Towards the end the page squares up with the book: it lands flat, not twisted.
    const t = clamp((next - 0.55) / 0.4, 0, 1);
    this.targetY += (this.grabY - this.targetY) * t * t * (3 - 2 * t);
    const elapsed = Math.max((time - this.lastTime) / 1000, 1 / 240);
    this.velocity = this.velocity * 0.35 + ((next - this.lastProgress) / elapsed) * 0.65;
    this.lastProgress = next;
    this.lastTime = time;
  }

  /** Release commits by progress or fling velocity; pass a value to force either outcome. */
  release(commit?: boolean): boolean {
    if (this.phase !== "dragging") return this.target === 1;
    const shouldCommit = commit ?? (this.progressAt(this.targetX) >= 0.34 || this.velocity >= 1.15);
    this.target = shouldCommit ? 1 : 0;
    // Carry on from where the point is now: no jump to the pointer.
    this.fromX = this.cornerX;
    this.fromY = this.cornerY;
    this.progress = this.fromProgress = this.progressAt(this.cornerX);
    // Glide there, easing out, in time for the distance left: a page let go
    // early slides back to rest rather than snapping (whatever its speed).
    this.settleSeconds = 0.35 + 0.45 * Math.abs(this.target - this.fromProgress);
    this.clock = 0;
    this.velocity = 0;
    this.phase = "settling";
    return shouldCommit;
  }

  /** Advance by `dt` seconds (follow the pointer, or glide after release). True when the turn has completed or cancelled. */
  step(dt: number): boolean {
    if (this.phase === "dragging") {
      // Follow the pointer closely but not rigidly: paper has a little inertia.
      const k = 1 - Math.exp(-clamp(dt, 0, 0.1) * 28);
      this.cornerX += (this.targetX - this.cornerX) * k;
      this.cornerY += (this.targetY - this.cornerY) * k;
      this.progress = this.progressAt(this.cornerX);
      return false;
    }
    if (this.phase !== "settling") return this.phase === "completed" || this.phase === "cancelled";
    this.clock += clamp(dt, 0, 0.1);
    const t = Math.min(1, this.clock / this.settleSeconds);
    this.progress = this.fromProgress + (this.target - this.fromProgress) * (1 - (1 - t) ** 3);
    if (t >= 1) return this.finish();
    this.followPath();
    return false;
  }

  /**
   * Settle on a fixed timeline instead of the spring: ease-in-out over
   * `duration` seconds, from wherever the page is. For turns started by a tap
   * or key, where a spring from rest looks like a snap. Returns true when done.
   */
  stepTimed(dt: number, duration: number): boolean {
    if (this.phase !== "settling") return this.phase === "completed" || this.phase === "cancelled";
    if (this.clock < 0) this.clock = 0;
    this.clock += clamp(dt, 0, 0.1);
    const t = Math.min(1, this.clock / duration);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    this.progress = this.fromProgress + (this.target - this.fromProgress) * eased;
    this.velocity = 0;
    if (t >= 1) return this.finish();
    this.followPath();
    return false;
  }

  /** The fold for the current state, or null while the leaf lies flat. */
  get curl(): CurlParams | null {
    const d = Math.hypot(this.grabX - this.cornerX, this.grabY - this.cornerY);
    // A soft roll mid-turn that tightens as the leaf lands, never so wide the point leaves the pointer.
    const radius = Math.min(this.width * 0.07 * Math.sin(Math.PI * clamp(this.progress, 0, 1)) ** 0.4, d * 0.3);
    const fold = foldTo(this.grabX, this.grabY, this.cornerX, this.cornerY, Math.max(radius, this.width * 0.004), this.direction === "forward" ? 1 : -1);
    if (!fold) return null;
    // The spine never folds: if the axis would cut across it, slide the fold back
    // (the corner then trails the pointer a little rather than tearing the page off).
    for (const sy of [this.height / 2, -this.height / 2]) {
      const past = (0 - fold.axisX) * fold.dirX + (sy - fold.axisY) * fold.dirY;
      if (past > 0) {
        fold.axisX += past * fold.dirX;
        fold.axisY += past * fold.dirY;
      }
    }
    return fold;
  }

  private finish(): true {
    this.progress = this.target;
    this.velocity = 0;
    this.cornerX = this.target === 1 ? -this.grabX : this.grabX;
    this.cornerY = this.grabY;
    this.phase = this.target === 1 ? "completed" : "cancelled";
    return true;
  }

  private progressAt(x: number): number {
    return clamp((this.grabX - x) / (2 * this.grabX), 0, 1);
  }

  /** Released: travel from the release point to the end, lifting slightly off the edge on the way. */
  private followPath(): void {
    const endX = this.target === 1 ? -this.grabX : this.grabX;
    const span = this.target - this.fromProgress;
    const f = Math.abs(span) < 1e-6 ? 1 : clamp((this.progress - this.fromProgress) / span, 0, 1);
    const arc = this.height * 0.04 * Math.abs(endX - this.fromX) / (2 * this.grabX) * Math.sin(Math.PI * f);
    const inward = this.grabY > 0 ? -1 : 1;
    [this.cornerX, this.cornerY] = this.bind(
      this.fromX + (endX - this.fromX) * f,
      this.fromY + (this.grabY - this.fromY) * f + inward * arc,
    );
  }

  /** Keep the leaf attached at the spine: no further from either spine end than the grabbed point was. */
  private bind(x: number, y: number): [number, number] {
    const half = this.height / 2;
    for (let i = 0; i < 2; i++) {
      for (const sy of [half, -half]) {
        const max = Math.hypot(this.grabX, this.grabY - sy);
        const dx = x;
        const dy = y - sy;
        const dist = Math.hypot(dx, dy);
        if (dist > max) {
          x = (dx * max) / dist;
          y = sy + (dy * max) / dist;
        }
      }
    }
    return [x, y];
  }
}
