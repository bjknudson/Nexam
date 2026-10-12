import { describe, expect, it } from "vitest";

import { anchorPointPosition, anchorPointsFor, anchorSpotsNear, attachText, detachText, moveAnchoredText, relayoutAnchors } from "./anchors";
import { createControlFromDrag, setControlAttrs } from "./controls";
import { placeLabel, readableAngle, readLabelSettings, upNormal } from "./labelLayout";
import { previewElement } from "./preview";
import type { SceneDocument, SceneElement } from "./scene";
import { buildArrow, setLineLabel, translateElement } from "./shapes";
import { defaultStyle } from "./styles";
import { parseSvg, serializeSvg } from "./svgIO";

const style = defaultStyle();
const attrsOf = (element: SceneElement) => (element.kind === "passthrough" ? {} : element.attrs);
const children = (element: SceneElement) => (element.kind === "group" ? element.children : []);
const text = (key: string, value = "F"): SceneElement => ({
  key,
  kind: "text",
  attrs: { x: "0", y: "0", "font-size": "14", "font-family": "sans-serif", fill: "#000000" },
  text: value,
});
const at = (x: number, y: number) => ({ x: { a: x, b: 0 }, y: { a: y, b: 0 } });

describe("label placement", () => {
  it("treats up (or left, for upright shapes) as 'above', whichever way the shape points", () => {
    const plain = (v: { x: number; y: number }) => ({ x: v.x + 0, y: v.y + 0 });
    expect(plain(upNormal({ x: 1, y: 0 }))).toEqual({ x: 0, y: -1 });
    expect(plain(upNormal({ x: -1, y: 0 }))).toEqual({ x: 0, y: -1 });
    expect(plain(upNormal({ x: 0, y: 1 }))).toEqual({ x: -1, y: 0 });
  });

  it("never turns text upside down", () => {
    expect(readableAngle({ x: 1, y: 0 })).toBe(0);
    expect(readableAngle({ x: -1, y: 0 })).toBe(0);
    expect(readableAngle({ x: 0, y: 1 })).toBe(-90);
    expect(readableAngle({ x: -Math.SQRT1_2, y: -Math.SQRT1_2 })).toBe(45);
  });

  it("puts a middle label above a level line, and a tip label past the tip", () => {
    const settings = readLabelSettings({ "data-label-at": "mid" }, "data-label");
    const mid = placeLabel(at(50, 100), { x: 1, y: 0 }, settings);
    expect([mid.x.a, mid.y.a, mid.anchor, mid.rotate]).toEqual([50, 100 - (6 + 14 * 0.6), "middle", null]);
    const tip = placeLabel(at(100, 100), { x: 1, y: 0 }, readLabelSettings({}, "data-label"));
    expect([tip.x.a, tip.y.a, tip.anchor]).toEqual([106, 100, "start"]);
  });

  it("turns 'along' labels with the shape and offsets them in that frame", () => {
    const settings = readLabelSettings({ "data-label-at": "mid", "data-label-orient": "along", "data-label-dx": "10" }, "data-label");
    const place = placeLabel(at(0, 0), { x: 0, y: -1 }, settings);
    expect(place.rotate).toBe(-90);
    // dx of 10 along a label reading bottom-to-top moves it up the screen.
    expect(place.y.a).toBeCloseTo(-10);
  });
});

describe("built-in labels", () => {
  it("label a plain line by turning it into a line group, and back", () => {
    const line: SceneElement = { key: "l", kind: "line", attrs: { x1: "0", y1: "50", x2: "100", y2: "50", stroke: "#000000" } };
    const labeled = setLineLabel(line, "d = {{distance}}");
    expect(attrsOf(labeled)).toMatchObject({ "data-nexam-shape": "line", "data-heads": "none", "data-label": "d = {{distance}}" });
    expect(children(labeled).map((child) => child.kind)).toEqual(["line", "text"]);
    expect(setLineLabel(labeled, "")).toEqual({ ...line, attrs: { x1: "0", y1: "50", x2: "100", y2: "50", stroke: "#000000" } });
  });

  it("move with an arrow", () => {
    const arrow = buildArrow({ x: 0, y: 50 }, { x: 100, y: 50 }, "end", style);
    const labeled = setLineLabel(arrow, "F");
    const moved = translateElement(labeled, 10, 0)!;
    const label = children(moved).find((child) => child.kind === "text")!;
    expect(attrsOf(label).x).toBe("116");
  });

  it("follow a variable arrow's length at its middle, in every question version", () => {
    const control = createControlFromDrag("variable-arrow", { x: 50, y: 150 }, { x: 150, y: 150 }, style, [], 20)!.element;
    const labeled = setControlAttrs(control, { "data-label": "{{force}}", "data-label-at": "mid" });
    const label = children(labeled).find((child) => child.kind === "text")!;
    expect(attrsOf(label).x).toBe("{{calc: 50 + 0.5 * arrow_length}}");
    const preview = previewElement(labeled, { arrow_length: "80" });
    expect(attrsOf(children(preview).find((child) => child.kind === "text")!).x).toBe("90");
  });

  it("label a variable bar beside its middle, clear of its thickness", () => {
    const bar = createControlFromDrag("variable-bar", { x: 50, y: 150 }, { x: 50, y: 90 }, style, [], 20)!.element;
    const labeled = setControlAttrs(bar, { "data-label": "KE", "data-label-at": "mid" });
    const label = attrsOf(children(labeled)[1]);
    expect(label.x).toBe(String(50 - 10 - 6));
    expect(label["text-anchor"]).toBe("end");
  });
});

describe("attached texts", () => {
  it("follow a line they are attached to, and keep a dragged offset", () => {
    const line: SceneElement = { key: "l", kind: "line", attrs: { x1: "0", y1: "50", x2: "100", y2: "50", stroke: "#000000" } };
    let doc: SceneDocument = { rootAttrs: {}, elements: [line, text("t")] };
    const attached = attachText(doc, doc.elements[1], doc.elements[0], "mid");
    expect(attrsOf(attached.target).id).toBe("nexam-line-1");
    doc = { ...doc, elements: [attached.target, attached.text] };
    expect(attrsOf(doc.elements[1])).toMatchObject({ x: "50", y: String(50 - 6 - 14 * 0.6), "data-nexam-anchor": "nexam-line-1" });

    doc = relayoutAnchors({ ...doc, elements: [translateElement(doc.elements[0], 20, 10)!, moveAnchoredText(doc.elements[1], 0, -5)] });
    expect(attrsOf(doc.elements[1])).toMatchObject({ x: "70", y: String(60 - 6 - 14 * 0.6 - 5) });
  });

  it("attach to box edges", () => {
    const box: SceneElement = { key: "b", kind: "rect", attrs: { x: "10", y: "10", width: "40", height: "20" } };
    expect(anchorPointsFor(box).map((point) => point.value)).toEqual(["center", "top", "bottom", "left", "right", "here"]);
    const doc: SceneDocument = { rootAttrs: {}, elements: [box, text("t")] };
    const below = attachText(doc, doc.elements[1], box, "bottom").text;
    expect(attrsOf(below)).toMatchObject({ x: "30", "text-anchor": "middle" });
    const centre = attachText(doc, doc.elements[1], box, "center").text;
    expect(attrsOf(centre)).toMatchObject({ x: "30", y: "20" });
  });

  it("follow a variable arrow's tip with calc positions, and detach to numbers", () => {
    const control = createControlFromDrag("variable-arrow", { x: 50, y: 150 }, { x: 50, y: 100 }, style, [], 20)!.element;
    const doc: SceneDocument = { rootAttrs: {}, elements: [control, text("t", "{{force}} N")] };
    const attached = attachText(doc, doc.elements[1], control, "end").text;
    expect(attrsOf(attached).y).toBe("{{calc: 150 - (arrow_length + 14 * 0.6 + 6)}}".replace(/.*/, attrsOf(attached).y));
    expect(attrsOf(attached).y).toContain("arrow_length");
    const detached = detachText(attached, { arrow_length: "40" });
    expect(attrsOf(detached)["data-nexam-anchor"]).toBeUndefined();
    expect(attrsOf(detached).y).not.toContain("{{");
  });

  it("are not offered for variable-angle arrows (their direction isn't known)", () => {
    const control = createControlFromDrag("variable-arrow", { x: 50, y: 150 }, { x: 100, y: 150 }, style, [], 20)!.element;
    expect(anchorPointsFor(setControlAttrs(control, { "data-angle-variable": "arrow_angle" }))).toEqual([]);
  });

  it("round-trip through a saved file unchanged", () => {
    const line: SceneElement = { key: "l", kind: "line", attrs: { x1: "0", y1: "50", x2: "100", y2: "50" } };
    const doc: SceneDocument = { rootAttrs: { viewBox: "0 0 100 100" }, elements: [line, text("t")] };
    const attached = attachText(doc, doc.elements[1], line, "end");
    const svg = serializeSvg({ ...doc, elements: [attached.target, attached.text] });
    const reloaded = relayoutAnchors(parseSvg(svg).document);
    expect(serializeSvg(reloaded)).toBe(svg);
  });
});


describe("texts attached to stamps", () => {
  // A 40 x 20 stamp centred at (100, 100) (see transforms.ts).
  const stamp: SceneElement = {
    key: "s",
    kind: "group",
    attrs: {
      "data-nexam-stamp": "Block",
      "data-x": "100",
      "data-y": "100",
      "data-origin-x": "20",
      "data-origin-y": "10",
      "data-width": "40",
      "data-height": "20",
      "data-scale": "1",
      transform: "translate(100 100) translate(-20 -10)",
    },
    children: [],
  };

  it("offers the centre and edges, and sits below the stamp", () => {
    expect(anchorPointsFor(stamp).map((point) => point.value)).toEqual(["center", "top", "bottom", "left", "right", "here"]);
    const doc: SceneDocument = { rootAttrs: {}, elements: [stamp, text("t", "m = 2 kg")] };
    const { text: below, target } = attachText(doc, doc.elements[1], stamp, "bottom");
    expect(attrsOf(target).id).toBe("nexam-group-1");
    expect(attrsOf(below)).toMatchObject({ x: "100", "text-anchor": "middle" });
    expect(Number(attrsOf(below).y)).toBeGreaterThan(110);
  });

  it("follows the stamp as it moves, grows and turns", () => {
    const doc: SceneDocument = { rootAttrs: {}, elements: [stamp, text("t")] };
    const attached = attachText(doc, doc.elements[1], stamp, "right");
    const moved = {
      ...attached.target,
      attrs: { ...attrsOf(attached.target), "data-x": "150", "data-scale": "2", "data-rotation": "90" },
    } as SceneElement;
    const laidOut = relayoutAnchors({ rootAttrs: {}, elements: [moved, attached.text] });
    // Turned 90° clockwise, the stamp's right edge faces down: 40 * 2 / 2 = 40 below the centre.
    expect(attrsOf(laidOut.elements[1]).x).toBe("150");
    expect(Number(attrsOf(laidOut.elements[1]).y)).toBeGreaterThan(140);
  });

  it("offers groups placed before centred transforms (the editor converts them on attach)", () => {
    const legacy: SceneElement = { key: "g", kind: "group", attrs: { transform: "translate(5 5)" }, children: [] };
    expect(anchorPointsFor(legacy).map((point) => point.value)).toContain("bottom");
  });
});


describe('"Here": a position relative to the centre', () => {
  const stamp: SceneElement = {
    key: "s",
    kind: "group",
    attrs: {
      "data-x": "100",
      "data-y": "100",
      "data-origin-x": "20",
      "data-origin-y": "10",
      "data-width": "40",
      "data-height": "20",
      "data-scale": "1",
      transform: "translate(100 100) translate(-20 -10)",
    },
    children: [],
  };
  // A text 30 px to the right of the stamp's centre.
  const label = { ...text("t", "F"), attrs: { ...attrsOf(text("t", "F")), x: "130", y: "100", "text-anchor": "start" } } as SceneElement;
  const attached = attachText({ rootAttrs: {}, elements: [stamp, label] }, label, stamp, "here");
  const withStamp = (attrs: Record<string, string>) =>
    relayoutAnchors({ rootAttrs: {}, elements: [{ ...attached.target, attrs: { ...attrsOf(attached.target), ...attrs } } as SceneElement, attached.text] })
      .elements[1];
  const at = (element: SceneElement) => [Number(attrsOf(element).x), Number(attrsOf(element).y)];

  it("stays exactly where it was, keeping its own alignment", () => {
    expect(attrsOf(attached.text)).toMatchObject({ x: "130", y: "100", "text-anchor": "start", "data-anchor-ox": "30", "data-anchor-oy": "0" });
  });

  it("orbits the centre when the stamp turns, and scales with it", () => {
    // Turned 90° clockwise on screen, the right-hand side faces down.
    const [x, y] = at(withStamp({ "data-rotation": "90" }));
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(130);
    expect(at(withStamp({ "data-scale": "2" }))).toEqual([160, 100]);
    expect(at(withStamp({ "data-x": "150" }))).toEqual([180, 100]);
    expect(at(withStamp({ "data-flip-x": "true" }))).toEqual([70, 100]);
  });

  it("is dragged in the stamp's frame", () => {
    const turned = { ...attached.target, attrs: { ...attrsOf(attached.target), "data-rotation": "90" } } as SceneElement;
    // On screen, 10 px to the right is "up" in a frame turned 90° clockwise.
    const moved = moveAnchoredText(attached.text, 10, 0, turned);
    expect(attrsOf(moved)).toMatchObject({ "data-anchor-ox": "30", "data-anchor-oy": "-10" });
  });

  it("orbits a line's midpoint as the line turns, keeping its distance", () => {
    const line: SceneElement = { key: "l", kind: "line", attrs: { x1: "0", y1: "0", x2: "100", y2: "0" } };
    const above = { ...text("t2", "d"), attrs: { ...attrsOf(text("t2", "d")), x: "50", y: "-12" } } as SceneElement;
    const a = attachText({ rootAttrs: {}, elements: [line, above] }, above, line, "here");
    // Turn the line to point straight down, and make it longer.
    const turnedLine = { ...a.target, attrs: { ...attrsOf(a.target), x2: "0", y2: "200" } } as SceneElement;
    const result = relayoutAnchors({ rootAttrs: {}, elements: [turnedLine, a.text] }).elements[1];
    const [x, y] = at(result);
    expect(x).toBeCloseTo(12);
    expect(y).toBeCloseTo(100);
  });

  it("is not offered for variable controls", () => {
    const control = createControlFromDrag("variable-arrow", { x: 0, y: 0 }, { x: 50, y: 0 }, style, [], 20)!.element;
    expect(anchorPointsFor(control).map((point) => point.value)).not.toContain("here");
  });
});

describe("dragging a text onto an anchor point", () => {
  const line: SceneElement = { key: "l", kind: "line", attrs: { x1: "0", y1: "50", x2: "100", y2: "50" } };
  const box: SceneElement = { key: "b", kind: "rect", attrs: { x: "150", y: "10", width: "40", height: "20" } };

  it("finds the anchor points near the pointer, nearest first, without Here", () => {
    const spots = anchorSpotsNear([line, box, text("t")], text("t"), { x: 96, y: 48 }, 70, {});
    expect(spots.map((spot) => [spot.target.key, spot.point])).toEqual([
      ["l", "end"],
      ["l", "mid"],
      ["b", "left"],
    ]);
    expect(spots[0].distance).toBeCloseTo(Math.hypot(4, 2));
    expect(spots.some((spot) => spot.point === "here")).toBe(false);
  });

  it("never offers the text itself or other texts", () => {
    expect(anchorSpotsNear([text("t"), text("u")], text("t"), { x: 0, y: 0 }, 1000, {})).toEqual([]);
  });

  it("works out a variable arrow's tip from the preview values", () => {
    const control = createControlFromDrag("variable-arrow", { x: 50, y: 150 }, { x: 50, y: 100 }, style, [], 20)!.element;
    const variable = attrsOf(control)["data-variable"];
    const tip = anchorPointPosition(control, "end", { [variable]: "30" });
    expect(tip?.x).toBeCloseTo(50);
    expect(tip?.y).toBeLessThan(150);
    const longer = anchorPointPosition(control, "end", { [variable]: "60" });
    expect(longer!.y).toBeLessThan(tip!.y);
    expect(anchorPointPosition(control, "start", { [variable]: "60" })).toEqual({ x: 50, y: 150 });
  });

  it("follows a stamp's rotation", () => {
    const stamp: SceneElement = {
      key: "s",
      kind: "group",
      attrs: { "data-x": "100", "data-y": "100", "data-origin-x": "20", "data-origin-y": "10", "data-width": "40", "data-height": "20", "data-rotation": "90" },
      children: [],
    };
    const right = anchorPointPosition(stamp, "right", {});
    expect(right?.x).toBeCloseTo(100);
    expect(right?.y).toBeCloseTo(120);
  });
});
