import { describe, expect, it } from "vitest";

import { assetUsesIn, swapAssetPath } from "./assetSwap";
import type { QuestionModel } from "./types";

const question = {
  id: "q_mc_0001",
  assets: [
    { path: "assets/fig.svg", kind: "svg", svg_variables: { label: "A" } },
    { path: "assets/other.svg", kind: "svg", svg_variables: {} },
  ],
  answer: {
    choices: ["one", "two"],
    correct_choice_index: 0,
    choice_assets: { "1": { path: "assets/fig.svg", kind: "svg", svg_variables: { label: "B" } } },
  },
} as unknown as QuestionModel;

describe("assetSwap", () => {
  it("finds an asset in attached figures and answer-choice images", () => {
    expect(assetUsesIn(question, "assets/fig.svg").map((use) => use.svg_variables.label)).toEqual(["A", "B"]);
    expect(assetUsesIn(question, "assets/none.svg")).toEqual([]);
  });

  it("points every use at the copy and keeps each use's variables", () => {
    const swapped = swapAssetPath(question, "assets/fig.svg", "assets/fig-1.svg");
    expect(swapped.assets.map((asset) => asset.path)).toEqual(["assets/fig-1.svg", "assets/other.svg"]);
    expect(assetUsesIn(swapped, "assets/fig-1.svg").map((use) => use.svg_variables.label)).toEqual(["A", "B"]);
    expect(assetUsesIn(swapped, "assets/fig.svg")).toEqual([]);
    // The original question object is untouched.
    expect(question.assets[0].path).toBe("assets/fig.svg");
  });
});
