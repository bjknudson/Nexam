// Texts attached to shapes: a <text data-nexam-anchor="<target id>"> whose
// position is computed from a point on the target (its tail, middle, tip,
// centre or an edge) plus a gap and a dragged offset, so it follows the shape
// in the editor and, for variable controls, in every question version.
// See "Labels that follow shapes" in docs/svg-editor-plan.md.

import { controlAnchorFrame, controlKind, isControl } from "./controls";
import { formatNumber, type Linear } from "./geometry";
import { dragInLabelFrame, placeLabel, readLabelSettings, type LabelAt, type Vector } from "./labelLayout";
import { evaluateExpression } from "./preview";
import { literalNumber, type SceneDocument, type SceneElement } from "./scene";
import { isArrow } from "./shapes";
import { readGroupTransform } from "./transforms";
import { canEnterGroup } from "./tree";

export type AnchorPoint = "start" | "mid" | "end" | "center" | "top" | "bottom" | "left" | "right" | "here";

const ANCHOR_ATTRS = [
  "data-nexam-anchor",
  "data-anchor-point",
  "data-anchor-at",
  "data-anchor-orient",
  "data-anchor-side",
  "data-anchor-gap",
  "data-anchor-dx",
  "data-anchor-dy",
  "data-anchor-ox",
  "data-anchor-oy",
];

const HERE = { value: "here" as const, label: "Here (keeps its place)" };

export function isAnchoredText(element: SceneElement): boolean {
  return element.kind === "text" && Boolean(element.attrs["data-nexam-anchor"]);
}

export function anchorTargetId(element: SceneElement): string | null {
  return element.kind === "text" ? element.attrs["data-nexam-anchor"] ?? null : null;
}

/** The points a text can attach to on `target`, with names for the menu. */
export function anchorPointsFor(target: SceneElement): { value: AnchorPoint; label: string }[] {
  const lineLike = (start: string, end: string) => [
    { value: "start" as const, label: start },
    { value: "mid" as const, label: "Middle" },
    { value: "end" as const, label: end },
  ];
  if (target.kind === "line") return [...lineLike("Start", "End"), HERE];
  if (isArrow(target)) return [...lineLike("Tail", "Tip"), HERE];
  const kind = controlKind(target);
  if (kind === "variable-arrow") return controlAnchorFrame(target, 1) ? lineLike("Tail", "Tip") : [];
  if (kind === "variable-bar") return lineLike("Base", "End");
  // Stamps and groups, by the frame they're placed in (transforms.ts).
  // A group placed before centred transforms is offered too: the editor
  // measures and converts it when a text is attached.
  if (
    target.kind === "rect" ||
    target.kind === "ellipse" ||
    target.kind === "circle" ||
    readGroupTransform(target) ||
    (target.kind === "group" && canEnterGroup(target))
  ) {
    return [
      { value: "center", label: "Centre" },
      { value: "top", label: "Above" },
      { value: "bottom", label: "Below" },
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
      HERE,
    ];
  }
  return [];
}

/** Shapes in `elements` a text can attach to (same group, so they share coordinates). */
export function anchorCandidates(elements: SceneElement[], text: SceneElement): SceneElement[] {
  return elements.filter((element) => element.key !== text.key && anchorPointsFor(element).length > 0);
}

interface Frame {
  point: { x: Linear; y: Linear };
  /** Direction for placement: along a line-like shape, or outward from a box edge. */
  u: Vector;
  toAttr: (value: Linear) => string;
  /** Box anchors place text beyond the edge; line-like anchors use start/mid/end placement. */
  at: LabelAt;
  centered: boolean;
}

const literal = (value: Linear) => formatNumber(value.a);

function frameFor(target: SceneElement, point: AnchorPoint): Frame | null {
  const t = point === "start" ? 0 : point === "mid" ? 0.5 : 1;
  const at: LabelAt = point === "start" ? "start" : point === "mid" ? "mid" : "end";
  const fromEnds = (x1: number, y1: number, x2: number, y2: number): Frame => {
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    return {
      point: { x: { a: x1 + (x2 - x1) * t, b: 0 }, y: { a: y1 + (y2 - y1) * t, b: 0 } },
      u: { x: (x2 - x1) / length, y: (y2 - y1) / length },
      toAttr: literal,
      at,
      centered: false,
    };
  };
  const n = (name: string) => (target.kind === "passthrough" ? null : literalNumber(target.attrs[name]));

  if (target.kind === "line") {
    const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map(n);
    return x1 === null || y1 === null || x2 === null || y2 === null ? null : fromEnds(x1, y1, x2, y2);
  }
  if (isArrow(target)) {
    const [x1, y1, x2, y2] = ["data-x1", "data-y1", "data-x2", "data-y2"].map(n);
    return x1 === null || y1 === null || x2 === null || y2 === null ? null : fromEnds(x1, y1, x2, y2);
  }
  if (isControl(target)) {
    const frame = controlAnchorFrame(target, t);
    return frame ? { point: frame.point, u: frame.u, toAttr: frame.toAttr, at, centered: false } : null;
  }

  // A stamp or group: its edges turn with it, so "Below" stays below it as it rotates.
  const placed = readGroupTransform(target);
  if (placed) {
    const radians = (placed.rotation * Math.PI) / 180;
    const turn = (x: number, y: number) => ({
      x: x * Math.cos(radians) - y * Math.sin(radians),
      y: x * Math.sin(radians) + y * Math.cos(radians),
    });
    const hw = (placed.width * placed.scale) / 2;
    const hh = (placed.height * placed.scale) / 2;
    const offsets: Record<string, Vector> = {
      center: { x: 0, y: 0 },
      top: { x: 0, y: -hh },
      bottom: { x: 0, y: hh },
      left: { x: -hw, y: 0 },
      right: { x: hw, y: 0 },
    };
    const outward: Record<string, Vector> = {
      center: { x: 1, y: 0 },
      top: { x: 0, y: -1 },
      bottom: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    };
    const key = point in offsets ? point : "center";
    const at = turn(offsets[key].x, offsets[key].y);
    return {
      point: { x: { a: placed.cx + at.x, b: 0 }, y: { a: placed.cy + at.y, b: 0 } },
      u: turn(outward[key].x, outward[key].y),
      toAttr: literal,
      at: "end",
      centered: key === "center",
    };
  }

  // Boxes: centre, or just outside an edge.
  let cx: number | null;
  let cy: number | null;
  let hx: number | null;
  let hy: number | null;
  if (target.kind === "rect") {
    const [x, y, w, h] = ["x", "y", "width", "height"].map(n);
    if (x === null || y === null || w === null || h === null) return null;
    [cx, cy, hx, hy] = [x + w / 2, y + h / 2, w / 2, h / 2];
  } else if (target.kind === "circle") {
    [cx, cy, hx] = ["cx", "cy", "r"].map(n);
    hy = hx;
  } else if (target.kind === "ellipse") {
    [cx, cy, hx, hy] = ["cx", "cy", "rx", "ry"].map(n);
  } else {
    return null;
  }
  if (cx === null || cy === null || hx === null || hy === null) return null;
  const edges: Record<string, { x: number; y: number; u: Vector }> = {
    center: { x: cx, y: cy, u: { x: 1, y: 0 } },
    top: { x: cx, y: cy - hy, u: { x: 0, y: -1 } },
    bottom: { x: cx, y: cy + hy, u: { x: 0, y: 1 } },
    left: { x: cx - hx, y: cy, u: { x: -1, y: 0 } },
    right: { x: cx + hx, y: cy, u: { x: 1, y: 0 } },
  };
  const edge = edges[point] ?? edges.center;
  return {
    point: { x: { a: edge.x, b: 0 }, y: { a: edge.y, b: 0 } },
    u: edge.u,
    toAttr: literal,
    at: "end",
    centered: point === "center",
  };
}

/** A shape's own frame for "Here" texts: centre, rotation (screen degrees,
 *  clockwise), scale and flips. A text kept "here" stores its offset in this
 *  frame, so it orbits when the shape turns and keeps its relative spot when
 *  the shape grows. */
interface OrbitFrame {
  cx: number;
  cy: number;
  rotation: number;
  scale: number;
  sx: number;
  sy: number;
}

export function orbitFrame(target: SceneElement): OrbitFrame | null {
  const placed = readGroupTransform(target);
  if (placed) {
    return {
      cx: placed.cx,
      cy: placed.cy,
      rotation: placed.rotation,
      scale: placed.scale,
      sx: placed.flipX ? -1 : 1,
      sy: placed.flipY ? -1 : 1,
    };
  }
  const n = (name: string) => (target.kind === "passthrough" ? null : literalNumber(target.attrs[name]));
  const ends =
    target.kind === "line" ? ["x1", "y1", "x2", "y2"].map(n) : isArrow(target) ? ["data-x1", "data-y1", "data-x2", "data-y2"].map(n) : null;
  if (ends) {
    const [x1, y1, x2, y2] = ends;
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    // The line's midpoint and direction; its length doesn't scale the offset.
    return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, rotation: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI, scale: 1, sx: 1, sy: 1 };
  }
  if (target.kind === "rect") {
    const [x, y, w, h] = ["x", "y", "width", "height"].map(n);
    if (x === null || y === null || w === null || h === null) return null;
    return { cx: x + w / 2, cy: y + h / 2, rotation: 0, scale: 1, sx: 1, sy: 1 };
  }
  if (target.kind === "circle" || target.kind === "ellipse") {
    const [cx, cy] = ["cx", "cy"].map(n);
    return cx === null || cy === null ? null : { cx, cy, rotation: 0, scale: 1, sx: 1, sy: 1 };
  }
  return null;
}

function turn(point: Vector, degrees: number): Vector {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  };
}

/** From the shape's frame to the canvas, and back. */
function fromFrame(frame: OrbitFrame, offset: Vector): Vector {
  const at = turn({ x: offset.x * frame.scale * frame.sx, y: offset.y * frame.scale * frame.sy }, frame.rotation);
  return { x: frame.cx + at.x, y: frame.cy + at.y };
}

function toFrame(frame: OrbitFrame, delta: Vector): Vector {
  const back = turn(delta, -frame.rotation);
  return { x: back.x / (frame.scale * frame.sx), y: back.y / (frame.scale * frame.sy) };
}

/** The attached text with x/y/transform recomputed from its target. */
export function layoutAnchoredText(text: SceneElement, target: SceneElement): SceneElement {
  if (text.kind !== "text") return text;
  const point = (text.attrs["data-anchor-point"] ?? "end") as AnchorPoint;
  if (point === "here") {
    // Keeps the text's own alignment; only its position follows the shape.
    const frame = orbitFrame(target);
    if (!frame) return text;
    const at = fromFrame(frame, {
      x: literalNumber(text.attrs["data-anchor-ox"]) ?? 0,
      y: literalNumber(text.attrs["data-anchor-oy"]) ?? 0,
    });
    const attrs: Record<string, string> = { ...text.attrs, x: formatNumber(at.x), y: formatNumber(at.y) };
    delete attrs.transform;
    return { ...text, attrs };
  }
  const frame = frameFor(target, point);
  if (!frame) return text;
  const fontSize = literalNumber(text.attrs["font-size"]) ?? 14;
  const settings = { ...readLabelSettings(text.attrs, "data-anchor", fontSize), at: frame.at };
  const place = frame.centered
    ? {
        x: { a: frame.point.x.a + settings.dx, b: 0 },
        y: { a: frame.point.y.a + settings.dy, b: 0 },
        anchor: "middle" as const,
        rotate: null,
      }
    : placeLabel(frame.point, frame.u, settings);
  const x = frame.toAttr(place.x);
  const y = frame.toAttr(place.y);
  const attrs: Record<string, string> = { ...text.attrs, x, y, dy: "0.35em", "text-anchor": place.anchor };
  if (place.rotate !== null && place.rotate !== 0) attrs.transform = `rotate(${formatNumber(place.rotate)} ${x} ${y})`;
  else delete attrs.transform;
  return { ...text, attrs };
}

/** Recomputes every attached text whose target is in the same group. Texts
 *  whose target is gone keep their last position. Unchanged texts keep their
 *  identity, so this is cheap to run after every edit. */
export function relayoutAnchors(document: SceneDocument): SceneDocument {
  let changed = false;
  const layoutList = (elements: SceneElement[]): SceneElement[] => {
    const byId = new Map<string, SceneElement>();
    for (const element of elements) {
      if (element.kind !== "passthrough" && element.attrs.id) byId.set(element.attrs.id, element);
    }
    return elements.map((element) => {
      let next = element;
      if (element.kind === "group" && canEnterGroup(element)) {
        const children = layoutList(element.children);
        if (children !== element.children && children.some((child, index) => child !== element.children[index])) {
          next = { ...element, children };
        }
      }
      const targetId = anchorTargetId(next);
      const target = targetId ? byId.get(targetId) : undefined;
      if (!target) return next;
      const laidOut = layoutAnchoredText(next, target);
      if (laidOut.kind === "text" && next.kind === "text" && sameAttrs(laidOut.attrs, next.attrs)) return next;
      changed = true;
      return laidOut;
    });
  };
  const elements = layoutList(document.elements);
  return changed || elements.some((element, index) => element !== document.elements[index]) ? { ...document, elements } : document;
}

function sameAttrs(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Every id used anywhere in the drawing (attached texts need unique ones). */
function collectIds(elements: SceneElement[], into = new Set<string>()): Set<string> {
  for (const element of elements) {
    if (element.kind === "passthrough") {
      for (const match of element.markup.matchAll(/\bid="([^"]+)"/g)) into.add(match[1]);
      continue;
    }
    if (element.attrs.id) into.add(element.attrs.id);
    if (element.kind === "group") collectIds(element.children, into);
  }
  return into;
}

export function uniqueElementId(document: SceneDocument, element: SceneElement, taken = collectIds(document.elements)): string {
  const base = `nexam-${controlKind(element) ?? (isArrow(element) ? "arrow" : element.kind)}`;
  let index = 1;
  while (taken.has(`${base}-${index}`)) index += 1;
  const id = `${base}-${index}`;
  taken.add(id);
  return id;
}

/** Attaches `text` to `target` at `point`: gives the target an id if needed
 *  and lays the text out. Returns both updated elements. */
export function attachText(
  document: SceneDocument,
  text: SceneElement,
  target: SceneElement,
  point: AnchorPoint,
): { text: SceneElement; target: SceneElement } {
  if (text.kind !== "text" || target.kind === "passthrough") return { text, target };
  const id = target.attrs.id ?? uniqueElementId(document, target);
  const withId = target.attrs.id ? target : ({ ...target, attrs: { ...target.attrs, id } } as SceneElement);
  const attrs: Record<string, string> = { ...text.attrs, "data-nexam-anchor": id, "data-anchor-point": point };
  delete attrs["data-anchor-dx"];
  delete attrs["data-anchor-dy"];
  delete attrs["data-anchor-ox"];
  delete attrs["data-anchor-oy"];
  if (point === "here") {
    // Exactly where it is now, as an offset in the shape's own frame.
    const frame = orbitFrame(withId);
    const x = literalNumber(text.attrs.x) ?? 0;
    const y = literalNumber(text.attrs.y) ?? 0;
    const offset = frame ? toFrame(frame, { x: x - frame.cx, y: y - frame.cy }) : { x: 0, y: 0 };
    attrs["data-anchor-ox"] = formatNumber(offset.x);
    attrs["data-anchor-oy"] = formatNumber(offset.y);
  }
  return { text: layoutAnchoredText({ ...text, attrs }, withId), target: withId };
}

/** Detaches a text, leaving it where it is drawn now (variable positions are
 *  resolved with the current preview values). */
export function detachText(text: SceneElement, values: Record<string, string>): SceneElement {
  if (text.kind !== "text") return text;
  const attrs = { ...text.attrs };
  for (const name of ANCHOR_ATTRS) delete attrs[name];
  for (const name of ["x", "y", "transform"]) {
    if (attrs[name]?.includes("{{")) {
      attrs[name] = attrs[name].replace(/\{\{\s*calc:\s*([^}]+?)\s*\}\}/g, (_match, expression: string) =>
        formatNumber(evaluateExpression(expression, values)),
      );
    }
  }
  return { ...text, attrs };
}

/** Dragging an attached text changes its offset from the anchor (in the
 *  text's own frame, so it turns with a text set along a shape). A "Here"
 *  text's offset is in the shape's frame, so `target` is needed for it. */
export function moveAnchoredText(text: SceneElement, dx: number, dy: number, target?: SceneElement): SceneElement {
  if (text.kind !== "text") return text;
  if (text.attrs["data-anchor-point"] === "here") {
    const frame = target ? orbitFrame(target) : null;
    if (!frame) return text;
    const delta = toFrame(frame, { x: dx, y: dy });
    return {
      ...text,
      attrs: {
        ...text.attrs,
        "data-anchor-ox": formatNumber((literalNumber(text.attrs["data-anchor-ox"]) ?? 0) + delta.x),
        "data-anchor-oy": formatNumber((literalNumber(text.attrs["data-anchor-oy"]) ?? 0) + delta.y),
      },
    };
  }
  const rotate = text.attrs.transform?.match(/rotate\(\s*(-?[\d.]+)/);
  const offset = dragInLabelFrame({ x: dx, y: dy }, rotate ? Number(rotate[1]) : 0);
  const current = readLabelSettings(text.attrs, "data-anchor");
  return {
    ...text,
    attrs: {
      ...text.attrs,
      "data-anchor-dx": formatNumber(current.dx + offset.x),
      "data-anchor-dy": formatNumber(current.dy + offset.y),
    },
  };
}

/** Where an anchor point is drawn now, with variable positions worked out
 *  from the preview values. "Here" has no single spot, so it gives null. */
export function anchorPointPosition(target: SceneElement, point: AnchorPoint, values: Record<string, string>): Vector | null {
  if (point === "here") return null;
  const frame = frameFor(target, point);
  if (!frame) return null;
  const resolve = (value: Linear) => {
    const attr = frame.toAttr(value);
    const resolved = attr.replace(/\{\{\s*calc:\s*([^}]+?)\s*\}\}/g, (_match, expression: string) =>
      String(evaluateExpression(expression, values)),
    );
    const number = Number(resolved);
    return Number.isFinite(number) ? number : null;
  };
  const x = resolve(frame.point.x);
  const y = resolve(frame.point.y);
  return x === null || y === null ? null : { x, y };
}

export interface AnchorSpot {
  target: SceneElement;
  point: AnchorPoint;
  label: string;
  x: number;
  y: number;
  distance: number;
}

/** Anchor points on the shapes `text` could attach to, within `reach` of
 *  `at`, nearest first. Used to show and snap to them while a text is dragged. */
export function anchorSpotsNear(
  elements: SceneElement[],
  text: SceneElement,
  at: Vector,
  reach: number,
  values: Record<string, string>,
): AnchorSpot[] {
  const spots: AnchorSpot[] = [];
  for (const target of anchorCandidates(elements, text)) {
    for (const { value, label } of anchorPointsFor(target)) {
      const position = anchorPointPosition(target, value, values);
      if (!position) continue;
      const distance = Math.hypot(position.x - at.x, position.y - at.y);
      if (distance <= reach) spots.push({ target, point: value, label, ...position, distance });
    }
  }
  return spots.sort((a, b) => a.distance - b.distance);
}
