// Style defaults and canvas presets for the drawing window.
// See "Style controls and defaults" and "Canvas presets" in docs/svg-editor-plan.md.

import type { SceneElement } from "./scene";

export interface Swatch {
  label: string;
  value: string;
}

/** Black, grays, white: tests are photocopied, so color is opt-in. */
export const STROKE_SWATCHES: Swatch[] = [
  { label: "Black", value: "#000000" },
  { label: "Dark gray", value: "#404040" },
  { label: "Gray", value: "#808080" },
  { label: "Light gray", value: "#bfbfbf" },
  { label: "White", value: "#ffffff" },
  { label: "None", value: "none" },
];

/** Fill grays are spaced so they stay distinct after copying. */
export const FILL_SWATCHES: Swatch[] = [
  { label: "None", value: "none" },
  { label: "White", value: "#ffffff" },
  { label: "Very light gray", value: "#f0f0f0" },
  { label: "Light gray", value: "#d9d9d9" },
  { label: "Gray", value: "#a6a6a6" },
  { label: "Dark gray", value: "#595959" },
  { label: "Black", value: "#000000" },
];

export const STROKE_WEIGHTS = [0.75, 1, 1.25, 1.5, 2, 3, 4];

export type LineType = "solid" | "dashed" | "dotted";

export const LINE_TYPES: { value: LineType; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

export interface DrawingStyle {
  stroke: string;
  fill: string;
  strokeWidth: number;
  lineType: LineType;
  fontSize: number;
}

export interface CanvasPreset {
  id: "two-column" | "full-width" | "answer-choice";
  label: string;
  width: number;
  height: number;
  /** Starting zoom on screen; the saved file is always 1:1 print size. */
  zoom: number;
  gridSize: number;
  strokeWidth: number;
  fontSize: number;
  hint: string;
}

// 96 px/in; Letter with 0.75in margins = 7in of content, 0.35in column gap.
export const CANVAS_PRESETS: CanvasPreset[] = [
  {
    id: "two-column",
    label: "Two-column",
    width: 318,
    height: 200,
    zoom: 2,
    gridSize: 10,
    strokeWidth: 1.5,
    fontSize: 14,
    hint: "3.3 in wide: one column of a two-column test",
  },
  {
    id: "full-width",
    label: "Full width",
    width: 672,
    height: 280,
    zoom: 1.25,
    gridSize: 10,
    strokeWidth: 1.5,
    fontSize: 14,
    hint: "7 in wide: single-column tests and large setups",
  },
  {
    id: "answer-choice",
    label: "Answer choice",
    width: 134,
    height: 96,
    zoom: 3,
    gridSize: 5,
    strokeWidth: 1.25,
    fontSize: 12,
    hint: "1.4 × 1 in: a diagram used as a multiple-choice option",
  },
];

export function findPreset(width: number | null): CanvasPreset | undefined {
  return CANVAS_PRESETS.find((preset) => preset.width === width);
}

export function defaultStyle(preset: CanvasPreset = CANVAS_PRESETS[0]): DrawingStyle {
  return {
    stroke: "#000000",
    fill: "none",
    strokeWidth: preset.strokeWidth,
    lineType: "solid",
    fontSize: preset.fontSize,
  };
}

/** Dash spacing grows with stroke weight so a thick dashed line still reads as dashed. */
export function dashArray(lineType: LineType, strokeWidth: number): string | null {
  if (lineType === "dashed") return `${round(strokeWidth * 4)} ${round(strokeWidth * 3)}`;
  if (lineType === "dotted") return `0.1 ${round(strokeWidth * 2.5)}`;
  return null;
}

export function lineTypeFromAttrs(attrs: Record<string, string>): LineType {
  const dash = attrs["stroke-dasharray"]?.trim();
  if (!dash || dash === "none") return "solid";
  return dash.startsWith("0.1") || dash.startsWith("0 ") ? "dotted" : "dashed";
}

/** Writes stroke/fill/dash attributes onto an attribute map, keeping geometry first. */
export function applyStrokeAttrs(
  attrs: Record<string, string>,
  style: Pick<DrawingStyle, "stroke" | "strokeWidth" | "lineType">,
): Record<string, string> {
  const next: Record<string, string> = { ...attrs, stroke: style.stroke, "stroke-width": String(style.strokeWidth) };
  const dash = dashArray(style.lineType, style.strokeWidth);
  if (dash) {
    next["stroke-dasharray"] = dash;
    if (style.lineType === "dotted") next["stroke-linecap"] = "round";
    else delete next["stroke-linecap"];
  } else {
    delete next["stroke-dasharray"];
    delete next["stroke-linecap"];
  }
  return next;
}

/** The style an element currently has, for showing in the inspector. */
export function readStyle(element: SceneElement, fallback: DrawingStyle): DrawingStyle {
  if (element.kind === "passthrough") return fallback;
  const attrs = element.attrs;
  const width = Number(attrs["stroke-width"]);
  const fontSize = Number(attrs["font-size"]);
  return {
    stroke: attrs.stroke ?? (element.kind === "text" ? "none" : fallback.stroke),
    fill: attrs.fill ?? (element.kind === "text" ? "#000000" : "none"),
    strokeWidth: Number.isFinite(width) && width > 0 ? width : fallback.strokeWidth,
    lineType: lineTypeFromAttrs(attrs),
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : fallback.fontSize,
  };
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}
