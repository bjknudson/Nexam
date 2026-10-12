/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

import forceDiagramSource from "../../../../samples/demo-bank/assets/sample-force-diagram.svg?raw";
import templateSource from "../../../../samples/demo-bank/assets/sample-svg-template.svg?raw";
import { listVariables, literalNumber, type SceneElement } from "./scene";
import { parseSvg, serializeSvg } from "./svgIO";

const SAMPLES = {
  "sample-force-diagram.svg": forceDiagramSource,
  "sample-svg-template.svg": templateSource,
};

const PLACEHOLDER = /\{\{[^}]+\}\}/g;

/** Scene elements without editor-only keys, so two parses can be compared. */
function stripKeys(elements: SceneElement[]): unknown[] {
  return elements.map((element) => {
    const { key: _key, ...rest } = element;
    return element.kind === "group" ? { ...rest, children: stripKeys(element.children) } : rest;
  });
}

describe.each(Object.entries(SAMPLES))("round trip of %s", (_name, source) => {
  it("keeps every placeholder exactly as written", () => {
    const output = serializeSvg(parseSvg(source).document);
    expect(output.match(PLACEHOLDER)).toEqual(source.match(PLACEHOLDER));
  });

  it("keeps the root size and viewBox", () => {
    const { rootAttrs } = parseSvg(source).document;
    const reparsed = parseSvg(serializeSvg(parseSvg(source).document)).document.rootAttrs;
    expect(reparsed).toEqual(rootAttrs);
    expect(rootAttrs.viewBox).toBeDefined();
  });

  it("is stable: saving a saved file changes nothing", () => {
    const once = serializeSvg(parseSvg(source).document);
    const twice = serializeSvg(parseSvg(once).document);
    expect(twice).toBe(once);
    expect(stripKeys(parseSvg(once).document.elements)).toEqual(
      stripKeys(parseSvg(source).document.elements),
    );
  });
});

describe("parseSvg", () => {
  it("reads the force diagram's shapes and variables", () => {
    const { document, passthroughTags } = parseSvg(forceDiagramSource);
    expect(document.elements.map((element) => element.kind)).toEqual([
      "rect",
      "text",
      "line",
      "polygon",
      "text",
      "line",
      "polygon",
      "text",
    ]);
    expect(passthroughTags).toEqual([]);
    expect(listVariables(document)).toEqual([
      "object_label",
      "up_force_length",
      "up_force",
      "down_force_length",
      "down_force",
    ]);
  });

  it("keeps unsupported markup untouched and reports it", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<path d="M0 0 L10 10" stroke="#000"/></svg>';
    const { document, passthroughTags } = parseSvg(source);
    expect(passthroughTags).toEqual(["path"]);
    expect(serializeSvg(document)).toContain('<path d="M0 0 L10 10" stroke="#000"/>');
    expect(serializeSvg(document)).not.toContain('<path xmlns=');
  });

  it("keeps groups and their children", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<g data-nexam-control="variable-arrow"><line x1="0" y1="0" x2="5" y2="5"/></g></svg>';
    const [group] = parseSvg(source).document.elements;
    expect(group.kind).toBe("group");
    if (group.kind !== "group") return;
    expect(group.attrs["data-nexam-control"]).toBe("variable-arrow");
    expect(group.children.map((child) => child.kind)).toEqual(["line"]);
  });

  it("rejects files that are not SVG", () => {
    expect(() => parseSvg("<html><body/></html>")).toThrow("not a readable SVG");
    expect(() => parseSvg("not markup at all")).toThrow("not a readable SVG");
  });
});

describe("serializeSvg", () => {
  it("escapes text and attribute values", () => {
    const output = serializeSvg({
      rootAttrs: { viewBox: "0 0 10 10" },
      elements: [{ key: "t", kind: "text", attrs: { "data-note": 'say "hi"' }, text: "a < b & c" }],
    });
    expect(output).toContain('data-note="say &quot;hi&quot;"');
    expect(output).toContain(">a &lt; b &amp; c</text>");
    expect(parseSvg(output).document.elements[0]).toMatchObject({ text: "a < b & c" });
  });
});

describe("literalNumber", () => {
  it("only returns numbers the editor can safely drag", () => {
    expect(literalNumber("12.5")).toBe(12.5);
    expect(literalNumber("{{calc: 60 - arrow_length}}")).toBeNull();
    expect(literalNumber("50%")).toBeNull();
    expect(literalNumber("")).toBeNull();
    expect(literalNumber(undefined)).toBeNull();
  });
});
