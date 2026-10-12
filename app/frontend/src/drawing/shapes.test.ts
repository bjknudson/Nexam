/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

import forceDiagramSource from "../../../../samples/demo-bank/assets/sample-force-diagram.svg?raw";
import { evaluateExpression, fillPlaceholders, previewElement } from "./preview";
import type { SceneElement } from "./scene";
import {
  buildArrow,
  createShapeFromDrag,
  getHandles,
  moveHandle,
  translateElement,
} from "./shapes";
import { dashArray, defaultStyle, lineTypeFromAttrs } from "./styles";
import { parseSvg, serializeSvg } from "./svgIO";

const style = defaultStyle();

describe("createShapeFromDrag", () => {
  it("normalizes a drag up and to the left into a positive rectangle", () => {
    const rect = createShapeFromDrag("rect", { x: 50, y: 40 }, { x: 10, y: 20 }, style);
    expect(rect?.kind === "rect" && rect.attrs).toMatchObject({ x: "10", y: "20", width: "40", height: "20" });
  });

  it("writes grayscale defaults as plain attributes", () => {
    const line = createShapeFromDrag("line", { x: 0, y: 0 }, { x: 10, y: 0 }, style);
    expect(line?.kind === "line" && line.attrs).toEqual({
      x1: "0",
      y1: "0",
      x2: "10",
      y2: "0",
      stroke: "#000000",
      "stroke-width": "1.5",
    });
  });

  it("ignores a click that didn't really drag", () => {
    expect(createShapeFromDrag("line", { x: 5, y: 5 }, { x: 5, y: 6 }, style)).toBeNull();
  });
});

describe("line types", () => {
  it("scales dashes with stroke weight and recognises them again", () => {
    expect(dashArray("dashed", 1.5)).toBe("6 4.5");
    expect(dashArray("dashed", 3)).toBe("12 9");
    expect(dashArray("solid", 2)).toBeNull();
    expect(lineTypeFromAttrs({ "stroke-dasharray": dashArray("dotted", 2)! })).toBe("dotted");
    expect(lineTypeFromAttrs({ "stroke-dasharray": "6 4" })).toBe("dashed");
    expect(lineTypeFromAttrs({})).toBe("solid");
  });
});

describe("arrows", () => {
  it("is a group with a shaft and one head, colored like the stroke", () => {
    const arrow = buildArrow({ x: 0, y: 50 }, { x: 100, y: 50 }, "end", { ...style, stroke: "#404040" });
    expect(arrow.kind).toBe("group");
    if (arrow.kind !== "group") return;
    expect(arrow.children.map((child) => child.kind)).toEqual(["line", "polygon"]);
    const head = arrow.children[1] as { attrs: Record<string, string> };
    expect(head.attrs.fill).toBe("#404040");
    expect(head.attrs.points.startsWith("100,50 ")).toBe(true);
  });

  it("moves by its endpoints and survives a save/load round trip", () => {
    const arrow = buildArrow({ x: 0, y: 0 }, { x: 40, y: 0 }, "both", style);
    const moved = translateElement(arrow, 10, 5);
    expect(moved?.kind === "group" && moved.attrs).toMatchObject({
      "data-x1": "10",
      "data-y1": "5",
      "data-x2": "50",
      "data-y2": "5",
    });
    const svg = serializeSvg({ rootAttrs: { viewBox: "0 0 100 100" }, elements: [moved!] });
    expect(serializeSvg(parseSvg(svg).document)).toBe(svg);
  });

  it("reshapes from its tip handle", () => {
    const arrow = buildArrow({ x: 0, y: 0 }, { x: 40, y: 0 }, "end", style);
    expect(getHandles(arrow).map((handle) => handle.id)).toEqual(["start", "end"]);
    const longer = moveHandle(arrow, "end", { x: 80, y: 0 });
    expect(longer.kind === "group" && longer.attrs["data-x2"]).toBe("80");
  });
});

describe("translateElement", () => {
  it("refuses to drag a shape whose position is a variable", () => {
    const { document } = parseSvg(forceDiagramSource);
    const variableLine = document.elements.find(
      (element) => element.kind === "line" && element.attrs.y2.includes("{{"),
    )!;
    expect(translateElement(variableLine, 5, 5)).toBeNull();
    expect(getHandles(variableLine)).toEqual([]);
  });

  it("moves an ordinary group with a transform", () => {
    const group: SceneElement = { key: "g", kind: "group", attrs: { transform: "translate(5 5) rotate(10)" }, children: [] };
    expect(translateElement(group, 10, -5)?.kind === "group" && translateElement(group, 10, -5)).toMatchObject({
      attrs: { transform: "translate(15 0) rotate(10)" },
    });
  });
});

describe("preview", () => {
  it("evaluates calc expressions like the backend renderer", () => {
    expect(evaluateExpression("60 - arrow_length", { arrow_length: "25" })).toBe(35);
    expect(evaluateExpression("(a + 2) * 3 / 2", { a: "4" })).toBe(9);
    expect(evaluateExpression("10 / 0", {})).toBe(0);
    expect(evaluateExpression("missing * 2", {})).toBe(0);
    expect(evaluateExpression("2 +", {})).toBe(0);
    expect(evaluateExpression("-x", { x: "3" })).toBe(-3);
  });

  it("keeps unset text variables visible but fills geometry with numbers", () => {
    expect(fillPlaceholders("{{mass}} kg", {}, true)).toBe("{{mass}} kg");
    expect(fillPlaceholders("{{mass}} kg", { mass: "5" }, true)).toBe("5 kg");
    expect(fillPlaceholders("{{calc: 58 - len}}", { len: "8" }, false)).toBe("50");
  });

  it("leaves no placeholders in the force diagram's preview geometry", () => {
    const { document } = parseSvg(forceDiagramSource);
    const values = { up_force_length: "40", down_force_length: "30" };
    for (const element of document.elements.map((item) => previewElement(item, values))) {
      if (element.kind === "passthrough") continue;
      for (const value of Object.values(element.attrs)) {
        expect(value).not.toContain("{{");
      }
    }
  });
});
