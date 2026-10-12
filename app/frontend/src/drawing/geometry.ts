// Small numeric helpers shared by shapes.ts and controls.ts.

/** Coordinates are written with at most 2 decimals: plenty at 96 px/in. */
export function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Multipliers inside {{calc: ...}} keep 4 decimals so a long arrow at an
 *  angle still lands where it should (cos 45° = 0.7071). */
export function formatCoefficient(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Arrowheads grow with the stroke so a heavy arrow doesn't get a tiny tip. */
export function arrowHeadSize(strokeWidth: number): { length: number; halfWidth: number } {
  return { length: 6 + strokeWidth * 2.5, halfWidth: 2.5 + strokeWidth * 1.25 };
}

/** a + b * L: a coordinate that may grow with a variable length L (b = 0 for fixed shapes). */
export interface Linear {
  a: number;
  b: number;
}
