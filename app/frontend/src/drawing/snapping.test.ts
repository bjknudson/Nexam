import { describe, expect, it } from "vitest";

import { createControlFromDrag } from "./controls";
import type { SceneElement } from "./scene";
import { crossing, directionsFrom, nearestSnap, segmentsOf, snapPoints } from "./snapping";
import { defaultStyle } from "./styles";

const line = (key: string, x1: number, y1: number, x2: number, y2: number): SceneElement => ({
  key,
  kind: "line",
  attrs: { x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2) },
});

describe("arc centre snapping", () => {
  it("finds ends and crossings of lines and variable arrows", () => {
    const arrow = createControlFromDrag("variable-arrow", { x: 50, y: 150 }, { x: 50, y: 100 }, defaultStyle(), [], 20)!;
    const segments = segmentsOf([line("a", 0, 100, 100, 100), line("b", 50, 50, 50, 150), arrow.element], { [arrow.variable]: "50" });
    expect(segments.map((segment) => segment.key)).toEqual(["a", "b", arrow.element.key]);
    const points = snapPoints(segments);
    expect(points.filter((point) => point.kind === "crossing")).toContainEqual({ x: 50, y: 100, kind: "crossing" });
    expect(points.filter((point) => point.kind === "end")).toHaveLength(6);
  });

  it("skips the item being moved, and ignores lines that don't meet", () => {
    expect(snapPoints(segmentsOf([line("a", 0, 0, 10, 0), line("b", 0, 5, 10, 5)], {}), "a")).toHaveLength(2);
    expect(crossing({ key: "a", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }, { key: "b", start: { x: 20, y: -5 }, end: { x: 20, y: 5 } })).toBeNull();
  });

  it("picks the nearest within the radius", () => {
    const points = snapPoints(segmentsOf([line("a", 0, 100, 100, 100)], {}));
    expect(nearestSnap(points, { x: 96, y: 103 }, 8)).toEqual({ x: 100, y: 100, kind: "end" });
    expect(nearestSnap(points, { x: 50, y: 100 }, 8)).toBeNull();
  });

  it("gives a line's direction pointing away from the arc's centre", () => {
    const segment = { key: "a", start: { x: 100, y: 100 }, end: { x: 0, y: 0 } };
    expect(directionsFrom(segment, { x: 100, y: 100 })).toEqual([135]);
    expect(directionsFrom(segment, { x: 0, y: 0 })).toEqual([315]);
    // Off the line: from its nearer end to the far one.
    expect(directionsFrom(segment, { x: 120, y: 90 })).toEqual([135]);
  });

  it("offers both arms of a line through the centre", () => {
    const segment = { key: "a", start: { x: 0, y: 100 }, end: { x: 200, y: 100 } };
    expect(directionsFrom(segment, { x: 120, y: 100 })).toEqual([0, 180]);
  });
});
