import { describe, expect, it } from "vitest";
import { Spring, easeInOutCubic } from "./index.js";

describe("Spring", () => {
  it("settles on its target without overshoot when critically damped", () => {
    const s = new Spring(0);
    s.target = 1;
    let max = 0;
    let frames = 0;
    while (!s.step(1 / 60) && frames < 600) {
      max = Math.max(max, s.value);
      frames++;
    }
    expect(s.value).toBe(1);
    expect(max).toBeLessThanOrEqual(1);
    expect(frames).toBeLessThan(180); // < 3 s
  });

  it("is frame-rate independent", () => {
    const a = new Spring(0);
    const b = new Spring(0);
    a.target = b.target = 1;
    for (let i = 0; i < 30; i++) a.step(1 / 30);
    for (let i = 0; i < 144; i++) b.step(1 / 144);
    expect(a.value).toBeCloseTo(b.value, 2);
  });

  it("clamps huge frame gaps", () => {
    const s = new Spring(0);
    s.target = 1;
    s.step(10);
    expect(s.value).toBeLessThan(1);
  });
});

describe("easeInOutCubic", () => {
  it("maps endpoints and midpoint", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
  });
});
