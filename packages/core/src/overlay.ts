type Point = { x: number; y: number };

/**
 * CSS `matrix3d()` that maps a `w`×`h` box (transform-origin 0 0) onto the
 * quad `q` (top-left, top-right, bottom-right, bottom-left): a projective
 * map, so an overlay follows a tilted page in perspective.
 * Unit square → quad after Heckbert, "Fundamentals of Texture Mapping" (1989).
 */
export function quadToMatrix3d(q: readonly Point[], w: number, h: number): string {
  const [p0, p1, p2, p3] = q as [Point, Point, Point, Point];
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const k = (dx1 * dy3 - dx3 * dy1) / den;
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + k * p3.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + k * p3.y;
  // Column-major; box coords (X, Y) go in as (X / w, Y / h).
  return `matrix3d(${[a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, p0.x, p0.y, 0, 1].join(",")})`;
}
