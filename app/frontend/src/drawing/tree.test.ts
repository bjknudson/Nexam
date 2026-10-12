import { describe, expect, it } from "vitest";

import { createControlFromDrag } from "./controls";
import type { SceneDocument, SceneElement } from "./scene";
import { readGroupTransform, writeGroupTransform } from "./transforms";
import { buildArrow } from "./shapes";
import { BUILT_IN_STAMPS, createStampElement } from "./stamps";
import { defaultStyle } from "./styles";
import { parseSvg, serializeSvg } from "./svgIO";
import {
  canEnterGroup,
  carryInto,
  lockedKeys,
  moveBetweenGroups,
  toggleLock,
  describeElement,
  groupElements,
  moveInFrontOf,
  reorderElements,
  replaceInScope,
  scopeElements,
  scopeOf,
  ungroupElement,
  validScope,
} from "./tree";

const attrsOf = (element: SceneElement) => (element.kind === "passthrough" ? {} : element.attrs);
const children = (element: SceneElement) => (element.kind === "group" ? element.children : []);

const rect = (key: string, x = 0): SceneElement => ({
  key,
  kind: "rect",
  attrs: { x: String(x), y: "0", width: "10", height: "10" },
});
const keys = (elements: SceneElement[]) => elements.map((element) => element.key);

describe("layer order", () => {
  const list = ["a", "b", "c", "d", "e"].map((key) => rect(key));

  it("brings to front and sends to back, keeping relative order", () => {
    expect(keys(reorderElements(list, new Set(["b", "d"]), "front"))).toEqual(["a", "c", "e", "b", "d"]);
    expect(keys(reorderElements(list, new Set(["b", "d"]), "back"))).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("steps forward and backward past one neighbour", () => {
    expect(keys(reorderElements(list, new Set(["b"]), "forward"))).toEqual(["a", "c", "b", "d", "e"]);
    expect(keys(reorderElements(list, new Set(["d", "e"]), "forward"))).toEqual(["a", "b", "c", "d", "e"]);
    expect(keys(reorderElements(list, new Set(["b", "c"]), "backward"))).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("moves one element just in front of another for the Layers panel", () => {
    expect(keys(moveInFrontOf(list, "a", "c"))).toEqual(["b", "c", "a", "d", "e"]);
    expect(keys(moveInFrontOf(list, "e", "a"))).toEqual(["a", "e", "b", "c", "d"]);
  });
});

describe("grouping", () => {
  it("groups in place of the topmost selected element and ungroups back", () => {
    const list = ["a", "b", "c", "d"].map((key) => rect(key));
    const grouped = groupElements(list, new Set(["a", "c"]))!;
    expect(grouped.elements.map((element) => (element === grouped.group ? "G" : element.key))).toEqual(["b", "G", "d"]);
    expect(grouped.group.kind === "group" && keys(grouped.group.children)).toEqual(["a", "c"]);

    const back = ungroupElement(grouped.elements, grouped.group.key)!;
    expect(keys(back.elements)).toEqual(["b", "a", "c", "d"]);
    expect(back.childKeys).toEqual(["a", "c"]);
    expect(back.converted).toBeNull();
  });

  it("folds a moved stamp's translate into its children and keeps inherited styles", () => {
    const stamp: SceneElement = {
      key: "s",
      kind: "group",
      attrs: { "data-nexam-stamp": "Box", transform: "translate(20 30)", stroke: "#808080" },
      children: [rect("r", 5), { key: "t", kind: "rect", attrs: { x: "0", y: "0", width: "1", height: "1", stroke: "#000000" } }],
    };
    const { elements } = ungroupElement([stamp], "s")!;
    expect(elements[0].kind !== "passthrough" && elements[0].attrs).toMatchObject({ x: "25", y: "30", stroke: "#808080" });
    expect(elements[1].kind !== "passthrough" && elements[1].attrs.stroke).toBe("#000000");
  });

  it("keeps a scaled group's transform on each child so nothing moves", () => {
    const stamp = createStampElement(BUILT_IN_STAMPS[0], { x: 100, y: 100 }, { width: 50, height: 30 });
    const transform = stamp.kind === "group" ? stamp.attrs.transform : "";
    expect(transform).toContain("scale(");
    const { elements } = ungroupElement([stamp], stamp.key)!;
    expect(elements[0].kind !== "passthrough" && elements[0].attrs.transform).toBe(transform);
  });

  it("says when a control is turned into plain shapes", () => {
    const control = createControlFromDrag("variable-bar", { x: 0, y: 50 }, { x: 0, y: 10 }, defaultStyle(), [], 10)!.element;
    expect(ungroupElement([control], control.key)!.converted).toBe("variable bar");
    const arrow = buildArrow({ x: 0, y: 0 }, { x: 40, y: 0 }, "end", defaultStyle());
    const result = ungroupElement([arrow], arrow.key)!;
    expect(result.converted).toBe("arrow");
    expect(result.elements.map((element) => element.kind)).toEqual(["line", "polygon"]);
  });

  it("wraps passthrough markup instead of losing the group's transform", () => {
    const { document } = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(5 5)"><path d="M0 0 L5 5"/></g></svg>',
    );
    const { elements } = ungroupElement(document.elements, document.elements[0].key)!;
    expect(serializeSvg({ rootAttrs: {}, elements })).toContain('<g transform="translate(5 5)">');
  });
});

describe("scopes", () => {
  const stamp = createStampElement(BUILT_IN_STAMPS[3], { x: 50, y: 50 }, { width: 318, height: 200 });
  const arrow = buildArrow({ x: 0, y: 0 }, { x: 40, y: 0 }, "end", defaultStyle());
  const doc: SceneDocument = { rootAttrs: {}, elements: [rect("a"), stamp, arrow] };
  const firstChild = stamp.kind === "group" ? stamp.children[0] : stamp;

  it("enters stamps and plain groups but not arrows or controls", () => {
    expect(canEnterGroup(stamp)).toBe(true);
    expect(canEnterGroup(arrow)).toBe(false);
    expect(scopeElements(doc, [stamp.key])).toBe(stamp.kind === "group" ? stamp.children : []);
    expect(scopeOf(doc, firstChild.key)).toEqual([stamp.key]);
    expect(scopeOf(doc, "a")).toEqual([]);
  });

  it("edits inside a scope without touching the rest", () => {
    const moved = { ...firstChild, attrs: { ...(firstChild.kind !== "passthrough" ? firstChild.attrs : {}), x1: "99" } } as SceneElement;
    const next = replaceInScope(doc, [stamp.key], firstChild.key, moved);
    expect(scopeElements(next, [stamp.key])[0]).toBe(moved);
    expect(next.elements[0]).toBe(doc.elements[0]);
  });

  it("drops scope levels that no longer exist", () => {
    expect(validScope(doc, [stamp.key, "gone"])).toEqual([stamp.key]);
    expect(validScope(doc, [arrow.key])).toEqual([]);
  });

  it("names elements for the Layers panel", () => {
    expect(describeElement(stamp)).toBe("Pulley");
    expect(describeElement(arrow)).toBe("Arrow");
    expect(describeElement({ key: "t", kind: "text", attrs: {}, text: "F = {{force}} N" })).toBe("Text “F = {{force}} N”");
  });
});

describe("moving between groups", () => {
  const box = (key: string, x: number): SceneElement => ({ key, kind: "rect", attrs: { x: String(x), y: "0", width: "10", height: "10" } });
  const groupAt = (key: string, transform: string | null, children: SceneElement[]): SceneElement => ({
    key,
    kind: "group",
    attrs: { "data-nexam-group": "true", ...(transform ? { transform } : {}) },
    children,
  });
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  it("moves a shape into a shifted group without moving it on the canvas", () => {
    // The group is drawn 50 px right, so its coordinates are 50 less.
    const doc: SceneDocument = { rootAttrs: {}, elements: [groupAt("g", "translate(50 0)", [box("a", 0)]), box("b", 80)] };
    const result = moveBetweenGroups(doc, "b", [], ["g"], "a", { ...identity, e: -50 })!;
    expect(result.document.elements.map((element) => element.key)).toEqual(["g"]);
    expect(children(result.document.elements[0]).map((element) => [element.key, attrsOf(element).x])).toEqual([
      ["a", "0"],
      ["b", "30"],
    ]);
  });

  it("moves a shape out to the top of the drawing, and never into itself", () => {
    const doc: SceneDocument = { rootAttrs: {}, elements: [groupAt("g", "translate(50 0)", [box("a", 0)]), box("b", 80)] };
    const out = moveBetweenGroups(doc, "a", ["g"], [], null, { ...identity, e: 50 })!;
    expect(out.document.elements.map((element) => element.key)).toEqual(["g", "b", "a"]);
    expect(attrsOf(out.document.elements[2]).x).toBe("50");
    expect(moveBetweenGroups(doc, "g", [], ["g"], null, identity)).toBeNull();
  });

  it("re-places a stamp inside a turned group so it's drawn where it was", () => {
    const stamp = writeGroupTransform(
      { key: "s", kind: "group", attrs: { "data-nexam-stamp": "Block" }, children: [box("r", 0)] },
      { cx: 100, cy: 50, rotation: 30, scale: 2, ox: 5, oy: 5, width: 10, height: 10 },
    );
    // Into a group turned 90° about the origin: its coordinates are the canvas turned back by 90°.
    const back = { a: 0, b: -1, c: 1, d: 0, e: 0, f: 0 };
    const carried = carryInto(stamp, back);
    const tf = readGroupTransform(carried)!;
    expect(tf.cx).toBeCloseTo(50);
    expect(tf.cy).toBeCloseTo(-100);
    expect(tf.rotation).toBeCloseTo(-60);
    expect(tf.scale).toBeCloseTo(2);
    expect(carried.key).toBe("s");
  });

  it("wraps anything else in a group carrying the turn", () => {
    const carried = carryInto(box("a", 0), { a: 0, b: -1, c: 1, d: 0, e: 3, f: 4 });
    expect(carried.kind).toBe("group");
    expect(attrsOf(carried).transform).toBe("matrix(0 -1 1 0 3 4)");
    expect(children(carried)[0].key).toBe("a");
  });
});

describe("locking", () => {
  it("is saved on the element and toggles off again", () => {
    const doc: SceneDocument = { rootAttrs: {}, elements: [{ key: "a", kind: "rect", attrs: { x: "0" } }] };
    const locked = toggleLock(doc, "a");
    expect(attrsOf(locked.elements[0])["data-nexam-locked"]).toBe("true");
    expect(lockedKeys(locked)).toEqual(new Set(["a"]));
    expect(attrsOf(toggleLock(locked, "a").elements[0])["data-nexam-locked"]).toBeUndefined();
  });
});
