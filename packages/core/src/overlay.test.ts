import { describe, expect, it } from "vitest";
import { quadToMatrix3d } from "./overlay.js";

/** Apply a matrix3d() string to a 2D point, as the browser would. */
function apply(css: string, x: number, y: number) {
  const m = css.slice(9, -1).split(",").map(Number);
  const w = m[3]! * x + m[7]! * y + m[15]!;
  return { x: (m[0]! * x + m[4]! * y + m[12]!) / w, y: (m[1]! * x + m[5]! * y + m[13]!) / w };
}

describe("quadToMatrix3d", () => {
  it("maps the box corners onto a perspective quad", () => {
    const quad = [{ x: 110, y: 40 }, { x: 390, y: 60 }, { x: 420, y: 500 }, { x: 80, y: 470 }];
    const css = quadToMatrix3d(quad, 300, 450);
    const corners = [apply(css, 0, 0), apply(css, 300, 0), apply(css, 300, 450), apply(css, 0, 450)];
    corners.forEach((c, i) => {
      expect(c.x).toBeCloseTo(quad[i]!.x, 6);
      expect(c.y).toBeCloseTo(quad[i]!.y, 6);
    });
  });

  it("is a plain translate+scale for an axis-aligned rectangle", () => {
    const css = quadToMatrix3d([{ x: 10, y: 20 }, { x: 210, y: 20 }, { x: 210, y: 320 }, { x: 10, y: 320 }], 100, 150);
    expect(apply(css, 50, 75)).toEqual({ x: 110, y: 170 });
  });
});
