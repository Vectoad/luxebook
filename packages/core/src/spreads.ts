import type { Spread } from "@vectoad/luxebook-types";

/**
 * Split a document into two-page openings.
 * With `showCover`, page 1 stands alone on the right (a closed book's
 * cover) and, for an even page count, the last page stands alone on the left.
 */
export function computeSpreads(pageCount: number, showCover: boolean): Spread[] {
  const spreads: Spread[] = [];
  let page = 1;
  if (showCover && pageCount > 0) {
    spreads.push({ left: null, right: 1 });
    page = 2;
  }
  for (; page <= pageCount; page += 2) {
    spreads.push({ left: page, right: page + 1 <= pageCount ? page + 1 : null });
  }
  return spreads;
}

/**
 * Single-page layout: every page in turn on the right, with the page just
 * read lying (off-view) on the left. With a cover, index 0 is the closed book.
 */
export function computeSingleSpreads(pageCount: number): Spread[] {
  return Array.from({ length: pageCount }, (_, i) => ({ left: i > 0 ? i : null, right: i + 1 }));
}

/** Index of the spread containing `page` (clamped to the document). */
export function spreadIndexOf(spreads: readonly Spread[], page: number): number {
  const i = spreads.findIndex((s) => s.left === page || s.right === page);
  if (i >= 0) return i;
  return page < 1 ? 0 : spreads.length - 1;
}

/** Leaves (sheets of two pages) lying under each side of a spread, for stack thickness. */
export function leavesUnder(spread: Spread, pageCount: number): { left: number; right: number } {
  const firstRight = spread.right ?? (spread.left ?? 0) + 1;
  const left = Math.floor((firstRight - 1) / 2);
  const right = Math.ceil((pageCount - firstRight + 1) / 2);
  return { left, right };
}

/** Pages to render ahead/behind of `spread`, nearest first. */
export function preloadOrder(spread: Spread, pageCount: number, count: number): number[] {
  const lo = spread.left ?? spread.right ?? 1;
  const hi = spread.right ?? spread.left ?? 1;
  const pages: number[] = [];
  for (let i = 1; i <= count; i++) {
    if (hi + i <= pageCount) pages.push(hi + i);
    if (lo - i >= 1) pages.push(lo - i);
  }
  return pages;
}
