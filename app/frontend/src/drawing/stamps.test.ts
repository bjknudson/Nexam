import { describe, expect, it } from "vitest";

import { groupScale, setGroupScale, translateElement } from "./shapes";
import type { SceneElement } from "./scene";
import { BUILT_IN_STAMPS, checkStampFile, createStampElement, groupByCategory, stampThumbnailUrl, type Stamp } from "./stamps";
import { parseSvg, serializeSvg } from "./svgIO";

describe("built-in stamps", () => {
  it("are all loaded, in display order", () => {
    expect(BUILT_IN_STAMPS.map((stamp) => stamp.name)).toEqual([
      "Block",
      "Cart",
      "Hanging mass",
      "Pulley",
      "Spring",
      "Incline",
      "Ground",
      "Ceiling",
      "Axes",
      "Resistor",
      "Battery",
      "Bulb",
    ]);
    expect(groupByCategory(BUILT_IN_STAMPS).map(([category]) => category)).toEqual(["Mechanics", "Graphs", "Circuits"]);
  });

  it.each(BUILT_IN_STAMPS.map((stamp) => [stamp.name, stamp] as const))(
    "%s uses only shapes the editor can edit, and round-trips",
    (_name, stamp) => {
      const { document, passthroughTags } = parseSvg(stamp.svg);
      expect(passthroughTags).toEqual([]);
      expect(document.rootAttrs.viewBox).toBeDefined();
      const once = serializeSvg(document);
      expect(serializeSvg(parseSvg(once).document)).toBe(once);
      expect(stampThumbnailUrl(stamp).startsWith("data:image/svg+xml")).toBe(true);
    },
  );
});

const pulley = BUILT_IN_STAMPS.find((stamp) => stamp.name === "Pulley")!;

describe("createStampElement", () => {
  it("centers the stamp on the drop point at full size when it fits", () => {
    const element = createStampElement(pulley, { x: 100, y: 100 }, { width: 318, height: 200 });
    expect(element.kind).toBe("group");
    if (element.kind !== "group") return;
    // The pulley stamp is 44 x 60, placed by its centre.
    expect(element.attrs.transform).toBe("translate(100 100) translate(-22 -30)");
    expect(element.attrs).toMatchObject({ "data-x": "100", "data-y": "100", "data-width": "44", "data-height": "60" });
    expect(element.attrs["data-nexam-stamp"]).toBe("Pulley");
    expect(element.children.length).toBe(parseSvg(pulley.svg).document.elements.length);
  });

  it("shrinks a stamp that is bigger than the canvas", () => {
    const axes = BUILT_IN_STAMPS.find((stamp) => stamp.name === "Axes")!;
    const element = createStampElement(axes, { x: 67, y: 48 }, { width: 134, height: 96 });
    expect(groupScale(element)).toBeCloseTo(0.59, 2);
  });

  it("keeps root styles the stamp's shapes inherit", () => {
    const stamp: Stamp = {
      id: "t",
      name: "Gray box",
      category: "Test",
      source: "mine",
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" stroke="#808080" fill="none"><rect width="10" height="10"/></svg>',
    };
    const element = createStampElement(stamp, { x: 5, y: 5 }, { width: 100, height: 100 });
    expect(element.kind === "group" && element.attrs).toMatchObject({ stroke: "#808080", fill: "none" });
  });
});

describe("stamp size", () => {
  it("changes the scale about the centre, and still moves", () => {
    const element = createStampElement(pulley, { x: 100, y: 100 }, { width: 318, height: 200 });
    const bigger = setGroupScale(element, 1.5);
    expect(bigger.kind === "group" && bigger.attrs.transform).toBe("translate(100 100) scale(1.5) translate(-22 -30)");
    expect(groupScale(bigger)).toBe(1.5);
    const moved = translateElement(bigger, 10, 10)!;
    expect(moved.kind === "group" && moved.attrs.transform).toBe("translate(110 110) scale(1.5) translate(-22 -30)");
  });

  it("still sizes a stamp placed before centred transforms", () => {
    const legacy: SceneElement = { key: "l", kind: "group", attrs: { "data-nexam-stamp": "Old", transform: "translate(78 70)" }, children: [] };
    expect(setGroupScale(legacy, 2).kind === "group" && setGroupScale(legacy, 2)).toMatchObject({ attrs: { transform: "translate(78 70) scale(2)" } });
  });
});

describe("checkStampFile", () => {
  it("flags parts that can't be edited and rejects non-SVG", () => {
    expect(checkStampFile('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')).toEqual({
      ok: true,
      passthroughTags: ["path"],
    });
    expect(checkStampFile("<html/>").ok).toBe(false);
  });
});

describe("currentColor stamps", () => {
  it("print black unless the stamp sets its own color", () => {
    const stamp: Stamp = {
      id: "c",
      name: "Disk",
      category: "Mechanics",
      source: "mine",
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" stroke="currentColor" fill="none"/></svg>',
    };
    const element = createStampElement(stamp, { x: 5, y: 5 }, { width: 100, height: 100 });
    expect(element.kind === "group" && element.attrs.color).toBe("#000000");
    const gray = createStampElement({ ...stamp, svg: stamp.svg.replace("<svg ", '<svg color="#808080" ') }, { x: 5, y: 5 }, { width: 100, height: 100 });
    expect(gray.kind === "group" && gray.attrs.color).toBe("#808080");
  });
});
