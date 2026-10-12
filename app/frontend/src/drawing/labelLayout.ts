// Where a label sits relative to a line-like shape: at its start, middle or
// end; upright or along the shape; above or below it; plus a dragged offset.
// Shared by plain arrows/lines (shapes.ts), variable controls (controls.ts)
// and texts attached to shapes (anchors.ts). See "Labels that follow shapes"
// in docs/svg-editor-plan.md.

import { literalNumber } from "./scene";
import type { Linear } from "./geometry";

export type LabelAt = "start" | "mid" | "end";
export type LabelOrient = "horizontal" | "along";
export type LabelSide = "above" | "below";

export interface LabelSettings {
  at: LabelAt;
  orient: LabelOrient;
  side: LabelSide;
  /** Space between the shape and the label, in px. */
  gap: number;
  /** Dragged offset, in the label's own frame (turned with "along" labels). */
  dx: number;
  dy: number;
  fontSize: number;
}

export interface Vector {
  x: number;
  y: number;
}

/** Reads `${prefix}-at`, `-orient`, ... (prefix "data-label" for built-in
 *  labels, "data-anchor" for attached texts). */
export function readLabelSettings(attrs: Record<string, string>, prefix: string, fontSize = 14): LabelSettings {
  const at = attrs[`${prefix}-at`];
  return {
    at: at === "start" || at === "mid" ? at : "end",
    orient: attrs[`${prefix}-orient`] === "along" ? "along" : "horizontal",
    side: attrs[`${prefix}-side`] === "below" ? "below" : "above",
    gap: literalNumber(attrs[`${prefix}-gap`]) ?? 6,
    dx: literalNumber(attrs[`${prefix}-dx`]) ?? 0,
    dy: literalNumber(attrs[`${prefix}-dy`]) ?? 0,
    fontSize,
  };
}

export interface LabelPlacement {
  x: Linear;
  y: Linear;
  anchor: "start" | "middle" | "end";
  /** Degrees (screen, clockwise) to turn the text about its position; null when upright. */
  rotate: number | null;
}

/** The side of a shape that reads as "above": up for a level line, left
 *  for an upright one, whichever way the shape points. */
export function upNormal(u: Vector): Vector {
  let n = { x: u.y, y: -u.x };
  if (n.y > 1e-9 || (Math.abs(n.y) <= 1e-9 && n.x > 0)) n = { x: -n.x, y: -n.y };
  return n;
}

/** The text angle for a label along direction `u`, turned so it never reads upside down. */
export function readableAngle(u: Vector): number {
  let degrees = (Math.atan2(u.y, u.x) * 180) / Math.PI;
  if (degrees > 90.0001) degrees -= 180;
  else if (degrees < -90.0001) degrees += 180;
  // Upright text reads bottom-to-top, whichever way a vertical shape points.
  if (Math.abs(degrees - 90) < 0.0001) degrees = -90;
  return Math.round(degrees * 100) / 100;
}

/** Places a label at point `p` (which may grow with a length) on a shape
 *  pointing along unit vector `u`. Text is centred vertically with dy="0.35em". */
export function placeLabel(p: { x: Linear; y: Linear }, u: Vector, s: LabelSettings): LabelPlacement {
  const n = upNormal(u);
  const sideNormal = s.side === "above" ? n : { x: -n.x, y: -n.y };
  let offset: Vector;
  let anchor: LabelPlacement["anchor"] = "middle";
  let rotate: number | null = null;

  if (s.orient === "along") {
    rotate = readableAngle(u);
    // Turned half a turn from the shape's own direction to stay readable?
    const flipped = Math.cos(((rotate * Math.PI) / 180) - Math.atan2(u.y, u.x)) < 0;
    if (s.at === "end") {
      offset = { x: u.x * s.gap, y: u.y * s.gap };
      anchor = flipped ? "end" : "start";
    } else if (s.at === "start") {
      offset = { x: -u.x * s.gap, y: -u.y * s.gap };
      anchor = flipped ? "start" : "end";
    } else {
      const distance = s.gap + s.fontSize * 0.5;
      offset = { x: sideNormal.x * distance, y: sideNormal.y * distance };
    }
  } else if (s.at === "mid") {
    // Beside the middle: upright text needs a little more room off a level line.
    anchor = sideNormal.x < -0.5 ? "end" : sideNormal.x > 0.5 ? "start" : "middle";
    const distance = anchor === "middle" ? s.gap + s.fontSize * 0.6 : s.gap;
    offset = { x: sideNormal.x * distance, y: sideNormal.y * distance };
  } else {
    // Past the end (or before the start), growing away from the shape.
    const away = s.at === "end" ? u : { x: -u.x, y: -u.y };
    anchor = away.x > 0.5 ? "start" : away.x < -0.5 ? "end" : "middle";
    const distance = anchor === "middle" ? s.gap + s.fontSize * 0.6 : s.gap;
    offset = { x: away.x * distance, y: away.y * distance };
  }

  // The dragged offset is in the label's frame, so it turns with an "along" label.
  const radians = ((rotate ?? 0) * Math.PI) / 180;
  const drag = {
    x: s.dx * Math.cos(radians) - s.dy * Math.sin(radians),
    y: s.dx * Math.sin(radians) + s.dy * Math.cos(radians),
  };
  return {
    x: { a: p.x.a + offset.x + drag.x, b: p.x.b },
    y: { a: p.y.a + offset.y + drag.y, b: p.y.b },
    anchor,
    rotate,
  };
}

/** A screen-space drag turned into the label's own frame (inverse of the above). */
export function dragInLabelFrame(delta: Vector, frameDegrees: number): Vector {
  const radians = (-frameDegrees * Math.PI) / 180;
  return {
    x: delta.x * Math.cos(radians) - delta.y * Math.sin(radians),
    y: delta.x * Math.sin(radians) + delta.y * Math.cos(radians),
  };
}

/** Where along a line-like shape `at` is, as a fraction of its length. */
export function labelFraction(at: LabelAt): number {
  return at === "start" ? 0 : at === "mid" ? 0.5 : 1;
}
