// Placing, resizing and rotating stamps and groups about their centre.
// See "Resizing and rotating stamps" in docs/svg-editor-plan.md.
//
// A group keeps where it sits and how it's turned in data-* attributes, and
// its SVG transform is always generated from them:
//   translate(cx cy) rotate(θ) scale(±s ±s) translate(-ox -oy)
// (a negative scale on an axis is a flip, about the centre).
// where (ox, oy) is the centre of its own drawing and (width, height) its size.
// Groups placed before this keep their old transform until first resized or
// rotated, when canonicalize() turns what is drawn into these settings.

import type { Box } from "./align";
import { formatNumber } from "./geometry";
import { literalNumber, type SceneElement } from "./scene";

export interface Point {
  x: number;
  y: number;
}

export interface GroupTransform {
  /** Centre on the canvas (in the group's parent coordinates). */
  cx: number;
  cy: number;
  /** Degrees, clockwise on screen (SVG's rotate()). */
  rotation: number;
  scale: number;
  /** Mirrored left-right / top-bottom, about the centre (before the rotation). */
  flipX?: boolean;
  flipY?: boolean;
  /** Centre and size of the group's own drawing, before the transform. */
  ox: number;
  oy: number;
  width: number;
  height: number;
}

/** A 2-D affine matrix as SVG writes it: matrix(a b c d e f). */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function readGroupTransform(element: SceneElement): GroupTransform | null {
  if (element.kind !== "group") return null;
  const n = (name: string) => literalNumber(element.attrs[name]);
  const [cx, cy, ox, oy, width, height] = ["data-x", "data-y", "data-origin-x", "data-origin-y", "data-width", "data-height"].map(n);
  if (cx === null || cy === null || ox === null || oy === null || width === null || height === null) return null;
  return {
    cx,
    cy,
    ox,
    oy,
    width,
    height,
    rotation: n("data-rotation") ?? 0,
    scale: Math.max(0.01, n("data-scale") ?? 1),
    flipX: element.attrs["data-flip-x"] === "true",
    flipY: element.attrs["data-flip-y"] === "true",
  };
}

export function transformString(tf: GroupTransform): string {
  const rotate = Math.abs(tf.rotation % 360) > 0.001 ? ` rotate(${formatNumber(tf.rotation)})` : "";
  const sx = tf.flipX ? -tf.scale : tf.scale;
  const sy = tf.flipY ? -tf.scale : tf.scale;
  const scale =
    sx === sy
      ? Math.abs(sx - 1) > 0.0001
        ? ` scale(${formatNumber(sx)})`
        : ""
      : ` scale(${formatNumber(sx)} ${formatNumber(sy)})`;
  return `translate(${formatNumber(tf.cx)} ${formatNumber(tf.cy)})${rotate}${scale} translate(${formatNumber(-tf.ox)} ${formatNumber(-tf.oy)})`;
}

export function writeGroupTransform(element: SceneElement, tf: GroupTransform): SceneElement {
  if (element.kind !== "group") return element;
  const normalized = ((tf.rotation % 360) + 540) % 360 - 180;
  const { "data-flip-x": _flipX, "data-flip-y": _flipY, ...rest } = element.attrs;
  return {
    ...element,
    attrs: {
      ...rest,
      ...(tf.flipX ? { "data-flip-x": "true" } : {}),
      ...(tf.flipY ? { "data-flip-y": "true" } : {}),
      "data-x": formatNumber(tf.cx),
      "data-y": formatNumber(tf.cy),
      "data-rotation": formatNumber(normalized === -180 ? 180 : normalized),
      "data-scale": formatNumber(tf.scale),
      "data-origin-x": formatNumber(tf.ox),
      "data-origin-y": formatNumber(tf.oy),
      "data-width": formatNumber(tf.width),
      "data-height": formatNumber(tf.height),
      transform: transformString({ ...tf, rotation: normalized === -180 ? 180 : normalized }),
    },
  };
}

/** Settings for a group drawn with any transform: its local bounding box and
 *  that transform as a matrix. Only rotation and uniform scale are kept. */
export function canonicalize(box: { x: number; y: number; width: number; height: number }, matrix: Matrix): GroupTransform {
  const ox = box.x + box.width / 2;
  const oy = box.y + box.height / 2;
  // A mirrored transform (negative determinant) is read as a left-right flip.
  const flipped = matrix.a * matrix.d - matrix.b * matrix.c < 0;
  return {
    cx: matrix.a * ox + matrix.c * oy + matrix.e,
    cy: matrix.b * ox + matrix.d * oy + matrix.f,
    rotation: (Math.atan2(flipped ? -matrix.b : matrix.b, flipped ? -matrix.a : matrix.a) * 180) / Math.PI,
    scale: Math.hypot(matrix.a, matrix.b) || 1,
    ...(flipped ? { flipX: true } : {}),
    ox,
    oy,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
  };
}

function rotated(point: Point, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  };
}

/** Corners on the canvas: top-left, top-right, bottom-right, bottom-left. */
export function groupCorners(tf: GroupTransform): Point[] {
  const hw = (tf.width * tf.scale) / 2;
  const hh = (tf.height * tf.scale) / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((corner) => {
    const point = rotated(corner, tf.rotation);
    return { x: tf.cx + point.x, y: tf.cy + point.y };
  });
}

/** Where the rotation handle sits: above the top edge (in the turned frame). */
export function rotationHandle(tf: GroupTransform, gap: number): Point {
  const point = rotated({ x: 0, y: -(tf.height * tf.scale) / 2 - gap }, tf.rotation);
  return { x: tf.cx + point.x, y: tf.cy + point.y };
}

export function topMiddle(tf: GroupTransform): Point {
  const point = rotated({ x: 0, y: -(tf.height * tf.scale) / 2 }, tf.rotation);
  return { x: tf.cx + point.x, y: tf.cy + point.y };
}

/** Dragging corner `index` to `to`: keeps the proportions, and keeps the
 *  opposite corner still (or the centre, `fromCentre`). */
export function scaleFromCorner(start: GroupTransform, index: number, to: Point, fromCentre: boolean): GroupTransform {
  const corners = groupCorners(start);
  const dragged = corners[index];
  const anchor = fromCentre ? { x: start.cx, y: start.cy } : corners[(index + 2) % 4];
  const span = { x: dragged.x - anchor.x, y: dragged.y - anchor.y };
  const length = Math.hypot(span.x, span.y) || 1;
  // How far along the corner's diagonal the pointer is.
  const along = ((to.x - anchor.x) * span.x + (to.y - anchor.y) * span.y) / length;
  const factor = Math.max(0.05 / start.scale, along / length);
  const scale = Math.round(start.scale * factor * 1000) / 1000;
  const applied = scale / start.scale;
  if (fromCentre) return { ...start, scale };
  return {
    ...start,
    scale,
    cx: anchor.x + (span.x * applied) / 2,
    cy: anchor.y + (span.y * applied) / 2,
  };
}

/** Dragging the rotation handle: turns about the centre in 15° steps, or 1° freely. */
export function rotateTowards(start: GroupTransform, from: Point, to: Point, free: boolean): GroupTransform {
  const angle = (point: Point) => (Math.atan2(point.y - start.cy, point.x - start.cx) * 180) / Math.PI;
  const raw = start.rotation + angle(to) - angle(from);
  const step = free ? 1 : 15;
  return { ...start, rotation: Math.round(raw / step) * step };
}

export function translateGroupTransform(element: SceneElement, dx: number, dy: number): SceneElement | null {
  const tf = readGroupTransform(element);
  return tf ? writeGroupTransform(element, { ...tf, cx: tf.cx + dx, cy: tf.cy + dy }) : null;
}

// ---------------------------------------------------------------------------
// Several stamps resized together
// ---------------------------------------------------------------------------

/** The box around every placed group's corners (they may be turned). */
export function framesBox(frames: GroupTransform[]): Box {
  const corners = frames.flatMap(groupCorners);
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Corners of a box: top-left, top-right, bottom-right, bottom-left (as groupCorners). */
export function boxCorners(box: Box): Point[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

/** Every group grows by `factor`, and its centre moves away from `about`
 *  by the same factor, so the layout scales as one picture. With `inPlace`
 *  each keeps its centre and only grows. */
export function scaleFramesTogether(frames: GroupTransform[], about: Point, factor: number, inPlace = false): GroupTransform[] {
  return frames.map((frame) => {
    const scale = Math.max(0.01, Math.round(frame.scale * factor * 1000) / 1000);
    if (inPlace) return { ...frame, scale };
    return {
      ...frame,
      scale,
      cx: about.x + (frame.cx - about.x) * factor,
      cy: about.y + (frame.cy - about.y) * factor,
    };
  });
}

/** Dragging corner `index` of the combined box to `to`: the factor (keeping
 *  proportions) and the point it scales about, the opposite corner or the
 *  centre (`fromCentre`). */
export function boxScaleFromCorner(box: Box, index: number, to: Point, fromCentre: boolean): { factor: number; about: Point } {
  const corners = boxCorners(box);
  const dragged = corners[index];
  const about = fromCentre ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : corners[(index + 2) % 4];
  const span = { x: dragged.x - about.x, y: dragged.y - about.y };
  const length = Math.hypot(span.x, span.y) || 1;
  const along = ((to.x - about.x) * span.x + (to.y - about.y) * span.y) / length;
  return { factor: Math.max(0.05, along / length), about };
}
