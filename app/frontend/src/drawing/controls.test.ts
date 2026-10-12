import { describe, expect, it } from "vitest";

import {
  controlEnd,
  controlPreviewDefaults,
  controlUsesCcw,
  convertToCcw,
  createControlFromDrag,
  dragControlEnd,
  fitToRange,
  lengthReadout,
  setControlAttrs,
  uniqueVariableName,
} from "./controls";
import { previewElement } from "./preview";
import type { SceneElement } from "./scene";
import { translateElement } from "./shapes";
import { defaultStyle } from "./styles";
import { parseSvg, serializeSvg } from "./svgIO";

const style = defaultStyle();

function children(element: SceneElement): SceneElement[] {
  return element.kind === "group" ? element.children : [];
}

function attrsOf(element: SceneElement): Record<string, string> {
  return element.kind === "passthrough" ? {} : element.attrs;
}

describe("variable arrow", () => {
  const created = createControlFromDrag("variable-arrow", { x: 160, y: 60 }, { x: 160, y: 20 }, style, [], 20)!;

  it("takes its angle, variable name and preview length from the drag", () => {
    expect(created.variable).toBe("arrow_length");
    expect(created.value).toBe(40);
    // Dragged straight up: 90°, counterclockwise from the positive x-axis.
    expect(attrsOf(created.element)).toMatchObject({
      "data-nexam-control": "variable-arrow",
      "data-variable": "arrow_length",
      "data-angle": "90",
      "data-angle-convention": "ccw",
    });
  });

  it("writes straight up/down arrows with plain x and a calc y", () => {
    const [shaft, head] = children(created.element);
    expect(attrsOf(shaft).x1).toBe("160");
    expect(attrsOf(shaft).x2).toBe("160");
    expect(attrsOf(shaft).y1).toBe("60");
    expect(attrsOf(shaft).y2).toMatch(/^\{\{calc: [\d.]+ - arrow_length\}\}$/);
    expect(attrsOf(head).points).toContain("{{calc: 60 - arrow_length}}");
  });

  it("puts the tip where controlEnd says for any value", () => {
    for (const value of [0, 25, 80]) {
      const preview = previewElement(created.element, { arrow_length: String(value) });
      const tip = attrsOf(children(preview)[1]).points.split(" ")[0];
      const end = controlEnd(created.element, { arrow_length: String(value) })!;
      expect(tip).toBe(`${end.x},${end.y}`);
    }
  });

  it("bakes angled directions into cos/sin coefficients, counterclockwise", () => {
    // 30° points up and to the right, as in a textbook.
    const angled = setControlAttrs(created.element, { "data-angle": "30" });
    const preview = previewElement(angled, { arrow_length: "100" });
    const [x, y] = attrsOf(children(preview)[1]).points.split(" ")[0].split(",").map(Number);
    expect(x).toBeCloseTo(160 + 86.6, 1);
    expect(y).toBeCloseTo(60 - 50, 1);
    expect(attrsOf(children(angled)[0]).x2).toContain("0.866 * arrow_length");
    expect(attrsOf(children(angled)[0]).y2).toContain("- 0.5 * arrow_length");
  });

  it("adds a label that follows the tip", () => {
    const labelled = setControlAttrs(created.element, { "data-label": "{{force}}" });
    const label = children(labelled).find((child) => child.kind === "text")!;
    expect(label.kind === "text" && label.text).toBe("{{force}}");
    expect(attrsOf(label).y).toContain("arrow_length");
    expect(attrsOf(label)["text-anchor"]).toBe("middle");
  });

  it("turns in 15° steps and reports the length when its tip is dragged", () => {
    const result = dragControlEnd(created.element, { x: 220, y: 60 })!;
    expect(attrsOf(result.element)["data-angle"]).toBe("0");
    expect(result.preview).toEqual({ arrow_length: "60" });
    // Down-left is 225°, reported within one turn.
    expect(attrsOf(dragControlEnd(created.element, { x: 120, y: 100 })!.element)["data-angle"]).toBe("225");
  });

  it("moves by its anchor and round-trips through a saved file", () => {
    const moved = translateElement(created.element, 10, 0)!;
    expect(attrsOf(moved)["data-x"]).toBe("170");
    const svg = serializeSvg({ rootAttrs: { viewBox: "0 0 318 200" }, elements: [moved] });
    expect(serializeSvg(parseSvg(svg).document)).toBe(svg);
  });
});

describe("variable angle", () => {
  const fixed = createControlFromDrag("variable-arrow", { x: 100, y: 120 }, { x: 160, y: 120 }, style, [], 20)!;
  const variable = setControlAttrs(fixed.element, { "data-angle-variable": "arrow_angle", "data-label": "F" });

  it("rotates the arrow about its tail by the angle variable", () => {
    const [rotated] = children(variable);
    expect(rotated.kind).toBe("group");
    // SVG turns clockwise, so a counterclockwise angle is applied negated.
    expect(attrsOf(rotated).transform).toBe("rotate({{calc: -arrow_angle}} 100 120)");
    // Inside, the arrow points right, so only x depends on the length.
    const shaft = attrsOf(children(rotated)[0]);
    expect(shaft.y1).toBe("120");
    expect(shaft.y2).toBe("120");
    expect(shaft.x2).toContain("arrow_length");
  });

  it("keeps the label upright with an opposite rotation", () => {
    const label = children(children(variable)[0]).find((child) => child.kind === "text")!;
    expect(attrsOf(label).transform).toMatch(/^rotate\(\{\{arrow_angle\}\} \{\{calc: [\d.]+ \+ arrow_length\}\} 120\)$/);
    expect(attrsOf(label)["text-anchor"]).toBe("middle");
  });

  it("puts the tip handle where the preview angle says", () => {
    const end = controlEnd(variable, { arrow_length: "50", arrow_angle: "90" })!;
    expect(end.x).toBeCloseTo(100);
    expect(end.y).toBeCloseTo(70);
  });

  it("drags the tip into preview values for both variables", () => {
    // Dragged straight down: 270°.
    const result = dragControlEnd(variable, { x: 100, y: 180 })!;
    expect(result.preview).toEqual({ arrow_length: "60", arrow_angle: "270" });
  });

  it("starts the angle preview at the last shown direction", () => {
    const turned = setControlAttrs(variable, { "data-angle": "135" });
    expect(controlPreviewDefaults(turned)).toEqual({ arrow_angle: "135" });
    expect(controlPreviewDefaults(fixed.element)).toEqual({});
  });

  it("goes back to a baked-in fixed angle when the variable is removed", () => {
    const back = setControlAttrs(variable, { "data-angle": "0" }, ["data-angle-variable"]);
    expect(children(back)[0].kind).toBe("line");
    expect(serializeSvg({ rootAttrs: {}, elements: [back] })).not.toContain("rotate(");
  });
});

describe("arrows saved with the old clockwise angles", () => {
  const modern = createControlFromDrag("variable-arrow", { x: 100, y: 120 }, { x: 160, y: 120 }, style, [], 20)!.element;
  // What a file saved before the convention change looks like: no marker.
  const legacy = setControlAttrs(modern, { "data-angle": "-90" }, ["data-angle-convention"]);
  const legacyVariable = setControlAttrs(legacy, { "data-angle-variable": "arrow_angle" });

  it("keep drawing exactly as before", () => {
    expect(controlUsesCcw(legacy)).toBe(false);
    // -90 meant "up" in the old convention, and still does.
    expect(controlEnd(legacy, { arrow_length: "50" })).toMatchObject({ x: 100, y: 70 });
    expect(attrsOf(children(legacyVariable)[0]).transform).toBe("rotate({{arrow_angle}} 100 120)");
  });

  it("convert to counterclockwise without moving a fixed arrow", () => {
    const { element, angleVariable } = convertToCcw(legacy);
    expect(angleVariable).toBeNull();
    expect(attrsOf(element)).toMatchObject({ "data-angle": "90", "data-angle-convention": "ccw" });
    expect(controlEnd(element, { arrow_length: "50" })).toMatchObject({ x: 100, y: 70 });
  });

  it("report a variable angle whose question values must flip sign", () => {
    expect(convertToCcw(legacyVariable).angleVariable).toBe("arrow_angle");
  });
});

describe("scaling the length", () => {
  const arrow = createControlFromDrag("variable-arrow", { x: 100, y: 150 }, { x: 100, y: 100 }, style, [], 20)!.element;

  it("folds a plain scale into the coefficients", () => {
    const scaled = setControlAttrs(arrow, { "data-scale": "0.1" });
    expect(attrsOf(children(scaled)[1]).points).toContain("{{calc: 150 - 0.1 * arrow_length}}");
    expect(lengthReadout(scaled, 800)).toEqual({ perUnit: 0.1, atPreview: 80, clamped: false });
  });

  it("uses a formula for the length", () => {
    const formula = setControlAttrs(arrow, { "data-length-expression": "arrow_length / 10 + 5" });
    expect(attrsOf(children(formula)[1]).points).toContain("{{calc: 150 - (arrow_length / 10 + 5)}}");
    expect(controlEnd(formula, { arrow_length: "800" })).toMatchObject({ x: 100, y: 65 });
    expect(lengthReadout(formula, 800)?.perUnit).toBeNull();
    // Dragging the tip still finds the value: 85 px long means 800.
    expect(dragControlEnd(formula, { x: 100, y: 65 })!.preview.arrow_length).toBe("800");
  });

  it("ignores a formula that uses other names", () => {
    const bad = setControlAttrs(arrow, { "data-length-expression": "other * 2", "data-scale": "2" });
    expect(attrsOf(children(bad)[1]).points).toContain("{{calc: 150 - 2 * arrow_length}}");
  });

  it("keeps the length between a minimum and maximum", () => {
    const clamped = setControlAttrs(arrow, { "data-scale": "0.1", "data-min-length": "8", "data-max-length": "140" });
    expect(attrsOf(children(clamped)[1]).points).toContain("{{calc: 150 - max(8, min(140, 0.1 * arrow_length))}}");
    for (const [value, length] of [
      ["5", 8],
      ["800", 80],
      ["5000", 140],
    ] as const) {
      const tip = attrsOf(children(previewElement(clamped, { arrow_length: value }))[1]).points.split(" ")[0];
      expect(tip).toBe(`100,${150 - length}`);
    }
    expect(lengthReadout(clamped, 5000)?.clamped).toBe(true);
  });

  it("fits a range proportionally, warning when the small end gets too short", () => {
    const fit = fitToRange("force", { min: 50, max: 800 }, { min: 15, max: 120 }, "proportional")!;
    expect(fit.attrs).toEqual({ "data-scale": "0.15" });
    expect(fit.remove).toEqual(["data-length-expression"]);
    expect(fit.warning).toBeNull();
    expect(fitToRange("force", { min: 5, max: 800 }, { min: 15, max: 120 }, "proportional")!.warning).toContain("0.75 px");
  });

  it("fits a range linearly, and says it isn't proportional", () => {
    const fit = fitToRange("force", { min: 50, max: 800 }, { min: 15, max: 120 }, "linear")!;
    expect(fit.attrs["data-length-expression"]).toBe("15 + (force - 50) * 0.14");
    expect(fit.warning).toContain("Not proportional");
  });
});

describe("variable bar", () => {
  it("grows up from its base by the variable", () => {
    const { element, variable, value } = createControlFromDrag(
      "variable-bar",
      { x: 50, y: 150 },
      { x: 52, y: 90 },
      style,
      [],
      20,
    )!;
    expect([variable, value]).toEqual(["bar_length", 60]);
    const rect = attrsOf(children(element)[0]);
    expect(rect).toMatchObject({ x: "40", width: "20", y: "{{calc: 150 - bar_length}}", height: "{{calc: bar_length}}" });
    const preview = attrsOf(children(previewElement(element, { bar_length: "30" }))[0]);
    expect(preview).toMatchObject({ y: "120", height: "30" });
  });

  it("uses scale so 1 unit can be more than 1 px", () => {
    const { element } = createControlFromDrag("variable-bar", { x: 0, y: 50 }, { x: 80, y: 50 }, style, [], 10)!;
    const scaled = setControlAttrs(element, { "data-scale": "2.5" });
    expect(attrsOf(children(scaled)[0]).width).toBe("{{calc: 2.5 * bar_length}}");
    expect(dragControlEnd(scaled, { x: 50, y: 50 })!.preview).toEqual({ bar_length: "20" });
  });
});

describe("uniqueVariableName", () => {
  it("numbers repeats", () => {
    expect(uniqueVariableName("arrow_length", [])).toBe("arrow_length");
    expect(uniqueVariableName("arrow_length", ["arrow_length", "arrow_length_2"])).toBe("arrow_length_3");
  });
});
