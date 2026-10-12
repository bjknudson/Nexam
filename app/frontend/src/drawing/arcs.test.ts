import { describe, expect, it } from "vitest";

import { arcEndPoint, arcPathData, arcStartPoint, dragArcEnd, dragArcStart, fixedArcToVariable, readArcSettings } from "./arcs";
import { createControlFromDrag, setControlAttrs } from "./controls";
import { evaluateExpression, previewElement } from "./preview";
import type { SceneElement } from "./scene";
import { createShapeFromDrag, moveHandle, rebuildShape } from "./shapes";
import { defaultStyle } from "./styles";
import { parseSvg, serializeSvg } from "./svgIO";

const style = defaultStyle();
const children = (element: SceneElement) => (element.kind === "group" ? element.children : []);
const attrsOf = (element: SceneElement) => (element.kind === "passthrough" ? {} : element.attrs);

// Centre (100, 100), dragged right 40 px: rotation 0, radius 40.
const arc = createControlFromDrag("variable-arc", { x: 100, y: 100 }, { x: 140, y: 100 }, style, [], 20)!;
const settings = readArcSettings(arc.element)!;

/** The screen rotation of the arc's circle and its dash length, for given values. */
function drawn(element: SceneElement, values: Record<string, string>) {
  const preview = previewElement(element, values);
  const group = children(preview)[0];
  const circle = attrsOf(children(group)[0]);
  return {
    rotate: Number(attrsOf(group).transform.match(/rotate\((-?[\d.]+)/)![1]),
    dash: Number(circle["stroke-dasharray"].split(" ")[0]),
  };
}

describe("variable arc", () => {
  it("is created from a drag with its sweep as a variable", () => {
    expect(arc.variable).toBe("arc_angle");
    expect(arc.value).toBe(60);
    expect(attrsOf(arc.element)).toMatchObject({ "data-rotation": "0", "data-radius": "40", "data-variable": "arc_angle" });
  });

  it("draws |sweep| of circle, starting where a negative sweep ends", () => {
    const positive = drawn(arc.element, { arc_angle: "90" });
    expect(positive.dash).toBeCloseTo((Math.PI * 40) / 2, 1);
    expect(positive.rotate + 0).toBe(0);
    // Rotation 90 with sweep -90 covers the same quarter as rotation 0, sweep +90.
    const turned = setControlAttrs(arc.element, { "data-rotation": "90" });
    const negative = drawn(turned, { arc_angle: "-90" });
    expect(negative.dash).toBeCloseTo(positive.dash, 1);
    expect(negative.rotate + 0).toBe(0);
  });

  it("ends at rotation + sweep, counterclockwise from +x", () => {
    expect(arcEndPoint(settings, { arc_angle: "90" })).toMatchObject({ x: 100 });
    expect(arcEndPoint(settings, { arc_angle: "90" }).y).toBeCloseTo(60);
    expect(arcEndPoint(settings, { arc_angle: "-90" }).y).toBeCloseTo(140);
    expect(arcStartPoint(settings, {})).toMatchObject({ x: 140, y: 100 });
  });

  it("points its arrowhead the way the arc runs", () => {
    const withHead = setControlAttrs(arc.element, { "data-heads": "end" });
    const flip = (sweep: string) => {
      const head = children(previewElement(withHead, { arc_angle: sweep }))[1];
      return Number(attrsOf(head).transform.match(/scale\(1 (-?[\d.]+)\)/)![1]);
    };
    expect(flip("90")).toBe(1);
    expect(flip("-45")).toBe(-1);
    expect(flip("0")).toBe(0);
  });

  it("puts the label inside or outside the middle of the arc, upright", () => {
    const labeled = setControlAttrs(arc.element, { "data-label": "$\\theta$" });
    const label = (attrs: Record<string, string>, values: Record<string, string>) => {
      const group = children(previewElement(setControlAttrs(labeled, attrs), values)).slice(-1)[0];
      return { group: attrsOf(group).transform, text: attrsOf(children(group)[0]) };
    };
    const inside = label({}, { arc_angle: "60" });
    expect(inside.group).toBe("rotate(-30 100 100)");
    expect(Number(inside.text.x)).toBeLessThan(140);
    expect(inside.text.transform).toMatch(/^rotate\(30 /);
    expect(Number(label({ "data-label-side": "outside" }, { arc_angle: "60" }).text.x)).toBeGreaterThan(140);
  });

  it("follows the pointer continuously past 180° and below 0°", () => {
    // From a sweep of 170°, dragging to just past the left (190°) keeps going.
    const end = { x: 100 - 40 * Math.cos((10 * Math.PI) / 180), y: 100 + 40 * Math.sin((10 * Math.PI) / 180) };
    expect(dragArcEnd(settings, end, { arc_angle: "170" })).toEqual({ arc_angle: "190" });
    // From -10°, dragging a little further clockwise goes more negative.
    expect(dragArcEnd(settings, { x: 100 + 28, y: 100 + 28 }, { arc_angle: "-10" })).toEqual({ arc_angle: "-45" });
  });

  it("sets radius and rotation from the start handle, or their preview values when variable", () => {
    expect(dragArcStart(settings, { x: 100, y: 50 })).toEqual({ attrs: { "data-rotation": "90", "data-radius": "50" }, preview: {} });
    const variable = readArcSettings(setControlAttrs(arc.element, { "data-radius-variable": "r", "data-rotation-variable": "start" }))!;
    expect(dragArcStart(variable, { x: 50, y: 100 })).toEqual({ attrs: {}, preview: { start: "180", r: "50" } });
  });

  it("scales a variable radius", () => {
    const variable = setControlAttrs(arc.element, { "data-radius-variable": "r", "data-radius-scale": "2" });
    const circle = attrsOf(children(children(variable)[0])[0]);
    expect(circle.r).toBe("{{calc: 2 * r}}");
    expect(evaluateExpression(circle["stroke-dasharray"].match(/\{\{calc: (.*?)\}\}/)![1], { r: "20", arc_angle: "-180" })).toBeCloseTo(Math.PI * 40, 1);
  });

  it("round-trips through a saved file", () => {
    const svg = serializeSvg({ rootAttrs: { viewBox: "0 0 200 200" }, elements: [setControlAttrs(arc.element, { "data-heads": "both", "data-label": "θ" })] });
    expect(serializeSvg(parseSvg(svg).document)).toBe(svg);
  });
});

describe("fixed arc", () => {
  const fixed = createShapeFromDrag("arc", { x: 100, y: 100 }, { x: 140, y: 100 }, style)!;
  const pathOf = (element: SceneElement) => (children(element)[0] as { markup: string }).markup;
  const withAttrs = (element: SceneElement, attrs: Record<string, string>) =>
    rebuildShape({ ...element, attrs: { ...attrsOf(element), ...attrs } } as SceneElement);

  it("is a real SVG arc: counterclockwise for positive sweeps, clockwise for negative", () => {
    expect(attrsOf(fixed)).toMatchObject({ "data-nexam-shape": "arc", "data-rotation": "0", "data-sweep": "90", "data-radius": "40" });
    expect(pathOf(fixed)).toBe('<path d="M 140 100 A 40 40 0 0 0 100 60" fill="none"/>');
    expect(pathOf(withAttrs(fixed, { "data-sweep": "-90" }))).toBe('<path d="M 140 100 A 40 40 0 0 1 100 140" fill="none"/>');
    expect(pathOf(withAttrs(fixed, { "data-sweep": "270" }))).toContain("A 40 40 0 1 0 100 140");
  });

  it("closes as a fillable wedge", () => {
    expect(pathOf(withAttrs(fixed, { "data-wedge": "true" }))).toBe('<path d="M 100 100 L 140 100 A 40 40 0 0 0 100 60 Z"/>');
  });

  it("can be dashed, while its arrowheads stay solid", () => {
    const dashed = withAttrs(fixed, { "stroke-dasharray": "6 4.5", "data-heads": "end" });
    const head = attrsOf(children(dashed)[1]);
    expect(head["stroke-dasharray"]).toBe("none");
    // At the end (90°, top), running counterclockwise means pointing left.
    const [tip, a, b] = head.points.split(" ").map((p) => p.split(",").map(Number));
    expect(tip).toEqual([100, 60]);
    expect((a[0] + b[0]) / 2).toBeGreaterThan(100);
  });

  it("drags its end round continuously and converts to a variable arc", () => {
    const end = moveHandle(fixed, "end", { x: 60, y: 101 });
    expect(attrsOf(end)["data-sweep"]).toBe("180");
    const converted = fixedArcToVariable(fixed, "arc_angle")!;
    expect(attrsOf(converted.element)).toMatchObject({ "data-nexam-control": "variable-arc", "data-variable": "arc_angle", "data-rotation": "0" });
    expect(converted.sweep).toBe(90);
  });

  it("round-trips through a saved file", () => {
    const svg = serializeSvg({ rootAttrs: { viewBox: "0 0 200 200" }, elements: [withAttrs(fixed, { "data-label": "θ", "data-heads": "both" })] });
    expect(serializeSvg(parseSvg(svg).document)).toBe(svg);
  });
});

describe("dashed arcs and wedges (sin/cos)", () => {
  /** The path's numbers for given values: [x0, y0, (rx, ry, 0, 0, 0, x, y) × 2]. */
  function pathNumbers(element: SceneElement, values: Record<string, string>): number[] {
    const path = children(previewElement(element, values))[0];
    if (path.kind !== "passthrough") throw new Error("expected a path");
    const d = path.markup.match(/ d="([^"]+)"/)![1];
    return d.match(/-?[\d.]+(e-?\d+)?/g)!.map(Number);
  }

  it("sin and cos work in degrees in the preview", () => {
    expect(evaluateExpression("cos(60)", {})).toBeCloseTo(0.5);
    expect(evaluateExpression("10 * sin(a + 30)", { a: "60" })).toBeCloseTo(10);
    expect(evaluateExpression("sin(180)", {})).toBe(0);
  });

  it("a dashed variable arc is a path from start to end through the middle", () => {
    const dashed = setControlAttrs(arc.element, { "stroke-dasharray": "6 4.5" });
    const path = children(dashed)[0];
    expect(path.kind === "passthrough" && path.tagName).toBe("path");
    expect(path.kind === "passthrough" && path.markup).toContain('fill="none"');
    // Rotation 0, radius 40, sweep 90: from (140, 100) through 45° to (100, 60).
    const n = pathNumbers(dashed, { [settings.sweep]: "90" });
    expect(n[0]).toBeCloseTo(140);
    expect(n[1]).toBeCloseTo(100);
    expect(n.slice(2, 7)).toEqual([40, 40, 0, 0, 0]);
    expect(n[7]).toBeCloseTo(100 + 40 * Math.SQRT1_2);
    expect(n[8]).toBeCloseTo(100 - 40 * Math.SQRT1_2);
    expect(n[14]).toBeCloseTo(100);
    expect(n[15]).toBeCloseTo(60);
  });

  it("a negative sweep covers the same stretch, starting at its far end", () => {
    const dashed = setControlAttrs(setControlAttrs(arc.element, { "data-rotation": "90" }), { "stroke-dasharray": "6 4.5" });
    const n = pathNumbers(dashed, { [settings.sweep]: "-90" });
    // From 0° (140, 100) counterclockwise to 90° (100, 60).
    expect(n[0]).toBeCloseTo(140);
    expect(n[1]).toBeCloseTo(100);
    expect(n[14]).toBeCloseTo(100);
    expect(n[15]).toBeCloseTo(60);
  });

  it("each half stays within 180°, so a nearly full turn draws correctly", () => {
    const dashed = setControlAttrs(arc.element, { "stroke-dasharray": "6 4.5" });
    const n = pathNumbers(dashed, { [settings.sweep]: "350" });
    // The middle is at 175°, on the far side of the circle.
    expect(n[7]).toBeCloseTo(100 + 40 * Math.cos((175 * Math.PI) / 180));
    expect(n[8]).toBeCloseTo(100 - 40 * Math.sin((175 * Math.PI) / 180));
  });

  it("a wedge closes to the centre and takes the group's fill", () => {
    const wedge = setControlAttrs(arc.element, { "data-wedge": "true", fill: "#d9d9d9" });
    expect(readArcSettings(wedge)!.wedge).toBe(true);
    const path = children(wedge)[0];
    expect(path.kind === "passthrough" && path.markup).not.toContain("fill=");
    expect(arcPathData(readArcSettings(wedge)!)).toMatch(/^M 100 100 L .* Z$/);
    expect(attrsOf(wedge).fill).toBe("#d9d9d9");
  });

  it("a variable radius goes into the path", () => {
    const variable = setControlAttrs(arc.element, { "data-radius-variable": "r", "data-wedge": "true" });
    const n = pathNumbers(variable, { [settings.sweep]: "90", r: "20" });
    expect(n.slice(0, 4)).toEqual([100, 100, 120, 100]);
  });

  it("a solid open arc keeps the dashed circle, and paths round-trip", () => {
    expect(children(arc.element)[0].kind).toBe("group");
    const wedge = setControlAttrs(arc.element, { "data-wedge": "true" });
    const svg = serializeSvg({ rootAttrs: { viewBox: "0 0 200 200" }, elements: [wedge] });
    expect(serializeSvg(parseSvg(svg).document)).toBe(svg);
  });
});
