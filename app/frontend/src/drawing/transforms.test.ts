import { describe, expect, it } from "vitest";

import {
  boxScaleFromCorner,
  canonicalize,
  framesBox,
  groupCorners,
  readGroupTransform,
  rotateTowards,
  rotationHandle,
  scaleFramesTogether,
  scaleFromCorner,
  writeGroupTransform,
  type GroupTransform,
} from "./transforms";
import type { SceneElement } from "./scene";

// A 40 x 20 stamp drawn around (20, 10), placed with its centre at (100, 100).
const base: GroupTransform = { cx: 100, cy: 100, rotation: 0, scale: 1, ox: 20, oy: 10, width: 40, height: 20 };
const round = (point: { x: number; y: number }) => ({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 });

describe("group transforms", () => {
  it("writes translate-rotate-scale about the centre and reads it back", () => {
    const group: SceneElement = { key: "g", kind: "group", attrs: { "data-nexam-stamp": "Box" }, children: [] };
    const placed = writeGroupTransform(group, { ...base, rotation: 30, scale: 1.5 });
    expect(placed.kind === "group" && placed.attrs.transform).toBe("translate(100 100) rotate(30) scale(1.5) translate(-20 -10)");
    expect(readGroupTransform(placed)).toEqual({ ...base, rotation: 30, scale: 1.5, flipX: false, flipY: false });
  });

  it("flips about the centre with a negative scale on one axis", () => {
    const group: SceneElement = { key: "g", kind: "group", attrs: {}, children: [] };
    const flipped = writeGroupTransform(group, { ...base, scale: 2, flipX: true });
    expect(flipped.kind === "group" && flipped.attrs.transform).toBe("translate(100 100) scale(-2 2) translate(-20 -10)");
    expect(flipped.kind === "group" && flipped.attrs["data-flip-x"]).toBe("true");
    // Flipping both ways is a plain 180° look-alike, written as two negatives.
    const both = writeGroupTransform(group, { ...base, flipX: true, flipY: true });
    expect(both.kind === "group" && both.attrs.transform).toBe("translate(100 100) scale(-1) translate(-20 -10)");
    // Unflipping removes the attribute.
    const back = writeGroupTransform(flipped, { ...readGroupTransform(flipped)!, flipX: false });
    expect(back.kind === "group" && back.attrs["data-flip-x"]).toBeUndefined();
  });

  it("reads a mirrored older transform as a flip", () => {
    const tf = canonicalize({ x: 0, y: 0, width: 40, height: 20 }, { a: -1, b: 0, c: 0, d: 1, e: 140, f: 0 });
    expect(tf).toMatchObject({ cx: 120, cy: 10, scale: 1, flipX: true });
    expect(Math.abs(tf.rotation) % 360).toBe(0);
  });

  it("finds the corners and rotation handle of a turned stamp", () => {
    expect(groupCorners(base).map(round)).toEqual([
      { x: 80, y: 90 },
      { x: 120, y: 90 },
      { x: 120, y: 110 },
      { x: 80, y: 110 },
    ]);
    // Turned 90° clockwise, the handle above the stamp points right.
    expect(round(rotationHandle({ ...base, rotation: 90 }, 15))).toEqual({ x: 125, y: 100 });
  });

  it("scales from a corner keeping the opposite corner and the proportions", () => {
    // Drag the bottom-right corner from (120, 110) out to (160, 130): twice the size.
    const next = scaleFromCorner(base, 2, { x: 160, y: 130 }, false);
    expect(next.scale).toBe(2);
    expect(round(groupCorners(next)[0])).toEqual({ x: 80, y: 90 });
    // With Alt, about the centre.
    const centred = scaleFromCorner(base, 2, { x: 140, y: 120 }, true);
    expect([centred.scale, centred.cx, centred.cy]).toEqual([2, 100, 100]);
  });

  it("never scales to nothing", () => {
    expect(scaleFromCorner(base, 2, { x: 0, y: 0 }, false).scale).toBeGreaterThan(0);
  });

  it("rotates about the centre in 15° steps, or freely", () => {
    expect(rotateTowards(base, { x: 100, y: 80 }, { x: 121, y: 79 }, false).rotation).toBe(45);
    expect(rotateTowards(base, { x: 100, y: 80 }, { x: 121, y: 79 }, true).rotation).toBe(45);
    expect(rotateTowards(base, { x: 100, y: 80 }, { x: 110, y: 80.5 }, false).rotation).toBe(30);
    expect(rotateTowards(base, { x: 100, y: 80 }, { x: 110, y: 80.5 }, true).rotation).toBe(27);
  });

  it("turns an older transform into centred settings without moving it", () => {
    // translate(78 70) scale(2): the local box (0,0)-(44,60) is drawn from (78,70) to (166,190).
    const tf = canonicalize({ x: 0, y: 0, width: 44, height: 60 }, { a: 2, b: 0, c: 0, d: 2, e: 78, f: 70 });
    expect(tf).toEqual({ cx: 122, cy: 130, rotation: 0, scale: 2, ox: 22, oy: 30, width: 44, height: 60 });
    expect(groupCorners(tf).map(round)[0]).toEqual({ x: 78, y: 70 });
  });
});

describe("several stamps resized together", () => {
  const frame = (cx: number, cy: number, extra: Partial<GroupTransform> = {}): GroupTransform => ({
    cx,
    cy,
    rotation: 0,
    scale: 1,
    ox: 10,
    oy: 10,
    width: 20,
    height: 20,
    ...extra,
  });

  it("measures the box around all of them, turned ones included", () => {
    expect(framesBox([frame(20, 20), frame(100, 50)])).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    const turned = framesBox([frame(50, 50, { rotation: 45 })]);
    expect(turned.width).toBeCloseTo(20 * Math.SQRT2);
  });

  it("scales sizes and spacing about a point, or each in place", () => {
    const [a, b] = scaleFramesTogether([frame(20, 20), frame(100, 50)], { x: 10, y: 10 }, 2);
    expect([a.cx, a.cy, a.scale]).toEqual([30, 30, 2]);
    expect([b.cx, b.cy, b.scale]).toEqual([190, 90, 2]);
    const [c] = scaleFramesTogether([frame(20, 20, { scale: 1.5 })], { x: 0, y: 0 }, 0.5, true);
    expect([c.cx, c.cy, c.scale]).toEqual([20, 20, 0.75]);
  });

  it("dragging a corner keeps the opposite one still, or the centre with Alt", () => {
    const box = { x: 10, y: 10, width: 100, height: 50 };
    // Bottom-right corner (110, 60) dragged out to (210, 110): twice the size about (10, 10).
    expect(boxScaleFromCorner(box, 2, { x: 210, y: 110 }, false)).toEqual({ factor: 2, about: { x: 10, y: 10 } });
    const centred = boxScaleFromCorner(box, 2, { x: 160, y: 85 }, true);
    expect(centred.about).toEqual({ x: 60, y: 35 });
    expect(centred.factor).toBeCloseTo(2);
    expect(boxScaleFromCorner(box, 2, { x: 0, y: 0 }, false).factor).toBe(0.05);
  });
});
