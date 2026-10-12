// Creating and changing shapes. Everything here is a pure function on
// SceneElement so the editor component stays about interaction only.

import {
  hasPlaceholder,
  literalNumber,
  newElementKey,
  type SceneElement,
} from "./scene";
import { createFixedArcFromDrag, fixedArcHandles, isFixedArc, moveFixedArcHandle, rebuildFixedArc, translateFixedArc } from "./arcs";
import { isControl, rebuildControl, translateControl } from "./controls";
import { readGroupTransform, translateGroupTransform, writeGroupTransform } from "./transforms";
import { arrowHeadSize, formatNumber } from "./geometry";
import { labelFraction, placeLabel, readLabelSettings, readableAngle } from "./labelLayout";
import { applyStrokeAttrs, type DrawingStyle } from "./styles";

export { formatNumber };

export type DrawingTool =
  | "select"
  | "line"
  | "arrow"
  | "rect"
  | "circle"
  | "ellipse"
  | "triangle"
  | "right-triangle"
  | "polygon"
  | "polyline"
  | "point"
  | "text"
  | "arc"
  | "variable-arrow"
  | "variable-bar"
  | "variable-arc";

/** Tools drawn by clicking points one at a time instead of one drag. */
export const POINT_BY_POINT_TOOLS: DrawingTool[] = ["polygon", "polyline"];

export interface Point {
  x: number;
  y: number;
}

export type ArrowHeads = "end" | "start" | "both" | "none";

/** An arrow group, or a labeled line (saved the same way, without heads). */
export function isArrow(element: SceneElement): boolean {
  const shape = element.kind === "group" ? element.attrs["data-nexam-shape"] : undefined;
  return shape === "arrow" || shape === "line";
}

export function isLabeledLine(element: SceneElement): boolean {
  return element.kind === "group" && element.attrs["data-nexam-shape"] === "line";
}

/** Regenerates the children of arrows and variable controls after their
 *  settings or style change; other elements are returned as they are. */
export function rebuildShape(element: SceneElement): SceneElement {
  if (isFixedArc(element)) return rebuildFixedArc(element);
  if (isArrow(element)) return rebuildArrow(element);
  if (isControl(element)) return rebuildControl(element);
  return element;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/** A new shape from a drag between two points, or null when the drag was too small. */
export function createShapeFromDrag(
  tool: DrawingTool,
  start: Point,
  end: Point,
  style: DrawingStyle,
): SceneElement | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(dx);
  const height = Math.abs(dy);
  const tooSmall = Math.hypot(dx, dy) < 2;

  const outlined = (attrs: Record<string, string>) =>
    applyStrokeAttrs({ ...attrs, fill: style.fill }, style);

  switch (tool) {
    case "line":
      if (tooSmall) return null;
      return {
        key: newElementKey(),
        kind: "line",
        attrs: applyStrokeAttrs(
          {
            x1: formatNumber(start.x),
            y1: formatNumber(start.y),
            x2: formatNumber(end.x),
            y2: formatNumber(end.y),
          },
          style,
        ),
      };
    case "arrow":
      if (tooSmall) return null;
      return buildArrow(start, end, "end", style);
    case "rect":
      if (width < 2 || height < 2) return null;
      return {
        key: newElementKey(),
        kind: "rect",
        attrs: outlined({
          x: formatNumber(left),
          y: formatNumber(top),
          width: formatNumber(width),
          height: formatNumber(height),
        }),
      };
    case "circle": {
      const r = Math.hypot(dx, dy);
      if (r < 2) return null;
      return {
        key: newElementKey(),
        kind: "circle",
        attrs: outlined({
          cx: formatNumber(start.x),
          cy: formatNumber(start.y),
          r: formatNumber(r),
        }),
      };
    }
    case "ellipse":
      if (width < 2 || height < 2) return null;
      return {
        key: newElementKey(),
        kind: "ellipse",
        attrs: outlined({
          cx: formatNumber(left + width / 2),
          cy: formatNumber(top + height / 2),
          rx: formatNumber(width / 2),
          ry: formatNumber(height / 2),
        }),
      };
    case "triangle":
    case "right-triangle": {
      if (width < 2 || height < 2) return null;
      const bottom = top + height;
      const points: Point[] =
        tool === "triangle"
          ? [
              { x: left, y: bottom },
              { x: left + width, y: bottom },
              { x: left + width / 2, y: top },
            ]
          : [
              { x: left, y: bottom },
              { x: left + width, y: bottom },
              { x: left, y: top },
            ];
      return {
        key: newElementKey(),
        kind: "polygon",
        attrs: outlined({ points: formatPoints(points) }),
      };
    }
    case "arc":
      return createFixedArcFromDrag(start, end, style);
    default:
      return null;
  }
}

/** A single-click shape: a point (dot) or a text label. */
export function createShapeAtPoint(
  tool: DrawingTool,
  at: Point,
  style: DrawingStyle,
): SceneElement | null {
  if (tool === "point") {
    return {
      key: newElementKey(),
      kind: "circle",
      attrs: {
        cx: formatNumber(at.x),
        cy: formatNumber(at.y),
        r: "3",
        fill: style.stroke === "none" ? "#000000" : style.stroke,
      },
    };
  }
  if (tool === "text") {
    return {
      key: newElementKey(),
      kind: "text",
      attrs: {
        x: formatNumber(at.x),
        y: formatNumber(at.y),
        "font-size": String(style.fontSize),
        "font-family": "sans-serif",
        fill: style.stroke === "none" ? "#000000" : style.stroke,
      },
      text: "Label",
    };
  }
  return null;
}

/** A polygon or polyline from clicked points, or null with too few points. */
export function createShapeFromPoints(
  tool: DrawingTool,
  points: Point[],
  style: DrawingStyle,
): SceneElement | null {
  const kind = tool === "polygon" ? "polygon" : tool === "polyline" ? "polyline" : null;
  if (!kind || points.length < (kind === "polygon" ? 3 : 2)) return null;
  return {
    key: newElementKey(),
    kind,
    attrs: applyStrokeAttrs(
      { points: formatPoints(points), fill: kind === "polygon" ? style.fill : "none" },
      style,
    ),
  };
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

/** An arrow is a <g data-nexam-shape="arrow"> holding a line and polygon heads.
 *  The endpoints live on the group (data-x1 ... data-y2) so the editor can
 *  rebuild the heads whenever the arrow moves or its stroke weight changes.
 *  Polygon heads instead of <marker> keep printing and placeholder rendering simple. */
export function buildArrow(
  start: Point,
  end: Point,
  heads: ArrowHeads,
  style: Pick<DrawingStyle, "stroke" | "strokeWidth" | "lineType">,
): SceneElement {
  const group: SceneElement = {
    key: newElementKey(),
    kind: "group",
    attrs: applyStrokeAttrs(
      {
        "data-nexam-shape": "arrow",
        "data-heads": heads,
        "data-x1": formatNumber(start.x),
        "data-y1": formatNumber(start.y),
        "data-x2": formatNumber(end.x),
        "data-y2": formatNumber(end.y),
        fill: "none",
      },
      style,
    ),
    children: [],
  };
  return rebuildArrow(group);
}

export function rebuildArrow(group: SceneElement): SceneElement {
  if (group.kind !== "group") return group;
  const x1 = literalNumber(group.attrs["data-x1"]);
  const y1 = literalNumber(group.attrs["data-y1"]);
  const x2 = literalNumber(group.attrs["data-x2"]);
  const y2 = literalNumber(group.attrs["data-y2"]);
  // An arrow whose ends are variables is drawn by the variable-arrow control, not here.
  if (x1 === null || y1 === null || x2 === null || y2 === null) return group;

  const heads = (group.attrs["data-heads"] ?? "end") as ArrowHeads;
  const weight = literalNumber(group.attrs["stroke-width"]) ?? 1.5;
  const color = group.attrs.stroke && group.attrs.stroke !== "none" ? group.attrs.stroke : "#000000";
  const { length: headLength, halfWidth } = arrowHeadSize(weight);

  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;

  const head = (tip: Point, direction: 1 | -1) => {
    const baseX = tip.x - direction * ux * headLength;
    const baseY = tip.y - direction * uy * headLength;
    return [
      tip,
      { x: baseX - uy * halfWidth, y: baseY + ux * halfWidth },
      { x: baseX + uy * halfWidth, y: baseY - ux * halfWidth },
    ];
  };

  // Stop the shaft just inside each head so a thick line can't poke out past the tip.
  const inset = Math.min(headLength * 0.8, length / 2);
  const lineStart =
    heads === "start" || heads === "both" ? { x: x1 + ux * inset, y: y1 + uy * inset } : { x: x1, y: y1 };
  const lineEnd =
    heads === "end" || heads === "both" ? { x: x2 - ux * inset, y: y2 - uy * inset } : { x: x2, y: y2 };

  const children: SceneElement[] = [
    {
      key: newElementKey(),
      kind: "line",
      attrs: {
        x1: formatNumber(lineStart.x),
        y1: formatNumber(lineStart.y),
        x2: formatNumber(lineEnd.x),
        y2: formatNumber(lineEnd.y),
      },
    },
  ];
  if (heads === "end" || heads === "both") {
    children.push({
      key: newElementKey(),
      kind: "polygon",
      attrs: { points: formatPoints(head({ x: x2, y: y2 }, 1)), fill: color, stroke: "none" },
    });
  }
  if (heads === "start" || heads === "both") {
    children.push({
      key: newElementKey(),
      kind: "polygon",
      attrs: { points: formatPoints(head({ x: x1, y: y1 }, -1)), fill: color, stroke: "none" },
    });
  }
  const label = group.attrs["data-label"] ?? "";
  if (label.trim() !== "") {
    const fontSize = literalNumber(group.attrs["data-font-size"]) ?? 14;
    const settings = readLabelSettings(group.attrs, "data-label", fontSize);
    const t = labelFraction(settings.at);
    const place = placeLabel(
      { x: { a: x1 + (x2 - x1) * t, b: 0 }, y: { a: y1 + (y2 - y1) * t, b: 0 } },
      { x: ux, y: uy },
      settings,
    );
    const x = formatNumber(place.x.a);
    const y = formatNumber(place.y.a);
    const attrs: Record<string, string> = {
      x,
      y,
      dy: "0.35em",
      "text-anchor": place.anchor,
      "font-size": formatNumber(fontSize),
      "font-family": "sans-serif",
      fill: color,
      stroke: "none",
    };
    if (place.rotate !== null && place.rotate !== 0) attrs.transform = `rotate(${formatNumber(place.rotate)} ${x} ${y})`;
    children.push({ key: newElementKey(), kind: "text", attrs, text: label });
  }
  return { ...group, children };
}

/** The frame (screen degrees) an arrow's or line's label offset is measured in. */
export function arrowLabelFrame(group: SceneElement): number {
  if (group.kind !== "group" || group.attrs["data-label-orient"] !== "along") return 0;
  const [x1, y1, x2, y2] = ["data-x1", "data-y1", "data-x2", "data-y2"].map((name) => literalNumber(group.attrs[name]) ?? 0);
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  return readableAngle({ x: (x2 - x1) / length, y: (y2 - y1) / length });
}

/** A plain <line> turned into a labeled line group (or back, when the label is cleared). */
export function setLineLabel(element: SceneElement, label: string): SceneElement {
  if (element.kind === "line") {
    if (label.trim() === "") return element;
    const { x1 = "0", y1 = "0", x2 = "0", y2 = "0", ...style } = element.attrs;
    return rebuildArrow({
      key: element.key,
      kind: "group",
      attrs: {
        "data-nexam-shape": "line",
        "data-heads": "none",
        "data-x1": x1,
        "data-y1": y1,
        "data-x2": x2,
        "data-y2": y2,
        "data-label": label,
        fill: "none",
        ...style,
      },
      children: [],
    });
  }
  if (isLabeledLine(element) && element.kind === "group" && label.trim() === "") {
    // No label left: back to an ordinary <line>, so the file stays as simple as before.
    const { "data-nexam-shape": _shape, "data-heads": _heads, "data-x1": x1, "data-y1": y1, "data-x2": x2, "data-y2": y2, fill: _fill, ...rest } =
      element.attrs;
    const style = Object.fromEntries(Object.entries(rest).filter(([name]) => !name.startsWith("data-label") && name !== "data-font-size"));
    return { key: element.key, kind: "line", attrs: { x1, y1, x2, y2, ...style } };
  }
  if (element.kind === "group" && isArrow(element)) {
    return rebuildArrow({ ...element, attrs: { ...element.attrs, "data-label": label } });
  }
  return element;
}

// ---------------------------------------------------------------------------
// Moving and resizing
// ---------------------------------------------------------------------------

/** Moves an element, or returns null when its position is a variable (or it
 *  is passthrough markup) and so can't be moved by dragging. */
export function translateElement(element: SceneElement, dx: number, dy: number): SceneElement | null {
  if (element.kind === "passthrough") return null;

  if (element.kind === "group") {
    if (isArrow(element)) {
      const moved = shiftAttrs(element.attrs, ["data-x1", "data-x2"], ["data-y1", "data-y2"], dx, dy);
      return moved ? rebuildArrow({ ...element, attrs: moved }) : null;
    }
    if (isControl(element)) return translateControl(element, dx, dy);
    if (isFixedArc(element)) return translateFixedArc(element, dx, dy);
    const placed = translateGroupTransform(element, dx, dy);
    if (placed) return placed;
    return { ...element, attrs: { ...element.attrs, transform: addTranslate(element.attrs.transform, dx, dy) } };
  }

  if (element.kind === "polygon" || element.kind === "polyline") {
    const points = parsePoints(element.attrs.points);
    if (!points) return null;
    return {
      ...element,
      attrs: { ...element.attrs, points: formatPoints(points.map((p) => ({ x: p.x + dx, y: p.y + dy }))) },
    };
  }

  const [xs, ys] = POSITION_ATTRS[element.kind];
  const moved = shiftAttrs(element.attrs, xs, ys, dx, dy);
  return moved ? { ...element, attrs: moved } : null;
}

const POSITION_ATTRS: Record<"line" | "rect" | "circle" | "ellipse" | "text", [string[], string[]]> = {
  line: [
    ["x1", "x2"],
    ["y1", "y2"],
  ],
  rect: [["x"], ["y"]],
  circle: [["cx"], ["cy"]],
  ellipse: [["cx"], ["cy"]],
  text: [["x"], ["y"]],
};

function shiftAttrs(
  attrs: Record<string, string>,
  xs: string[],
  ys: string[],
  dx: number,
  dy: number,
): Record<string, string> | null {
  const next = { ...attrs };
  for (const [names, delta] of [
    [xs, dx],
    [ys, dy],
  ] as const) {
    for (const name of names) {
      // A missing attribute is SVG's default of 0.
      const value = attrs[name] === undefined ? 0 : literalNumber(attrs[name]);
      if (value === null) return null;
      next[name] = formatNumber(value + delta);
    }
  }
  return next;
}

function addTranslate(transform: string | undefined, dx: number, dy: number): string {
  const existing = transform?.match(/^\s*translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)\s*(.*)$/);
  if (existing) {
    const x = Number(existing[1]) + dx;
    const y = Number(existing[2] ?? 0) + dy;
    const rest = existing[3] ? ` ${existing[3]}` : "";
    return `translate(${formatNumber(x)} ${formatNumber(y)})${rest}`;
  }
  return `translate(${formatNumber(dx)} ${formatNumber(dy)})${transform ? ` ${transform}` : ""}`;
}

export interface Handle {
  id: string;
  x: number;
  y: number;
}

/** Drag handles for reshaping the selected element (empty when it can't be reshaped). */
export function getHandles(element: SceneElement): Handle[] {
  if (element.kind === "passthrough" || element.kind === "text") return [];
  if (isFixedArc(element)) return fixedArcHandles(element);
  const n = (name: string) => literalNumber(element.attrs[name]);

  if (isArrow(element)) {
    const [x1, y1, x2, y2] = ["data-x1", "data-y1", "data-x2", "data-y2"].map(n);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return [];
    return [
      { id: "start", x: x1, y: y1 },
      { id: "end", x: x2, y: y2 },
    ];
  }
  switch (element.kind) {
    case "line": {
      const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map(n);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return [];
      return [
        { id: "start", x: x1, y: y1 },
        { id: "end", x: x2, y: y2 },
      ];
    }
    case "rect": {
      const [x, y, w, h] = ["x", "y", "width", "height"].map(n);
      if (x === null || y === null || w === null || h === null) return [];
      return [{ id: "corner", x: x + w, y: y + h }];
    }
    case "circle": {
      const [cx, cy, r] = ["cx", "cy", "r"].map(n);
      if (cx === null || cy === null || r === null) return [];
      return [{ id: "radius", x: cx + r, y: cy }];
    }
    case "ellipse": {
      const [cx, cy, rx, ry] = ["cx", "cy", "rx", "ry"].map(n);
      if (cx === null || cy === null || rx === null || ry === null) return [];
      return [{ id: "corner", x: cx + rx, y: cy + ry }];
    }
    case "polygon":
    case "polyline":
      return (parsePoints(element.attrs.points) ?? []).map((p, index) => ({ id: `p${index}`, ...p }));
    default:
      return [];
  }
}

export function moveHandle(element: SceneElement, handleId: string, to: Point): SceneElement {
  if (element.kind === "passthrough" || element.kind === "text") return element;
  if (isFixedArc(element)) return moveFixedArcHandle(element, handleId, to);
  const set = (attrs: Record<string, string>) => ({ ...element, attrs: { ...element.attrs, ...attrs } });
  const n = (name: string) => literalNumber(element.attrs[name]) ?? 0;

  if (isArrow(element)) {
    const prefix = handleId === "start" ? "1" : "2";
    return rebuildArrow(set({ [`data-x${prefix}`]: formatNumber(to.x), [`data-y${prefix}`]: formatNumber(to.y) }));
  }
  switch (element.kind) {
    case "line": {
      const prefix = handleId === "start" ? "1" : "2";
      return set({ [`x${prefix}`]: formatNumber(to.x), [`y${prefix}`]: formatNumber(to.y) });
    }
    case "rect":
      return set({
        width: formatNumber(Math.max(1, to.x - n("x"))),
        height: formatNumber(Math.max(1, to.y - n("y"))),
      });
    case "circle":
      return set({ r: formatNumber(Math.max(1, Math.hypot(to.x - n("cx"), to.y - n("cy")))) });
    case "ellipse":
      return set({
        rx: formatNumber(Math.max(1, Math.abs(to.x - n("cx")))),
        ry: formatNumber(Math.max(1, Math.abs(to.y - n("cy")))),
      });
    case "polygon":
    case "polyline": {
      const points = parsePoints(element.attrs.points);
      const index = Number(handleId.slice(1));
      if (!points || !points[index]) return element;
      points[index] = to;
      return set({ points: formatPoints(points) });
    }
    default:
      return element;
  }
}

/** A deep copy with fresh editor keys, nudged so it doesn't sit exactly on the original. */
export function duplicateElement(element: SceneElement, offset: number): SceneElement {
  const copy = cloneWithNewKeys(element);
  return translateElement(copy, offset, offset) ?? copy;
}

function cloneWithNewKeys(element: SceneElement): SceneElement {
  if (element.kind === "group") {
    return { ...element, key: newElementKey(), attrs: { ...element.attrs }, children: element.children.map(cloneWithNewKeys) };
  }
  if (element.kind === "passthrough") return { ...element, key: newElementKey() };
  return { ...element, key: newElementKey(), attrs: { ...element.attrs } };
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/** "x,y x,y ..." as points, or null when any coordinate is a placeholder. */
export function parsePoints(value: string | undefined): Point[] | null {
  if (!value || hasPlaceholder(value)) return null;
  const numbers = value.trim().split(/[\s,]+/).map(Number);
  if (numbers.length % 2 !== 0 || numbers.some((number) => !Number.isFinite(number))) return null;
  const points: Point[] = [];
  for (let index = 0; index < numbers.length; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

export function formatPoints(points: Point[]): string {
  return points.map((point) => `${formatNumber(point.x)},${formatNumber(point.y)}`).join(" ");
}

// ---------------------------------------------------------------------------
// Group size (stamps)
// ---------------------------------------------------------------------------

/** A group's uniform scale from its transform (1 when there is none). */
export function groupScale(element: SceneElement): number {
  if (element.kind !== "group") return 1;
  const placed = readGroupTransform(element);
  if (placed) return placed.scale;
  const match = element.attrs.transform?.match(/scale\(\s*(-?[\d.]+)\s*\)/);
  const value = match ? Number(match[1]) : 1;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Sets a group's uniform scale, keeping its translate (it scales from the
 *  group's top-left corner, where a stamp's own drawing starts). */
export function setGroupScale(element: SceneElement, scale: number): SceneElement {
  if (element.kind !== "group" || !(scale > 0)) return element;
  const placed = readGroupTransform(element);
  if (placed) return writeGroupTransform(element, { ...placed, scale });
  const rest = (element.attrs.transform ?? "").replace(/\s*scale\([^)]*\)/g, "").trim();
  const transform = scale === 1 ? rest : `${rest} scale(${formatNumber(scale)})`.trim();
  const attrs = { ...element.attrs };
  if (transform) attrs.transform = transform;
  else delete attrs.transform;
  return { ...element, attrs };
}
