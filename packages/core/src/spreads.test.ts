import { describe, expect, it } from "vitest";
import { computeSingleSpreads, computeSpreads, leavesUnder, preloadOrder, spreadIndexOf } from "./spreads.js";

describe("computeSingleSpreads", () => {
  it("shows one page at a time on the right, the previous one on the left", () => {
    const spreads = computeSingleSpreads(3);
    expect(spreads).toEqual([
      { left: null, right: 1 },
      { left: 1, right: 2 },
      { left: 2, right: 3 },
    ]);
    expect(spreadIndexOf(spreads, 2)).toBe(1); // the spread where page 2 is the visible (right) page
  });
});

describe("computeSpreads", () => {
  it("pairs pages without a cover", () => {
    expect(computeSpreads(5, false)).toEqual([
      { left: 1, right: 2 },
      { left: 3, right: 4 },
      { left: 5, right: null },
    ]);
  });

  it("puts the cover alone on the right", () => {
    expect(computeSpreads(4, true)).toEqual([
      { left: null, right: 1 },
      { left: 2, right: 3 },
      { left: 4, right: null },
    ]);
    expect(computeSpreads(1, true)).toEqual([{ left: null, right: 1 }]);
  });

  it("handles empty documents", () => {
    expect(computeSpreads(0, true)).toEqual([]);
  });
});

describe("spreadIndexOf", () => {
  const spreads = computeSpreads(6, true);
  it("finds the spread showing a page", () => {
    expect(spreadIndexOf(spreads, 1)).toBe(0);
    expect(spreadIndexOf(spreads, 3)).toBe(1);
    expect(spreadIndexOf(spreads, 6)).toBe(3);
  });
  it("clamps out-of-range pages", () => {
    expect(spreadIndexOf(spreads, -3)).toBe(0);
    expect(spreadIndexOf(spreads, 99)).toBe(3);
  });
});

describe("leavesUnder", () => {
  it("counts leaves read and remaining", () => {
    expect(leavesUnder({ left: null, right: 1 }, 10)).toEqual({ left: 0, right: 5 });
    expect(leavesUnder({ left: 4, right: 5 }, 10)).toEqual({ left: 2, right: 3 });
    expect(leavesUnder({ left: 10, right: null }, 10)).toEqual({ left: 5, right: 0 });
  });
});

describe("preloadOrder", () => {
  it("alternates forward and backward, nearest first, within bounds", () => {
    expect(preloadOrder({ left: 4, right: 5 }, 10, 2)).toEqual([6, 3, 7, 2]);
    expect(preloadOrder({ left: 1, right: 2 }, 3, 2)).toEqual([3]);
  });
});
