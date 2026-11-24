import { describe, expect, it } from "vitest";
import { curlVertex, foldTo, PageTurnPhysics, type CurlParams, type CurlResult } from "./index.js";

const out = (): CurlResult => ({ x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 });
const R = 0.1;
const straight: CurlParams = { axisX: 0.5, axisY: 0, dirX: 1, dirY: 0, radius: R };

describe("curlVertex", () => {
  it("leaves the flat side untouched", () => {
    expect(curlVertex(0.3, 0.2, straight, out())).toEqual({ x: 0.3, y: 0.2, z: 0, nx: 0, ny: 0, nz: 1 });
  });

  it("puts a quarter-turn point at (R, R) from the axis with a sideways normal", () => {
    const r = curlVertex(0.5 + (Math.PI / 2) * R, 0, straight, out());
    expect(r.x).toBeCloseTo(0.5 + R);
    expect(r.z).toBeCloseTo(R);
    expect(r.nx).toBeCloseTo(-1);
    expect(r.nz).toBeCloseTo(0);
  });

  it("flips the page over past the half-turn", () => {
    const r = curlVertex(0.5 + Math.PI * R + 0.05, 0, straight, out());
    expect(r.x).toBeCloseTo(0.45);
    expect(r.z).toBeCloseTo(2 * R);
    expect(r.nz).toBe(-1);
  });

  it("preserves arc length (paper does not stretch)", () => {
    const d = { axisX: 0.4, axisY: -0.1, dirX: Math.cos(0.3), dirY: Math.sin(0.3), radius: 0.07 };
    const n = 400;
    let length = 0;
    let prev = curlVertex(0.3, 0.1, d, out());
    for (let i = 1; i <= n; i++) {
      const cur = curlVertex(0.3 + (0.6 * i) / n, 0.1, d, out());
      length += Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z);
      prev = cur;
    }
    expect(length).toBeCloseTo(0.6, 3);
  });

  it("always yields unit normals", () => {
    const d = { axisX: 0.2, axisY: 0.3, dirX: 0.6, dirY: 0.8, radius: 0.05 };
    for (let x = 0; x <= 1; x += 0.05) {
      const r = curlVertex(x, 0.5, d, out());
      expect(Math.hypot(r.nx, r.ny, r.nz)).toBeCloseTo(1);
    }
  });

  it("supports a curl that lifts away from the back-turning page", () => {
    const r = curlVertex(0.5 + (Math.PI / 2) * R, 0, { ...straight, bendDirection: -1 }, out());
    expect(r.z).toBeCloseTo(-R);
    expect(r.nx).toBeCloseTo(1);
    expect(Math.hypot(r.nx, r.ny, r.nz)).toBeCloseTo(1);
  });

});

describe("foldTo", () => {
  it("lands the grabbed point on the target, face down", () => {
    for (const [cx, cy] of [[0.4, -0.5], [0.1, -0.2], [-0.5, -0.45]]) {
      const p = foldTo(1, -0.5, cx!, cy!, 0.05)!;
      const r = curlVertex(1, -0.5, p, out());
      expect(r.x).toBeCloseTo(cx!);
      expect(r.y).toBeCloseTo(cy!);
      expect(r.z).toBeCloseTo(0.1);
      expect(r.nz).toBeCloseTo(-1);
    }
  });

  it("is null when nothing moved", () => {
    expect(foldTo(1, 0, 1, 0, 0.05)).toBeNull();
  });
});

/** Run to the end: returns the frames it took. */
function settle(turn: PageTurnPhysics): number {
  let frames = 0;
  while (!turn.step(1 / 60) && frames < 300) frames++;
  return frames;
}

describe("PageTurnPhysics", () => {
  it("brings the grabbed corner to the pointer, and a fast release completes the turn", () => {
    const turn = new PageTurnPhysics(1);
    turn.begin("forward", 1, -0.48, 0); // near the bottom: takes the corner
    turn.drag(0.6, -0.4, 20);
    for (let i = 0; i < 30; i++) turn.step(1 / 60);
    expect(turn.cornerX).toBeCloseTo(0.6);
    expect(turn.cornerY).toBeCloseTo(-0.4);
    const r = curlVertex(1, -0.5, turn.curl!, out());
    expect(r.x).toBeCloseTo(0.6, 2);
    expect(r.y).toBeCloseTo(-0.4, 2);
    expect(turn.release()).toBe(true); // fast flick
    expect(settle(turn)).toBeLessThan(300);
    expect(turn.phase).toBe("completed");
    expect(turn.progress).toBe(1);
    expect(turn.cornerX).toBe(-1);
  });

  it("returns an incomplete drag to rest when released without enough progress", () => {
    const turn = new PageTurnPhysics(1);
    turn.begin("backward", 1, 0, 0);
    turn.drag(0.8, 0, 500);
    for (let i = 0; i < 30; i++) turn.step(1 / 60);
    expect(turn.release()).toBe(false);
    expect(turn.curl!.bendDirection).toBe(-1);
    expect(settle(turn)).toBeLessThan(300);
    expect(turn.phase).toBe("cancelled");
    expect(turn.progress).toBe(0);
    expect(turn.curl).toBeNull();
  });

  it("keeps the leaf bound at the spine", () => {
    const turn = new PageTurnPhysics(1);
    turn.begin("forward", 1, -0.5, 0);
    turn.drag(0.2, 0.9, 20); // far above the page: would tear it off the spine
    for (let i = 0; i < 60; i++) turn.step(1 / 60);
    expect(Math.hypot(turn.cornerX, turn.cornerY + 0.5)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.hypot(turn.cornerX, turn.cornerY - 0.5)).toBeLessThanOrEqual(Math.SQRT2 + 1e-9);
  });

  it("rejects invalid page widths", () => {
    expect(() => new PageTurnPhysics(0)).toThrow(RangeError);
  });
});

describe("PageTurnPhysics.stepTimed", () => {
  it("eases from rest to completion over the given duration", () => {
    const p = new PageTurnPhysics(1);
    p.begin("forward", 1, -0.5);
    p.release(true);
    expect(p.stepTimed(0.1, 0.8)).toBe(false);
    expect(p.progress).toBeLessThan(0.02); // slow start
    for (let i = 0; i < 2; i++) p.stepTimed(0.1, 0.8);
    expect(p.progress).toBeLessThan(0.5);
    p.stepTimed(0.1, 0.8);
    expect(p.progress).toBeCloseTo(0.5); // halfway at half time
    expect(p.cornerY).toBeGreaterThan(-0.5); // the corner lifts off the edge on its way over
    for (let i = 0; i < 3; i++) expect(p.stepTimed(0.1, 0.8)).toBe(false);
    let frames = 0;
    while (!p.stepTimed(0.1, 0.8)) frames++;
    expect(frames).toBeLessThanOrEqual(1); // done at 0.8 s (± float rounding)
    expect(p.phase).toBe("completed");
    expect(p.progress).toBe(1);
  });
});

describe("PageTurnPhysics.curl", () => {
  it("never folds the spine, wherever the corner is pulled", () => {
    const turn = new PageTurnPhysics(0.7);
    turn.begin("forward", 0.7, -0.5, 0);
    for (const [x, y] of [[0.05, 0.45], [-0.2, 0.3], [0.3, 0.5], [-0.6, -0.4]]) {
      turn.drag(x!, y!, 16);
      for (let i = 0; i < 60; i++) turn.step(1 / 60);
      const fold = turn.curl!;
      for (const sy of [0.5, -0.5]) expect((0 - fold.axisX) * fold.dirX + (sy - fold.axisY) * fold.dirY).toBeLessThanOrEqual(1e-9);
    }
  });
});
