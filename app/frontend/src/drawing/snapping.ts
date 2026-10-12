// Points worth snapping to when placing an arc's centre: the ends of lines,
// arrows and variable arrows/bars, and where two of them cross. Also the
// straight pieces themselves, for lining an arc's start up with one.
// See "Variable arc" in docs/svg-editor-plan.md.

import { controlAnchor, controlEnd, controlKind } from "./controls";
import { literalNumber, type SceneElement } from "./scene";
import { isArrow } from "./shapes";

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  key: string;
  start: Point;
  end: Point;
}

export interface SnapPoint extends Point {
  kind: "end" | "crossing";
}

/** The straight lines, arrows and variable arrows/bars among `elements`,
 *  as drawn now (variable ones at their preview values). */
export function segmentsOf(elements: SceneElement[], values: Record<string, string>): Segment[] {
  const segments: Segment[] = [];
  for (const element of elements) {
    if (element.kind === "passthrough") continue;
    const n = (name: string) => literalNumber(element.attrs[name]);
    const names = element.kind === "line" ? ["x1", "y1", "x2", "y2"] : isArrow(element) ? ["data-x1", "data-y1", "data-x2", "data-y2"] : null;
    if (names) {
      const [x1, y1, x2, y2] = names.map(n);
      if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
        segments.push({ key: element.key, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
      }
      continue;
    }
    const kind = controlKind(element);
    if (kind === "variable-arrow" || kind === "variable-bar") {
      const start = controlAnchor(element);
      const end = controlEnd(element, values);
      if (start && end) segments.push({ key: element.key, start, end });
    }
  }
  return segments;
}

/** Where two segments cross (ends touching count), or null. */
export function crossing(a: Segment, b: Segment): Point | null {
  const r = { x: a.end.x - a.start.x, y: a.end.y - a.start.y };
  const s = { x: b.end.x - b.start.x, y: b.end.y - b.start.y };
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 1e-9) return null;
  const qp = { x: b.start.x - a.start.x, y: b.start.y - a.start.y };
  const t = (qp.x * s.y - qp.y * s.x) / denominator;
  const u = (qp.x * r.y - qp.y * r.x) / denominator;
  const slack = 1e-6;
  if (t < -slack || t > 1 + slack || u < -slack || u > 1 + slack) return null;
  return { x: a.start.x + t * r.x, y: a.start.y + t * r.y };
}

/** Every end and crossing of the segments, except those of `skip` (the item being moved). */
export function snapPoints(segments: Segment[], skip?: string): SnapPoint[] {
  const pieces = segments.filter((segment) => segment.key !== skip);
  const points: SnapPoint[] = pieces.flatMap((segment) => [
    { ...segment.start, kind: "end" as const },
    { ...segment.end, kind: "end" as const },
  ]);
  for (let i = 0; i < pieces.length; i += 1) {
    for (let j = i + 1; j < pieces.length; j += 1) {
      const point = crossing(pieces[i], pieces[j]);
      if (point) points.push({ ...point, kind: "crossing" });
    }
  }
  return points;
}

/** The snap point nearest `at` within `radius`, or null. */
export function nearestSnap(points: SnapPoint[], at: Point, radius: number): SnapPoint | null {
  let best: SnapPoint | null = null;
  let bestDistance = radius;
  for (const point of points) {
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

/** Directions (degrees counterclockwise from +x) an arc can start along
 *  `segment`, pointing away from `centre`. A line through the centre gives
 *  both of its arms; otherwise it runs from the end nearer the centre to the
 *  far end. Used so the arc measures the angle from that line. */
export function directionsFrom(segment: Segment, centre: Point): number[] {
  const angle = (from: Point, to: Point) => {
    const degrees = (Math.atan2(-(to.y - from.y), to.x - from.x) * 180) / Math.PI;
    // "+ 0" turns -0 into 0.
    return Math.round((degrees < 0 ? degrees + 360 : degrees) * 100) / 100 + 0;
  };
  const distance = (point: Point) => Math.hypot(point.x - centre.x, point.y - centre.y);
  const length = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
  const onLine = Math.abs(distance(segment.start) + distance(segment.end) - length) < 0.5;
  if (onLine && distance(segment.start) > 1 && distance(segment.end) > 1) {
    return [angle(centre, segment.end), angle(centre, segment.start)];
  }
  const [from, to] = distance(segment.start) <= distance(segment.end) ? [segment.start, segment.end] : [segment.end, segment.start];
  return [angle(from, to)];
}
