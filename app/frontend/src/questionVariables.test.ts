import { describe, expect, it } from "vitest";

import { parseSvg } from "./drawing/svgIO";
import { drawingInputSamples, fillQuestionText, hasQuestionPlaceholders, resolveAssetVariables, withSeededVariables } from "./questionVariables";
import type { QuestionModel } from "./types";

describe("resolveAssetVariables", () => {
  const question = { force: "40", angle: "30" };

  it("takes the question's variables by name, with attachment values winning", () => {
    expect(resolveAssetVariables(question, {})).toEqual(question);
    expect(resolveAssetVariables(question, { angle: "45" }).angle).toBe("45");
    expect(resolveAssetVariables(question, { angle: " " }).angle).toBe("30");
    expect(resolveAssetVariables(undefined, { mass: "2" })).toEqual({ mass: "2" });
  });

  it("lets an attachment refer to the question's variables", () => {
    const values = resolveAssetVariables(question, { arrow_length: "{{force}}", double: "{{calc: 2 * force}}" });
    expect(values.arrow_length).toBe("40");
    expect(values.double).toBe("80");
  });
});

describe("adding a saved drawing's new inputs to its question", () => {
  const question = {
    id: "q",
    type: "free_response",
    topic: "t",
    difficulty: 1,
    prompt: "p",
    tags: [],
    standards: [],
    status: "draft",
    rubric: [],
    assets: [{ path: "assets/f.svg", kind: "svg", svg_variables: { label: "A" } }],
    variables: { force: "40" },
  } as QuestionModel;

  it("adds only inputs nothing sets yet, with their samples", () => {
    const seeded = withSeededVariables(question, "assets/f.svg", { force: "10", label: "B", mass: "2" });
    expect(seeded?.variables).toEqual({ force: "40", mass: "2" });
    expect(withSeededVariables(question, "assets/f.svg", { force: "10" })).toBeNull();
    expect(withSeededVariables(question, "assets/other.svg", { mass: "2" })).toBeNull();
  });

  it("reads a drawing's inputs and samples, leaving out derived variables", () => {
    const { document } = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" data-nexam-preview="angle=30; mass=2">' +
        '<metadata id="nexam-variables">{"variables": [{"name": "force", "sample": "40"}, {"name": "Fx", "formula": "force * cos(angle)"}]}</metadata>' +
        "<text>{{Fx}} {{angle}} {{mass}}</text></svg>",
    );
    expect(drawingInputSamples(document)).toEqual({ force: "40", angle: "30", mass: "2" });
  });
});

describe("question text with variables", () => {
  const variables = { force: "40", angle: "30" };

  it("fills known names and every calc, leaving the rest as typed", () => {
    expect(fillQuestionText("A {{force}} N force at {{angle}}°", variables)).toBe("A 40 N force at 30°");
    expect(fillQuestionText("{{calc: round(force * cos(angle), 1)}} N", variables)).toBe("34.6 N");
    expect(fillQuestionText("{{calc: sig(force / 3, 3)}}", variables)).toBe("13.3");
    expect(fillQuestionText("{{mass}} kg, $\\frac{{a}}{b}$", variables)).toBe("{{mass}} kg, $\\frac{{a}}{b}$");
    expect(fillQuestionText("{{force}}", undefined)).toBe("{{force}}");
  });

  it("says when there is something to fill", () => {
    expect(hasQuestionPlaceholders("Push {{force}} N", variables)).toBe(true);
    expect(hasQuestionPlaceholders("Push {{mass}} kg", variables)).toBe(false);
    expect(hasQuestionPlaceholders("Push {{force}} N", undefined)).toBe(false);
  });
});
