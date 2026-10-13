// The demo bank's drawings (built by scripts/demo-drawings.ts) open in the
// editor and save back unchanged, so a teacher can edit them.

/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

import { relayoutAnchors } from "./anchors";
import { parseSvg, serializeSvg } from "./svgIO";
import { withDerived } from "./variables";

const sources = Object.fromEntries(
  Object.entries(
    import.meta.glob("../../../../samples/demo-bank/assets/*.svg", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  ).map(([path, source]) => [path.split("/").pop() ?? path, source]),
);
const files = Object.keys(sources).filter((name) => !name.startsWith("sample-"));

describe("demo bank drawings", () => {
  it("exist", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files)("%s opens and saves back unchanged", (name: string) => {
    const source = sources[name];
    const { document, passthroughTags } = parseSvg(source);
    expect(passthroughTags).toEqual([]);
    expect(serializeSvg(relayoutAnchors(document))).toBe(source);
  });

  it("work out their derived values", () => {
    const { document } = parseSvg(sources["force-components.svg"]);
    expect(withDerived(document, { force: "50", angle: "37" })).toMatchObject({ Fx: "39.9", Fy: "30.1" });
  });
});
