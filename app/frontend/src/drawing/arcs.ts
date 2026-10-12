// The variable arc: a partial circle that starts at a rotation and covers a
// signed sweep (positive counterclockwise, negative clockwise), with an
// optional variable radius, arrowheads and a label inside or outside it.
// See "Variable arc" in docs/svg-editor-plan.md.
//
// {{calc:}} has no trig, so nothing here computes a point on the circle:
// - the arc is a <circle> whose stroke is cut to |sweep| with
//   stroke-dasharray, mirrored to run counterclockwise, and turned to
//   rotation + min(sweep, 0) (a negative sweep covers the same stretch as a
//   positive one starting at its far end);
// - arrowheads and the label sit at 3 o'clock inside groups turned to the
//   end / middle angle, flipped by the sweep's sign so heads point the way
//   the arc runs, and the label turned back upright about itself.
// Only linear arithmetic, min/max and rotate() are needed, so every question
// version renders correctly with the existing backend.
//
// Phase two: a dashed arc, or one closed as a wedge, can't use the dash
// trick, so its outline is a <path> whose points use sin()/cos() (degrees)
// in {{calc:}}. It always runs counterclockwise from rotation + min(sweep, 0)
// to rotation + max(sweep, 0), through the middle, so each half is at most
// 180° and the SVG arc flags are fixed numbers. Solid open arcs keep the
// circle, so arcs saved before stay exactly as they were.

import { arrowHeadSize, formatCoefficient, formatNumber } from "./geometry";
import { readLabelSettings, type LabelSettings } from "./labelLayout";
import { lineTypeFromAttrs } from "./styles";
import { evaluateExpression, expressionError } from "./preview";
import { CALC_FUNCTIONS, literalNumber, newElementKey, type SceneElement } from "./scene";
import { applyStrokeAttrs, type DrawingStyle } from "./styles";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const validName = (name: string | undefined): name is string =>
  !!name && NAME.test(name) && name !== "calc" && !CALC_FUNCTIONS.includes(name);

export type ArcHeads = "none" | "end" | "start" | "both";

interface Point {
  x: number;
  y: number;
}

export interface ArcSettings {
  x: number;
  y: number;
  /** Sweep variable (degrees; positive is counterclockwise). */
  sweep: string;
  rotation: number;
  rotationVariable: string | null;
  radius: number;
  radiusVariable: string | null;
  /** px per unit of the radius variable. */
  radiusScale: number;
  /** A formula in the radius variable for the drawn radius, replacing the scale. */
  radiusExpression: string | null;
  /** Limits on the drawn radius (px), so an odd value stays visible and on the page. */
  radiusMin: number | null;
  radiusMax: number | null;
  heads: ArcHeads;
  /** Closed to the centre as a pie slice, so it can be filled. */
  wedge: boolean;
  label: string;
  labelSide: "inside" | "outside";
  label2: LabelSettings;
  fontSize: number;
}

export function readArcSettings(element: SceneElement): ArcSettings | null {
  if (element.kind !== "group" || element.attrs["data-nexam-control"] !== "variable-arc") return null;
  const attrs = element.attrs;
  const number = (name: string, fallback: number) => literalNumber(attrs[name]) ?? fallback;
  const sweep = attrs["data-variable"];
  if (!validName(sweep)) return null;
  const rotationVariable = attrs["data-rotation-variable"];
  const radiusVariable = attrs["data-radius-variable"];
  const heads = attrs["data-heads"];
  const fontSize = number("data-font-size", 14);
  return {
    x: number("data-x", 0),
    y: number("data-y", 0),
    sweep,
    rotation: number("data-rotation", 0),
    rotationVariable: validName(rotationVariable) && rotationVariable !== sweep ? rotationVariable : null,
    radius: Math.max(1, number("data-radius", 30)),
    radiusVariable: validName(radiusVariable) && radiusVariable !== sweep ? radiusVariable : null,
    radiusScale: number("data-radius-scale", 1),
    radiusExpression: radiusExpressionOf(attrs, radiusVariable),
    radiusMin: literalNumber(attrs["data-radius-min"]),
    radiusMax: literalNumber(attrs["data-radius-max"]),
    heads: heads === "end" || heads === "start" || heads === "both" ? heads : "none",
    wedge: attrs["data-wedge"] === "true",
    label: attrs["data-label"] ?? "",
    labelSide: attrs["data-label-side"] === "outside" ? "outside" : "inside",
    label2: readLabelSettings(attrs, "data-label", fontSize),
    fontSize,
  };
}

function radiusExpressionOf(attrs: Record<string, string>, variable: string | undefined): string | null {
  const expression = attrs["data-radius-expression"]?.trim();
  return expression && validName(variable) && expressionError(expression, [variable]) === null ? expression : null;
}

/** The drawn radius before min/max: the scale or the formula. */
function unclampedRadius(s: ArcSettings): string {
  if (!s.radiusVariable) return formatNumber(s.radius);
  if (s.radiusExpression) return `(${s.radiusExpression})`;
  return s.radiusScale === 1 ? s.radiusVariable : `${formatCoefficient(s.radiusScale)} * ${s.radiusVariable}`;
}

/** The drawn radius as an expression (a number when it's fixed). */
export function radiusTerm(s: ArcSettings): string {
  let r = unclampedRadius(s);
  if (!s.radiusVariable) return r;
  if (s.radiusMax !== null) r = `min(${formatNumber(s.radiusMax)}, ${r})`;
  if (s.radiusMin !== null) r = `max(${formatNumber(s.radiusMin)}, ${r})`;
  return r;
}

/** The radius variable's value that draws `radius` px, ignoring min/max (for
 *  dragging). Null when the radius doesn't change with the value. */
export function radiusValueFor(s: ArcSettings, radius: number): number | null {
  if (!s.radiusVariable) return null;
  const name = s.radiusVariable;
  const at = (value: number) => evaluateExpression(unclampedRadius(s), { [name]: String(value) });
  const slope = (at(10) - at(0)) / 10;
  if (!Number.isFinite(slope) || Math.abs(slope) < 1e-9) return null;
  return Math.round(((radius - at(0)) / slope) * 10) / 10;
}

/** "radius 30 draws as 45 px", for the inspector. */
export function radiusReadout(s: ArcSettings, values: Record<string, string>): { atPreview: number; clamped: boolean } | null {
  if (!s.radiusVariable) return null;
  const atPreview = evaluateExpression(radiusTerm(s), values);
  return { atPreview, clamped: Math.abs(atPreview - evaluateExpression(unclampedRadius(s), values)) > 1e-6 };
}

/** Expression pieces for the arc's moving parts. */
function terms(s: ArcSettings) {
  const r = radiusTerm(s);
  const rotation = s.rotationVariable ?? formatNumber(s.rotation);
  const magnitude = `max(${s.sweep}, -${s.sweep})`;
  return {
    r,
    rotation,
    /** +1 or -1 with the sweep's sign (0 at sweep 0, which hides the heads of an empty arc). */
    sign: `{{calc: ${s.sweep} / max(0.0001, ${magnitude})}}`,
    /** Screen rotation (clockwise) for a counterclockwise math angle. */
    turn: (angle: string) => `{{calc: -(${angle})}}`,
    rFixed: !s.radiusVariable,
    magnitude,
  };
}

/** "cx + r" etc. as an attribute: a number when r is fixed. */
function plus(base: number, r: string, fixed: boolean, extra = 0): string {
  if (fixed) return formatNumber(base + Number(r) + extra);
  const constant = Math.round((base + extra) * 100) / 100;
  return constant === 0 ? `{{calc: ${r}}}` : `{{calc: ${formatNumber(constant)} + ${r}}}`;
}

type Terms = ReturnType<typeof terms>;

/** The arc as a circle with its stroke cut to |sweep|, mirrored so the
 *  stroke runs counterclockwise from 3 o'clock, turned to where it starts. */
function dashedCircle(s: ArcSettings, t: Terms): SceneElement {
  const cx = formatNumber(s.x);
  const cy = formatNumber(s.y);
  const circumference = t.rFixed ? formatNumber(6.283185 * s.radius) : `{{calc: 6.2832 * ${t.r}}}`;
  const arcLength = t.rFixed
    ? `{{calc: ${formatCoefficient(0.0174533 * s.radius)} * ${t.magnitude}}}`
    : `{{calc: 0.0174533 * ${t.r} * ${t.magnitude}}}`;
  return {
    key: newElementKey(),
    kind: "group",
    attrs: { transform: `rotate(${t.turn(`${t.rotation} + min(${s.sweep}, 0)`)} ${cx} ${cy})` },
    children: [
      {
        key: newElementKey(),
        kind: "circle",
        attrs: {
          cx,
          cy,
          r: t.rFixed ? formatNumber(s.radius) : `{{calc: ${t.r}}}`,
          fill: "none",
          "stroke-dasharray": `${arcLength} ${circumference}`,
          transform: `translate(0 ${formatNumber(2 * s.y)}) scale(1 -1)`,
        },
      },
    ],
  };
}

/** The arc as a <path> through its middle (see the note at the top), open
 *  or closed to the centre as a wedge. Takes the group's dash and fill. */
export function arcPathData(s: ArcSettings): string {
  const t = terms(s);
  const r = t.rFixed ? formatNumber(s.radius) : `(${t.r})`;
  const point = (angle: string) =>
    `{{calc: ${formatNumber(s.x)} + ${r} * cos(${angle})}} {{calc: ${formatNumber(s.y)} - ${r} * sin(${angle})}}`;
  const radius = t.rFixed ? formatNumber(s.radius) : `{{calc: ${t.r}}}`;
  const arcTo = (angle: string) => `A ${radius} ${radius} 0 0 0 ${point(angle)}`;
  const from = point(`${t.rotation} + min(${s.sweep}, 0)`);
  const through = `${arcTo(`${t.rotation} + ${s.sweep} / 2`)} ${arcTo(`${t.rotation} + max(${s.sweep}, 0)`)}`;
  return s.wedge ? `M ${formatNumber(s.x)} ${formatNumber(s.y)} L ${from} ${through} Z` : `M ${from} ${through}`;
}

function arcPath(s: ArcSettings): SceneElement {
  const d = arcPathData(s);
  return {
    key: newElementKey(),
    kind: "passthrough",
    tagName: "path",
    // An open arc never takes a fill (it would shade the chord); a wedge does.
    markup: s.wedge ? `<path d="${d}"/>` : `<path d="${d}" fill="none"/>`,
  };
}

export function arcChildren(element: SceneElement & { kind: "group" }, s: ArcSettings): SceneElement[] {
  const t = terms(s);
  const cx = formatNumber(s.x);
  const cy = formatNumber(s.y);
  const weight = literalNumber(element.attrs["stroke-width"]) ?? 1.5;
  const color = element.attrs.stroke && element.attrs.stroke !== "none" ? element.attrs.stroke : "#000000";

  const children: SceneElement[] = [
    s.wedge || lineTypeFromAttrs(element.attrs) !== "solid" ? arcPath(s) : dashedCircle(s, t),
  ];

  // Arrowheads at 3 o'clock in a group turned to the end (or start), pointing
  // up the screen (counterclockwise there), flipped by the sweep's sign.
  const { length: headLength, halfWidth } = arrowHeadSize(weight);
  const head = (angle: string, flip: string): SceneElement => ({
    key: newElementKey(),
    kind: "group",
    attrs: { transform: `rotate(${t.turn(angle)} ${cx} ${cy}) translate(${plus(s.x, t.r, t.rFixed)} ${cy}) scale(1 ${flip})` },
    children: [
      {
        key: newElementKey(),
        kind: "polygon",
        attrs: {
          points: `0,0 ${formatNumber(-halfWidth)},${formatNumber(headLength)} ${formatNumber(halfWidth)},${formatNumber(headLength)}`,
          fill: color,
          stroke: "none",
        },
      },
    ],
  });
  if (s.heads === "end" || s.heads === "both") children.push(head(`${t.rotation} + ${s.sweep}`, t.sign));
  if (s.heads === "start" || s.heads === "both") {
    children.push(head(t.rotation, `{{calc: -${s.sweep} / max(0.0001, ${t.magnitude})}}`));
  }

  // The label at the middle of the arc, inside or outside it, kept upright.
  if (s.label.trim() !== "") {
    const settings = s.label2;
    const away = settings.gap + s.fontSize * 0.6;
    const offset = (s.labelSide === "inside" ? -away : away) + settings.dx;
    const x = plus(s.x, t.r, t.rFixed, offset);
    const y = formatNumber(s.y + settings.dy);
    const middle = `${t.rotation} + ${s.sweep} / 2`;
    const text: SceneElement = {
      key: newElementKey(),
      kind: "text",
      attrs: {
        x,
        y,
        dy: "0.35em",
        "text-anchor": "middle",
        "font-size": formatNumber(s.fontSize),
        "font-family": "sans-serif",
        fill: color,
        stroke: "none",
        // Upright: undo the group's turn about the label. Along: turned to the
        // arc's direction there (may read upside down on part of the circle).
        transform: settings.orient === "along" ? `rotate(-90 ${x} ${y})` : `rotate({{calc: ${middle}}} ${x} ${y})`,
      },
      text: s.label,
    };
    children.push({
      key: newElementKey(),
      kind: "group",
      attrs: { transform: `rotate(${t.turn(middle)} ${cx} ${cy})` },
      children: [text],
    });
  }
  return children;
}

// ---------------------------------------------------------------------------
// Positions for handles (numbers, using preview values)
// ---------------------------------------------------------------------------

function valueOf(values: Record<string, string>, name: string | null, fallback: number): number {
  if (!name) return fallback;
  const value = Number(values[name]);
  return Number.isFinite(value) ? value : 0;
}

export function arcRadiusAt(s: ArcSettings, values: Record<string, string>): number {
  return s.radiusVariable ? evaluateExpression(terms(s).r, values) : s.radius;
}

function pointAt(s: ArcSettings, radius: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  // Counterclockwise from +x, with the screen's y pointing down.
  return { x: s.x + radius * Math.cos(radians), y: s.y - radius * Math.sin(radians) };
}

export function arcEndPoint(s: ArcSettings, values: Record<string, string>): Point {
  const rotation = valueOf(values, s.rotationVariable, s.rotation);
  return pointAt(s, arcRadiusAt(s, values), rotation + valueOf(values, s.sweep, 0));
}

export function arcStartPoint(s: ArcSettings, values: Record<string, string>): Point {
  return pointAt(s, arcRadiusAt(s, values), valueOf(values, s.rotationVariable, s.rotation));
}

function angleTo(s: ArcSettings, to: Point): number {
  return (Math.atan2(-(to.y - s.y), to.x - s.x) * 180) / Math.PI;
}

/** Dragging the end: the sweep follows the pointer round the circle, staying
 *  continuous (so it can pass 180° or go negative), in 5° steps. */
export function dragArcEnd(s: ArcSettings, to: Point, values: Record<string, string>): Record<string, string> {
  const rotation = valueOf(values, s.rotationVariable, s.rotation);
  const previous = valueOf(values, s.sweep, 0);
  let sweep = angleTo(s, to) - rotation;
  // Of sweep + 360k, the one nearest the previous sweep, within one turn either way.
  sweep += 360 * Math.round((previous - sweep) / 360);
  sweep = Math.max(-360, Math.min(360, Math.round(sweep / 5) * 5));
  return { [s.sweep]: String(sweep) };
}

/** Dragging the start: sets the radius, and the rotation in 15° steps (or
 *  their preview values when they are variables). */
export function dragArcStart(
  s: ArcSettings,
  to: Point,
): { attrs: Record<string, string>; preview: Record<string, string> } {
  const attrs: Record<string, string> = {};
  const preview: Record<string, string> = {};
  let rotation = Math.round(angleTo(s, to) / 15) * 15;
  if (rotation < 0) rotation += 360;
  if (s.rotationVariable) preview[s.rotationVariable] = String(rotation);
  else attrs["data-rotation"] = String(rotation);
  const distance = Math.max(4, Math.hypot(to.x - s.x, to.y - s.y));
  if (s.radiusVariable) {
    const value = radiusValueFor(s, distance);
    if (value !== null) preview[s.radiusVariable] = formatNumber(value);
  }
  else attrs["data-radius"] = formatNumber(Math.round(distance));
  return { attrs, preview };
}

/** The frame (screen degrees) an arc label's dragged offset is measured in. */
export function arcLabelFrame(s: ArcSettings, values: Record<string, string>): number {
  const rotation = valueOf(values, s.rotationVariable, s.rotation);
  return -(rotation + valueOf(values, s.sweep, 0) / 2);
}

/** A new arc from a drag: the drag starts at the centre; its end sets the
 *  radius and where the arc starts. */
export function createArcFromDrag(
  start: Point,
  end: Point,
  style: DrawingStyle,
  sweepName: string,
): { element: SceneElement; sweep: number } | null {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < 6) return null;
  let rotation = Math.round(((Math.atan2(-(end.y - start.y), end.x - start.x) * 180) / Math.PI) / 15) * 15;
  if (rotation < 0) rotation += 360;
  const attrs = applyStrokeAttrs(
    {
      "data-nexam-control": "variable-arc",
      "data-variable": sweepName,
      "data-x": formatNumber(start.x),
      "data-y": formatNumber(start.y),
      "data-rotation": String(rotation),
      "data-radius": formatNumber(Math.round(distance)),
      "data-heads": "none",
      "data-angle-convention": "ccw",
      fill: "none",
    },
    style,
  );
  const group: SceneElement = { key: newElementKey(), kind: "group", attrs, children: [] };
  const settings = readArcSettings(group);
  return settings ? { element: { ...group, children: arcChildren(group as SceneElement & { kind: "group" }, settings) }, sweep: 60 } : null;
}

// ---------------------------------------------------------------------------
// The fixed arc (Shapes tools): known angles, so a real SVG arc path
// ---------------------------------------------------------------------------
//
// <g data-nexam-shape="arc" data-x data-y data-radius data-rotation data-sweep>
// holding a <path> (kept as passthrough markup, since the editor doesn't edit
// paths directly) plus optional arrowheads and a label, all regenerated from
// those settings. Because the angles are numbers, the arc can be dashed and
// can be closed as a wedge (pie slice) and filled. "Make sweep a variable"
// turns it into a variable arc.

export function isFixedArc(element: SceneElement): boolean {
  return element.kind === "group" && element.attrs["data-nexam-shape"] === "arc";
}

export interface FixedArc {
  x: number;
  y: number;
  radius: number;
  rotation: number;
  sweep: number;
  heads: ArcHeads;
  wedge: boolean;
}

export function readFixedArc(element: SceneElement): FixedArc | null {
  if (!isFixedArc(element) || element.kind !== "group") return null;
  const n = (name: string, fallback: number) => literalNumber(element.attrs[name]) ?? fallback;
  const heads = element.attrs["data-heads"];
  // A full turn can't be drawn as one SVG arc; stop just short of it.
  const sweep = Math.max(-359.9, Math.min(359.9, n("data-sweep", 90)));
  return {
    x: n("data-x", 0),
    y: n("data-y", 0),
    radius: Math.max(1, n("data-radius", 30)),
    rotation: n("data-rotation", 0),
    sweep,
    heads: heads === "end" || heads === "start" || heads === "both" ? heads : "none",
    wedge: element.attrs["data-wedge"] === "true",
  };
}

function fixedPoint(arc: FixedArc, degrees: number, radius = arc.radius): Point {
  const radians = (degrees * Math.PI) / 180;
  return { x: arc.x + radius * Math.cos(radians), y: arc.y - radius * Math.sin(radians) };
}

export function fixedArcPath(arc: FixedArc): string {
  const p0 = fixedPoint(arc, arc.rotation);
  const p1 = fixedPoint(arc, arc.rotation + arc.sweep);
  const large = Math.abs(arc.sweep) > 180 ? 1 : 0;
  // SVG's sweep flag 1 runs clockwise on screen; counterclockwise (positive) is 0.
  const direction = arc.sweep > 0 ? 0 : 1;
  const r = formatNumber(arc.radius);
  const arcTo = `A ${r} ${r} 0 ${large} ${direction} ${formatNumber(p1.x)} ${formatNumber(p1.y)}`;
  return arc.wedge
    ? `M ${formatNumber(arc.x)} ${formatNumber(arc.y)} L ${formatNumber(p0.x)} ${formatNumber(p0.y)} ${arcTo} Z`
    : `M ${formatNumber(p0.x)} ${formatNumber(p0.y)} ${arcTo}`;
}

export function rebuildFixedArc(element: SceneElement): SceneElement {
  const arc = readFixedArc(element);
  if (!arc || element.kind !== "group") return element;
  const attrs = element.attrs;
  const weight = literalNumber(attrs["stroke-width"]) ?? 1.5;
  const color = attrs.stroke && attrs.stroke !== "none" ? attrs.stroke : "#000000";
  const children: SceneElement[] = [
    {
      key: newElementKey(),
      kind: "passthrough",
      tagName: "path",
      // An open arc never takes a fill (it would shade the chord); a wedge does.
      markup: arc.wedge ? `<path d="${fixedArcPath(arc)}"/>` : `<path d="${fixedArcPath(arc)}" fill="none"/>`,
    },
  ];

  // Arrowheads along the tangent, pointing the way the arc runs.
  const { length: headLength, halfWidth } = arrowHeadSize(weight);
  const direction = Math.sign(arc.sweep) || 1;
  const head = (degrees: number, forward: number): SceneElement => {
    const radians = (degrees * Math.PI) / 180;
    const tip = fixedPoint(arc, degrees);
    // d/dθ of (cos θ, -sin θ): the counterclockwise tangent on screen.
    const ux = -Math.sin(radians) * forward;
    const uy = -Math.cos(radians) * forward;
    const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
    const corners = [tip, { x: base.x - uy * halfWidth, y: base.y + ux * halfWidth }, { x: base.x + uy * halfWidth, y: base.y - ux * halfWidth }];
    return {
      key: newElementKey(),
      kind: "polygon",
      attrs: {
        points: corners.map((point) => `${formatNumber(point.x)},${formatNumber(point.y)}`).join(" "),
        fill: color,
        stroke: "none",
        "stroke-dasharray": "none",
      },
    };
  };
  if (arc.heads === "end" || arc.heads === "both") children.push(head(arc.rotation + arc.sweep, direction));
  if (arc.heads === "start" || arc.heads === "both") children.push(head(arc.rotation, -direction));

  const label = attrs["data-label"] ?? "";
  if (label.trim() !== "") {
    const fontSize = literalNumber(attrs["data-font-size"]) ?? 14;
    const settings = readLabelSettings(attrs, "data-label", fontSize);
    const outside = attrs["data-label-side"] === "outside";
    const middle = arc.rotation + arc.sweep / 2;
    const away = settings.gap + fontSize * 0.6;
    const point = fixedPoint(arc, middle, arc.radius + (outside ? away : -away));
    const x = formatNumber(point.x + settings.dx);
    const y = formatNumber(point.y + settings.dy);
    const textAttrs: Record<string, string> = {
      x,
      y,
      dy: "0.35em",
      "text-anchor": "middle",
      "font-size": formatNumber(fontSize),
      "font-family": "sans-serif",
      fill: color,
      stroke: "none",
    };
    if (settings.orient === "along") {
      // The tangent there, turned to read the right way up.
      let degrees = -middle - 90;
      degrees = ((degrees % 360) + 360) % 360;
      if (degrees > 90 && degrees < 270) degrees -= 180;
      if (degrees >= 270) degrees -= 360;
      if (Math.abs(degrees) > 0.01) textAttrs.transform = `rotate(${formatNumber(degrees)} ${x} ${y})`;
    }
    children.push({ key: newElementKey(), kind: "text", attrs: textAttrs, text: label });
  }
  return { ...element, children };
}

export function createFixedArcFromDrag(start: Point, end: Point, style: DrawingStyle): SceneElement | null {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < 6) return null;
  let rotation = Math.round(((Math.atan2(-(end.y - start.y), end.x - start.x) * 180) / Math.PI) / 15) * 15;
  if (rotation < 0) rotation += 360;
  return rebuildFixedArc({
    key: newElementKey(),
    kind: "group",
    attrs: applyStrokeAttrs(
      {
        "data-nexam-shape": "arc",
        "data-x": formatNumber(start.x),
        "data-y": formatNumber(start.y),
        "data-radius": formatNumber(Math.round(distance)),
        "data-rotation": String(rotation),
        "data-sweep": "90",
        "data-heads": "none",
        fill: style.fill,
      },
      style,
    ),
    children: [],
  });
}

export function fixedArcHandles(element: SceneElement): { id: string; x: number; y: number }[] {
  const arc = readFixedArc(element);
  if (!arc) return [];
  return [
    { id: "start", ...fixedPoint(arc, arc.rotation) },
    { id: "end", ...fixedPoint(arc, arc.rotation + arc.sweep) },
  ];
}

/** Start handle: radius and rotation (15° steps). End handle: the sweep,
 *  continuous round the circle in 5° steps. */
export function moveFixedArcHandle(element: SceneElement, handleId: string, to: Point): SceneElement {
  const arc = readFixedArc(element);
  if (!arc || element.kind !== "group") return element;
  const angle = (Math.atan2(-(to.y - arc.y), to.x - arc.x) * 180) / Math.PI;
  const attrs = { ...element.attrs };
  if (handleId === "start") {
    let rotation = Math.round(angle / 15) * 15;
    if (rotation < 0) rotation += 360;
    attrs["data-rotation"] = String(rotation);
    attrs["data-radius"] = formatNumber(Math.max(4, Math.round(Math.hypot(to.x - arc.x, to.y - arc.y))));
  } else {
    let sweep = angle - arc.rotation;
    sweep += 360 * Math.round((arc.sweep - sweep) / 360);
    attrs["data-sweep"] = String(Math.max(-355, Math.min(355, Math.round(sweep / 5) * 5)) || 5);
  }
  return rebuildFixedArc({ ...element, attrs });
}

export function translateFixedArc(element: SceneElement, dx: number, dy: number): SceneElement | null {
  const arc = readFixedArc(element);
  if (!arc || element.kind !== "group") return null;
  return rebuildFixedArc({
    ...element,
    attrs: { ...element.attrs, "data-x": formatNumber(arc.x + dx), "data-y": formatNumber(arc.y + dy) },
  });
}

/** "Make sweep a variable": the same arc as a variable arc, previewing at its current sweep. */
export function fixedArcToVariable(element: SceneElement, sweepName: string): { element: SceneElement; sweep: number } | null {
  const arc = readFixedArc(element);
  if (!arc || element.kind !== "group") return null;
  // The dash and wedge carry over: a dashed or closed variable arc is drawn as a path.
  const { "data-nexam-shape": _shape, "data-sweep": _sweep, ...rest } = element.attrs;
  const group: SceneElement = {
    key: element.key,
    kind: "group",
    attrs: {
      "data-nexam-control": "variable-arc",
      "data-variable": sweepName,
      "data-angle-convention": "ccw",
      ...rest,
      ...(arc.wedge ? {} : { fill: "none" }),
    },
    children: [],
  };
  const settings = readArcSettings(group);
  return settings ? { element: { ...group, children: arcChildren(group as SceneElement & { kind: "group" }, settings) }, sweep: arc.sweep } : null;
}
