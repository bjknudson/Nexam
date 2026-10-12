// Variable controls: a variable-length arrow and a variable-length bar.
// See "Variable controls" in docs/svg-editor-plan.md.
//
// A control is saved as ordinary SVG: a <g data-nexam-control="..."> whose
// settings live in data-* attributes, holding shapes whose coordinates are
// {{calc: ...}} expressions in one variable. Any SVG viewer can draw the file,
// the backend renderer fills it per question from svg_variables, and the
// editor rebuilds the children from the data-* settings whenever they change.
//
// Length: the drawn length L is `scale * v` by default, or a teacher's
// formula in v (data-length-expression), optionally kept between a minimum
// and maximum (min()/max()). Every coordinate is `a + b * L`.
//
// Angles are counterclockwise from the positive x-axis (90° points up) for
// controls marked data-angle-convention="ccw", which all new ones are.
// Unmarked controls were saved with the old clockwise convention and keep
// drawing exactly as before until converted. A fixed angle is baked in as
// cos/sin coefficients; a variable angle can't be (the renderer has no trig),
// so that arrow is drawn pointing right inside a rotate(...) group, with its
// label turned back upright by the opposite rotation.

import { arcChildren, arcEndPoint, arcLabelFrame, createArcFromDrag, dragArcEnd, readArcSettings } from "./arcs";
import { arrowHeadSize, formatCoefficient, formatNumber, type Linear } from "./geometry";
import { labelFraction, placeLabel, readLabelSettings, readableAngle, type LabelSettings } from "./labelLayout";
import { evaluateExpression, expressionError } from "./preview";
import { CALC_FUNCTIONS, literalNumber, newElementKey, type SceneElement } from "./scene";
import { applyStrokeAttrs, type DrawingStyle } from "./styles";

export type ControlKind = "variable-arrow" | "variable-bar" | "variable-arc";
export type BarDirection = "up" | "down" | "left" | "right";
export type ControlHeads = "end" | "start" | "both";

interface Point {
  x: number;
  y: number;
}

/** Shorter than this, an arrow or bar is hard to see on paper. */
export const MIN_VISIBLE_LENGTH = 6;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name) && name !== "calc" && !CALC_FUNCTIONS.includes(name);
}

export function controlKind(element: SceneElement): ControlKind | null {
  if (element.kind !== "group") return null;
  const kind = element.attrs["data-nexam-control"];
  return kind === "variable-arrow" || kind === "variable-bar" || kind === "variable-arc" ? kind : null;
}

export function isControl(element: SceneElement): boolean {
  return controlKind(element) !== null;
}

export function controlVariable(element: SceneElement): string | null {
  return element.kind === "group" ? element.attrs["data-variable"] ?? null : null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface ControlSettings {
  variable: string;
  x: number;
  y: number;
  scale: number;
  /** A formula in `variable` for the drawn length, replacing `scale`. */
  lengthExpression: string | null;
  minLength: number | null;
  maxLength: number | null;
  scaleGroup: string | null;
  // variable-arrow
  angle: number;
  /** Set when the direction is a variable too; `angle` is then its preview default. */
  angleVariable: string | null;
  /** Counterclockwise angles (the standard convention); false for files saved before it. */
  ccw: boolean;
  heads: ControlHeads;
  label: string;
  labelSettings: LabelSettings;
  fontSize: number;
  // variable-bar
  direction: BarDirection;
  thickness: number;
}

function readSettings(element: SceneElement): ControlSettings | null {
  if (element.kind !== "group") return null;
  const attrs = element.attrs;
  const number = (name: string, fallback: number) => literalNumber(attrs[name]) ?? fallback;
  const optional = (name: string) => literalNumber(attrs[name]);
  const variable = attrs["data-variable"];
  if (!variable || !isValidVariableName(variable)) return null;
  const direction = attrs["data-direction"];
  const heads = attrs["data-heads"];
  const angleVariable = attrs["data-angle-variable"];
  const expression = attrs["data-length-expression"]?.trim();
  return {
    variable,
    x: number("data-x", 0),
    y: number("data-y", 0),
    scale: number("data-scale", 1),
    lengthExpression: expression && expressionError(expression, [variable]) === null ? expression : null,
    minLength: optional("data-min-length"),
    maxLength: optional("data-max-length"),
    scaleGroup: attrs["data-scale-group"]?.trim() || null,
    angle: number("data-angle", 0),
    angleVariable:
      angleVariable && isValidVariableName(angleVariable) && angleVariable !== variable ? angleVariable : null,
    ccw: attrs["data-angle-convention"] === "ccw",
    heads: heads === "start" || heads === "both" ? heads : "end",
    label: attrs["data-label"] ?? "",
    labelSettings: readLabelSettings(attrs, "data-label", number("data-font-size", 14)),
    fontSize: number("data-font-size", 14),
    direction: direction === "down" || direction === "left" || direction === "right" ? direction : "up",
    thickness: number("data-thickness", 20),
  };
}

// ---------------------------------------------------------------------------
// Length
// ---------------------------------------------------------------------------

/** The drawn length as either a plain multiple of the variable (which folds
 *  into each coordinate's coefficient) or a formula to wrap in parentheses. */
type LengthTerm = { scaled: number } | { text: string };

function lengthTerm(s: ControlSettings): LengthTerm {
  if (!s.lengthExpression && s.minLength === null && s.maxLength === null) return { scaled: s.scale };
  let text = s.lengthExpression
    ? `(${s.lengthExpression})`
    : s.scale === 1
      ? s.variable
      : `${formatCoefficient(s.scale)} * ${s.variable}`;
  if (s.maxLength !== null) text = `min(${formatNumber(s.maxLength)}, ${text})`;
  if (s.minLength !== null) text = `max(${formatNumber(s.minLength)}, ${text})`;
  return { text };
}

/** How long the control draws for a value of its variable. */
function lengthAt(s: ControlSettings, value: number): number {
  const term = lengthTerm(s);
  if ("scaled" in term) return term.scaled * value;
  return evaluateExpression(term.text, { [s.variable]: String(value) });
}

/** The value that draws `length` long, ignoring min/max (used when dragging
 *  a tip). Null when the length doesn't change with the value. */
function valueForLength(s: ControlSettings, length: number): number | null {
  const unclamped = (value: number) =>
    s.lengthExpression ? evaluateExpression(s.lengthExpression, { [s.variable]: String(value) }) : s.scale * value;
  const atZero = unclamped(0);
  const slope = (unclamped(10) - atZero) / 10;
  if (!Number.isFinite(slope) || Math.abs(slope) < 1e-9) return null;
  return Math.round(((length - atZero) / slope) * 10) / 10;
}

export interface LengthReadout {
  /** px drawn per unit of the variable, when the length is a plain multiple. */
  perUnit: number | null;
  /** px drawn at the preview value. */
  atPreview: number;
  clamped: boolean;
}

/** "1 unit draws as 0.1 px · 800 draws as 80 px", for the inspector. */
export function lengthReadout(element: SceneElement, value: number): LengthReadout | null {
  const s = readSettings(element);
  if (!s) return null;
  const unclamped = s.lengthExpression ? evaluateExpression(s.lengthExpression, { [s.variable]: String(value) }) : s.scale * value;
  const atPreview = lengthAt(s, value);
  return {
    perUnit: s.lengthExpression ? null : s.scale,
    atPreview,
    clamped: Math.abs(atPreview - unclamped) > 1e-6,
  };
}

export interface RangeFit {
  attrs: Record<string, string>;
  /** Removed when applying the fit. */
  remove: string[];
  warning: string | null;
}

/** Fill in the length settings from the range of values a question will use
 *  and the lengths wanted at each end. "proportional" keeps one scale factor
 *  (twice the value draws twice as long); "linear" maps the range exactly. */
export function fitToRange(
  variable: string,
  values: { min: number; max: number },
  lengths: { min: number; max: number },
  mode: "proportional" | "linear",
): RangeFit | null {
  if (!(values.max > values.min) || !(lengths.max > 0)) return null;
  if (mode === "proportional") {
    const largest = Math.max(Math.abs(values.min), Math.abs(values.max));
    if (largest === 0) return null;
    const scale = lengths.max / largest;
    const smallest = Math.min(Math.abs(values.min), Math.abs(values.max)) * scale;
    return {
      attrs: { "data-scale": formatCoefficient(scale) },
      remove: ["data-length-expression"],
      warning:
        smallest < MIN_VISIBLE_LENGTH
          ? `${formatNumber(values.min)} would draw only ${formatNumber(smallest)} px long. Consider a minimum length, or a linear fit.`
          : null,
    };
  }
  if (!(lengths.max > lengths.min)) return null;
  const slope = (lengths.max - lengths.min) / (values.max - values.min);
  return {
    attrs: {
      "data-length-expression": `${formatNumber(lengths.min)} + (${variable} - ${formatNumber(values.min)}) * ${formatCoefficient(slope)}`,
    },
    remove: [],
    warning: "Not proportional: a value twice as large won't draw twice as long.",
  };
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreatedControl {
  element: SceneElement;
  variable: string;
  /** The variable value the drag implies, for the editor's preview. */
  value: number;
}

/** A control from a drag: the drag start is the anchor, the end is where the
 *  tip (or bar end) is at the preview value. Arrow angles snap to 15°. */
export function createControlFromDrag(
  kind: ControlKind,
  start: Point,
  end: Point,
  style: DrawingStyle,
  usedNames: string[],
  barThickness: number,
): CreatedControl | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) < 4) return null;

  if (kind === "variable-arc") {
    const variable = uniqueVariableName("arc_angle", usedNames);
    const created = createArcFromDrag(start, end, style, variable);
    return created ? { element: created.element, variable, value: created.sweep } : null;
  }

  if (kind === "variable-arrow") {
    const variable = uniqueVariableName("arrow_length", usedNames);
    const element = rebuildControl({
      key: newElementKey(),
      kind: "group",
      attrs: applyStrokeAttrs(
        {
          "data-nexam-control": "variable-arrow",
          "data-variable": variable,
          "data-x": formatNumber(start.x),
          "data-y": formatNumber(start.y),
          "data-angle": String(dragAngle(dx, dy, true)),
          "data-angle-convention": "ccw",
          "data-scale": "1",
          "data-heads": "end",
          fill: "none",
        },
        style,
      ),
      children: [],
    });
    return { element, variable, value: Math.round(Math.hypot(dx, dy)) };
  }

  const direction: BarDirection =
    Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? "up" : "down") : dx < 0 ? "left" : "right";
  const variable = uniqueVariableName("bar_length", usedNames);
  const element = rebuildControl({
    key: newElementKey(),
    kind: "group",
    attrs: applyStrokeAttrs(
      {
        "data-nexam-control": "variable-bar",
        "data-variable": variable,
        "data-x": formatNumber(start.x),
        "data-y": formatNumber(start.y),
        "data-direction": direction,
        "data-scale": "1",
        "data-thickness": formatNumber(barThickness),
        fill: style.fill === "none" ? "#d9d9d9" : style.fill,
      },
      style,
    ),
    children: [],
  });
  const length = direction === "up" || direction === "down" ? Math.abs(dy) : Math.abs(dx);
  return { element, variable, value: Math.round(length) };
}

export function uniqueVariableName(base: string, usedNames: string[]): string {
  if (!usedNames.includes(base)) return base;
  let index = 2;
  while (usedNames.includes(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

// ---------------------------------------------------------------------------
// Rebuilding the children
// ---------------------------------------------------------------------------

export function rebuildControl(element: SceneElement): SceneElement {
  const kind = controlKind(element);
  if (kind === "variable-arc" && element.kind === "group") {
    const arc = readArcSettings(element);
    return arc ? { ...element, children: arcChildren(element, arc) } : element;
  }
  const settings = readSettings(element);
  if (!kind || !settings || element.kind !== "group") return element;
  const children = kind === "variable-arrow" ? arrowChildren(element, settings) : barChildren(settings);
  return { ...element, children };
}

/** The angle in screen terms (clockwise, because SVG's y axis points down). */
function screenAngle(s: ControlSettings, angle: number): number {
  return s.ccw ? -angle : angle;
}

function arrowChildren(element: SceneElement & { kind: "group" }, s: ControlSettings): SceneElement[] {
  if (s.angleVariable) return rotatedArrowChildren(element, s, s.angleVariable);
  const weight = literalNumber(element.attrs["stroke-width"]) ?? 1.5;
  const color = element.attrs.stroke && element.attrs.stroke !== "none" ? element.attrs.stroke : "#000000";
  const { length: headLength, halfWidth } = arrowHeadSize(weight);
  const radians = (screenAngle(s, s.angle) * Math.PI) / 180;
  const ux = cleanTrig(Math.cos(radians));
  const uy = cleanTrig(Math.sin(radians));
  const nx = -uy;
  const ny = ux;
  const term = lengthTerm(s);
  const at = (value: Linear) => coordinate(value, term, s.variable);

  // tip = anchor + u * L
  const tipX: Linear = { a: s.x, b: ux };
  const tipY: Linear = { a: s.y, b: uy };
  const offset = (base: Linear, by: number): Linear => ({ a: base.a + by, b: base.b });
  const fixed = (value: number): Linear => ({ a: value, b: 0 });

  const endHead = s.heads === "end" || s.heads === "both";
  const startHead = s.heads === "start" || s.heads === "both";
  const inset = headLength * 0.8;

  const children: SceneElement[] = [
    {
      key: newElementKey(),
      kind: "line",
      attrs: {
        x1: at(fixed(startHead ? s.x + ux * inset : s.x)),
        y1: at(fixed(startHead ? s.y + uy * inset : s.y)),
        x2: at(endHead ? offset(tipX, -ux * inset) : tipX),
        y2: at(endHead ? offset(tipY, -uy * inset) : tipY),
      },
    },
  ];

  const headPoints = (tipXs: Linear, tipYs: Linear, direction: 1 | -1) => {
    const back = -direction * headLength;
    const corners: [Linear, Linear][] = [
      [tipXs, tipYs],
      [offset(tipXs, ux * back + nx * halfWidth), offset(tipYs, uy * back + ny * halfWidth)],
      [offset(tipXs, ux * back - nx * halfWidth), offset(tipYs, uy * back - ny * halfWidth)],
    ];
    return corners.map(([x, y]) => `${at(x)},${at(y)}`).join(" ");
  };

  if (endHead) {
    children.push({
      key: newElementKey(),
      kind: "polygon",
      attrs: { points: headPoints(tipX, tipY, 1), fill: color, stroke: "none" },
    });
  }
  if (startHead) {
    children.push({
      key: newElementKey(),
      kind: "polygon",
      attrs: { points: headPoints(fixed(s.x), fixed(s.y), -1), fill: color, stroke: "none" },
    });
  }

  if (s.label.trim() !== "") {
    // At the tail, middle or tip of the arrow: t * L along it.
    const t = labelFraction(s.labelSettings.at);
    const place = placeLabel({ x: { a: s.x, b: ux * t }, y: { a: s.y, b: uy * t } }, { x: ux, y: uy }, s.labelSettings);
    children.push(labelText(s, color, at(place.x), at(place.y), place.anchor, place.rotate === null ? null : String(place.rotate)));
  }
  return children;
}

/** A variable-angle arrow: built pointing right (0°) from the tail, then
 *  rotated about the tail by the angle variable. */
function rotatedArrowChildren(
  element: SceneElement & { kind: "group" },
  s: ControlSettings,
  angleVariable: string,
): SceneElement[] {
  const weight = literalNumber(element.attrs["stroke-width"]) ?? 1.5;
  const color = element.attrs.stroke && element.attrs.stroke !== "none" ? element.attrs.stroke : "#000000";
  const { length: headLength, halfWidth } = arrowHeadSize(weight);
  const term = lengthTerm(s);
  const tipX: Linear = { a: s.x, b: 1 };
  const at = (base: Linear, by = 0) => coordinate({ a: base.a + by, b: base.b }, term, s.variable);
  const endHead = s.heads === "end" || s.heads === "both";
  const startHead = s.heads === "start" || s.heads === "both";
  const inset = headLength * 0.8;
  const y = formatNumber(s.y);
  // SVG rotates clockwise, so a counterclockwise angle is turned by its negative.
  const turn = s.ccw ? `{{calc: -${angleVariable}}}` : `{{${angleVariable}}}`;
  const unturn = s.ccw ? `{{${angleVariable}}}` : `{{calc: -${angleVariable}}}`;

  const rotated: SceneElement[] = [
    {
      key: newElementKey(),
      kind: "line",
      attrs: {
        x1: formatNumber(startHead ? s.x + inset : s.x),
        y1: y,
        x2: endHead ? at(tipX, -inset) : at(tipX),
        y2: y,
      },
    },
  ];
  if (endHead) {
    rotated.push({
      key: newElementKey(),
      kind: "polygon",
      attrs: {
        points: [
          `${at(tipX)},${y}`,
          `${at(tipX, -headLength)},${formatNumber(s.y + halfWidth)}`,
          `${at(tipX, -headLength)},${formatNumber(s.y - halfWidth)}`,
        ].join(" "),
        fill: color,
        stroke: "none",
      },
    });
  }
  if (startHead) {
    rotated.push({
      key: newElementKey(),
      kind: "polygon",
      attrs: {
        points: [
          `${formatNumber(s.x)},${y}`,
          `${formatNumber(s.x + headLength)},${formatNumber(s.y + halfWidth)}`,
          `${formatNumber(s.x + headLength)},${formatNumber(s.y - halfWidth)}`,
        ].join(" "),
        fill: color,
        stroke: "none",
      },
    });
  }
  if (s.label.trim() !== "") {
    // Placed along the unrotated arrow (pointing right). Upright labels are
    // turned back by the opposite rotation; "along" labels turn with the
    // arrow (and may read upside down for some angles: the angle isn't known
    // until a question sets it).
    const t = labelFraction(s.labelSettings.at);
    const settings = s.labelSettings.orient === "horizontal" ? { ...s.labelSettings } : s.labelSettings;
    const place = placeLabel({ x: { a: s.x, b: t }, y: { a: s.y, b: 0 } }, { x: 1, y: 0 }, settings);
    const x = at(place.x);
    const y2 = at(place.y);
    // The direction is unknown, so upright labels are centred rather than aligned to a side.
    const anchor = s.labelSettings.orient === "horizontal" ? "middle" : place.anchor;
    rotated.push(
      labelText(s, color, x, y2, anchor, s.labelSettings.orient === "horizontal" ? `${unturn} ${x} ${y2}` : null),
    );
  }
  return [
    {
      key: newElementKey(),
      kind: "group",
      attrs: { transform: `rotate(${turn} ${formatNumber(s.x)} ${y})` },
      children: rotated,
    },
  ];
}

/** The label <text>. `rotate` is "deg" (turned about the label's own
 *  position) or a full "angle cx cy" argument, or null for none. */
function labelText(
  s: ControlSettings,
  color: string,
  x: string,
  y: string,
  anchor: string,
  rotate: string | null,
): SceneElement {
  const attrs: Record<string, string> = {
    x,
    y,
    dy: "0.35em",
    "text-anchor": anchor,
    "font-size": formatNumber(s.fontSize),
    "font-family": "sans-serif",
    fill: color,
    stroke: "none",
  };
  if (rotate !== null) attrs.transform = rotate.includes(" ") ? `rotate(${rotate})` : `rotate(${rotate} ${x} ${y})`;
  return { key: newElementKey(), kind: "text", attrs, text: s.label };
}

function barChildren(s: ControlSettings): SceneElement[] {
  const half = s.thickness / 2;
  const term = lengthTerm(s);
  const at = (a: number, b: number) => coordinate({ a, b }, term, s.variable);
  const thickness = formatNumber(s.thickness);
  const attrs: Record<string, string> =
    s.direction === "up"
      ? { x: formatNumber(s.x - half), y: at(s.y, -1), width: thickness, height: at(0, 1) }
      : s.direction === "down"
        ? { x: formatNumber(s.x - half), y: formatNumber(s.y), width: thickness, height: at(0, 1) }
        : s.direction === "right"
          ? { x: formatNumber(s.x), y: formatNumber(s.y - half), width: at(0, 1), height: thickness }
          : { x: at(s.x, -1), y: formatNumber(s.y - half), width: at(0, 1), height: thickness };
  // Fill and stroke are inherited from the group.
  const children: SceneElement[] = [{ key: newElementKey(), kind: "rect", attrs }];
  if (s.label.trim() !== "") {
    const u = barDirectionVector(s.direction);
    const t = labelFraction(s.labelSettings.at);
    const place = placeLabel(
      { x: { a: s.x, b: u.x * t }, y: { a: s.y, b: u.y * t } },
      u,
      // Beside a bar means clear of its thickness too.
      { ...s.labelSettings, gap: s.labelSettings.gap + (s.labelSettings.at === "mid" ? s.thickness / 2 : 0) },
    );
    const color = "#000000";
    children.push(
      labelText(s, color, at(place.x.a, place.x.b), at(place.y.a, place.y.b), place.anchor, place.rotate === null ? null : String(place.rotate)),
    );
  }
  return children;
}

function barDirectionVector(direction: BarDirection): { x: number; y: number } {
  return direction === "up" ? { x: 0, y: -1 } : direction === "down" ? { x: 0, y: 1 } : direction === "left" ? { x: -1, y: 0 } : { x: 1, y: 0 };
}

/** Where a point on the control is (start, middle or end), as coordinates
 *  that grow with its length, plus its direction, for attaching texts.
 *  Null for a variable-angle arrow, whose direction isn't known in advance. */
export function controlAnchorFrame(
  element: SceneElement,
  t: number,
): { x: string; y: string; u: { x: number; y: number }; toAttr: (value: Linear) => string; point: { x: Linear; y: Linear } } | null {
  const s = readSettings(element);
  const kind = controlKind(element);
  if (!s || !kind || kind === "variable-arc" || s.angleVariable) return null;
  const term = lengthTerm(s);
  const toAttr = (value: Linear) => coordinate(value, term, s.variable);
  let u: { x: number; y: number };
  if (kind === "variable-arrow") {
    const radians = (screenAngle(s, s.angle) * Math.PI) / 180;
    u = { x: cleanTrig(Math.cos(radians)), y: cleanTrig(Math.sin(radians)) };
  } else {
    u = barDirectionVector(s.direction);
  }
  const point = { x: { a: s.x, b: u.x * t }, y: { a: s.y, b: u.y * t } };
  return { x: toAttr(point.x), y: toAttr(point.y), u, toAttr, point };
}

/** The frame (screen degrees) a control's label offset is measured in, for
 *  turning a drag on screen into data-label-dx/dy. */
export function controlLabelFrame(element: SceneElement, values: Record<string, string>): number {
  const arc = readArcSettings(element);
  if (arc) return arcLabelFrame(arc, values);
  const s = readSettings(element);
  const kind = controlKind(element);
  if (!s || !kind) return 0;
  if (kind === "variable-bar") {
    return s.labelSettings.orient === "along" ? readableAngle(barDirectionVector(s.direction)) : 0;
  }
  const direction = screenAngle(s, currentAngle(s, values));
  if (s.angleVariable) {
    // Inside the rotated group the offset turns with the arrow.
    return direction;
  }
  if (s.labelSettings.orient === "along") {
    const radians = (direction * Math.PI) / 180;
    return readableAngle({ x: Math.cos(radians), y: Math.sin(radians) });
  }
  return 0;
}

/** "a + b * L" as an attribute value: a plain number when b is 0. A plain
 *  scale folds into the coefficient ("160 + 0.7071 * force"); a formula or
 *  clamp is kept whole ("60 - max(8, min(140, 0.1 * force))"). */
function coordinate({ a, b }: Linear, term: LengthTerm, variable: string): string {
  if ("scaled" in term) return linear({ a, b: b * term.scaled }, variable);
  const coefficient = Math.round(b * 10000) / 10000;
  if (coefficient === 0) return formatNumber(a);
  const size = Math.abs(coefficient);
  const scaled = size === 1 ? term.text : `${formatCoefficient(size)} * ${term.text}`;
  const constant = Math.round(a * 100) / 100;
  if (constant === 0) return `{{calc: ${coefficient < 0 ? "-" : ""}${scaled}}}`;
  return `{{calc: ${formatNumber(constant)} ${coefficient < 0 ? "-" : "+"} ${scaled}}}`;
}

/** "a + b * v" as an attribute value: a plain number when b is 0. */
function linear({ a, b }: Linear, variable: string): string {
  const coefficient = Math.round(b * 10000) / 10000;
  if (coefficient === 0) return formatNumber(a);
  const term = coefficient === 1 ? variable : coefficient === -1 ? `-${variable}` : `${formatCoefficient(coefficient)} * ${variable}`;
  const constant = Math.round(a * 100) / 100;
  if (constant === 0) return `{{calc: ${term}}}`;
  if (coefficient === -1) return `{{calc: ${formatNumber(constant)} - ${variable}}}`;
  if (coefficient < 0) return `{{calc: ${formatNumber(constant)} - ${formatCoefficient(-coefficient)} * ${variable}}}`;
  return `{{calc: ${formatNumber(constant)} + ${term}}}`;
}

/** cos(90°) is 6e-17 in floating point; call that 0 so it vanishes from the expression. */
function cleanTrig(value: number): number {
  return Math.abs(value) < 1e-9 ? 0 : value;
}

function snapAngle(degrees: number): number {
  const snapped = Math.round(degrees / 15) * 15;
  return snapped <= -180 ? snapped + 360 : snapped > 180 ? snapped - 360 : snapped;
}

/** The angle of a drag in the control's convention, snapped to 15°. */
function dragAngle(dx: number, dy: number, ccw: boolean): number {
  const degrees = (Math.atan2(ccw ? -dy : dy, dx) * 180) / Math.PI;
  const snapped = snapAngle(degrees);
  // Counterclockwise angles read most naturally as 0–345°.
  return ccw && snapped < 0 ? snapped + 360 : snapped;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export function setControlAttrs(
  element: SceneElement,
  attrs: Record<string, string>,
  remove: string[] = [],
): SceneElement {
  if (element.kind !== "group") return element;
  const next = { ...element.attrs, ...attrs };
  for (const name of remove) delete next[name];
  return rebuildControl({ ...element, attrs: next });
}

/** The arrow's angle variable, when its direction is programmable. */
export function controlAngleVariable(element: SceneElement): string | null {
  return readSettings(element)?.angleVariable ?? null;
}

/** True when the control measures angles counterclockwise (the standard). */
export function controlUsesCcw(element: SceneElement): boolean {
  return readSettings(element)?.ccw ?? true;
}

/** Switches an old clockwise arrow to counterclockwise angles. A fixed angle
 *  draws exactly the same afterwards; a variable angle's question values
 *  must be negated too, so the caller is told which variable that is. */
export function convertToCcw(element: SceneElement): { element: SceneElement; angleVariable: string | null } {
  const s = readSettings(element);
  if (!s || s.ccw || controlKind(element) !== "variable-arrow") return { element, angleVariable: null };
  return {
    element: setControlAttrs(element, { "data-angle": formatNumber(-s.angle), "data-angle-convention": "ccw" }),
    angleVariable: s.angleVariable,
  };
}

/** Preview values a control implies on opening a file: a variable angle
 *  starts at the direction it was last shown at (kept in data-angle). */
export function controlPreviewDefaults(element: SceneElement): Record<string, string> {
  const s = readSettings(element);
  return s?.angleVariable ? { [s.angleVariable]: formatNumber(s.angle) } : {};
}

export function controlScaleGroup(element: SceneElement): string | null {
  return readSettings(element)?.scaleGroup ?? null;
}

function currentAngle(s: ControlSettings, values: Record<string, string>): number {
  if (!s.angleVariable) return s.angle;
  const value = Number(values[s.angleVariable]);
  return Number.isFinite(value) ? value : 0;
}

export function translateControl(element: SceneElement, dx: number, dy: number): SceneElement | null {
  const s = readSettings(element);
  if (!s) return null;
  return setControlAttrs(element, { "data-x": formatNumber(s.x + dx), "data-y": formatNumber(s.y + dy) });
}

/** Where the arrow tip / bar end sits for the given preview values. */
export function controlEnd(element: SceneElement, values: Record<string, string>): Point | null {
  const arc = readArcSettings(element);
  if (arc) return arcEndPoint(arc, values);
  const s = readSettings(element);
  const kind = controlKind(element);
  if (!s || !kind) return null;
  const length = lengthAt(s, Number(values[s.variable]) || 0);
  if (kind === "variable-arrow") {
    const radians = (screenAngle(s, currentAngle(s, values)) * Math.PI) / 180;
    return { x: s.x + Math.cos(radians) * length, y: s.y + Math.sin(radians) * length };
  }
  switch (s.direction) {
    case "up":
      return { x: s.x, y: s.y - length };
    case "down":
      return { x: s.x, y: s.y + length };
    case "left":
      return { x: s.x - length, y: s.y };
    default:
      return { x: s.x + length, y: s.y };
  }
}

export function controlAnchor(element: SceneElement): Point | null {
  const s = readSettings(element);
  return s ? { x: s.x, y: s.y } : null;
}

/** Dragging the tip: an arrow turns (15° steps) and both report the value
 *  the new length means, as preview values. A fixed angle is part of the
 *  drawing so it changes the element; a variable angle only changes the
 *  preview (and data-angle, which remembers it for next time). */
export function dragControlEnd(
  element: SceneElement,
  to: Point,
  values: Record<string, string> = {},
): { element: SceneElement; preview: Record<string, string> } | null {
  const arc = readArcSettings(element);
  if (arc) return { element, preview: dragArcEnd(arc, to, values) };
  const s = readSettings(element);
  const kind = controlKind(element);
  if (!s || !kind) return null;
  const dx = to.x - s.x;
  const dy = to.y - s.y;
  if (kind === "variable-arrow") {
    const angle = dragAngle(dx, dy, s.ccw);
    const value = valueForLength(s, Math.hypot(dx, dy));
    const turned = setControlAttrs(element, { "data-angle": String(angle) });
    const preview: Record<string, string> = value === null ? {} : { [s.variable]: String(value) };
    if (s.angleVariable) preview[s.angleVariable] = String(angle);
    return { element: turned, preview };
  }
  const along = s.direction === "up" ? -dy : s.direction === "down" ? dy : s.direction === "left" ? -dx : dx;
  const value = valueForLength(s, Math.max(0, along));
  return { element, preview: value === null ? {} : { [s.variable]: String(Math.max(0, value)) } };
}
