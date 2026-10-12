import { describe, expect, it } from "vitest";

import { NO_FILTERS, filterAssets, matchAsset } from "./assetSearch";
import type { AssetListItemModel } from "./types";

const pulley: AssetListItemModel = {
  path: "assets/fig-1.svg",
  kind: "svg",
  referenced_by: ["q_fr_0001"],
  svg_placeholders: ["force"],
  search_terms: ["Pulley", "Normal force", "variable arrow"],
  topics: ["Mechanics"],
  tags: ["free-body"],
  modified: 200,
};
const photo: AssetListItemModel = { path: "assets/lab-photo.png", kind: "image", referenced_by: [], svg_placeholders: [], modified: 100 };

describe("matchAsset", () => {
  it("finds a drawing by what is in it, and says why", () => {
    expect(matchAsset(pulley, "pull")?.reason).toBe("“Pulley”");
    expect(matchAsset(pulley, "normal forces")?.reason).toBe("“Normal force”");
    expect(matchAsset(pulley, "mechanics")?.reason).toBe("topic: Mechanics");
    expect(matchAsset(pulley, "free body")?.reason).toBe("tag: free-body");
  });

  it("gives no reason when the name matches", () => {
    expect(matchAsset(pulley, "fig")).toEqual({ asset: pulley, reason: null });
  });

  it("needs every word to match", () => {
    expect(matchAsset(pulley, "pulley spring")).toBeNull();
  });
});

describe("filterAssets", () => {
  it("filters by kind, use and topic, and sorts", () => {
    const names = (query: string, filters = NO_FILTERS, sort: "name" | "recent" | "uses" = "name") =>
      filterAssets([photo, pulley], query, filters, ["assets/fig-1.svg"], sort).map((match) => match.asset.path);
    expect(names("")).toEqual(["assets/fig-1.svg", "assets/lab-photo.png"]);
    expect(names("", { ...NO_FILTERS, kind: "image" })).toEqual(["assets/lab-photo.png"]);
    expect(names("", { ...NO_FILTERS, unusedOnly: true })).toEqual(["assets/lab-photo.png"]);
    expect(names("", { ...NO_FILTERS, onQuestionOnly: true })).toEqual(["assets/fig-1.svg"]);
    expect(names("", { ...NO_FILTERS, topic: "mechanics" })).toEqual(["assets/fig-1.svg"]);
    expect(names("", NO_FILTERS, "recent")).toEqual(["assets/fig-1.svg", "assets/lab-photo.png"]);
  });
});
