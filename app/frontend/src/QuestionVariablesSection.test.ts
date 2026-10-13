import { describe, expect, it } from "vitest";

import { namesInText, questionVariableRows } from "./QuestionVariablesSection";
import type { AssetInspectionResponseModel, AssetModel } from "./types";

const inspection = (path: string, names: string[]): AssetInspectionResponseModel => ({
  path,
  kind: "svg",
  svg_placeholders: names,
  svg_inputs: names.map((name) => ({ name, units: name === "force" ? "N" : null })),
});

describe("question variable rows", () => {
  const assets: AssetModel[] = [
    { path: "assets/a.svg", kind: "svg", svg_variables: {} },
    { path: "assets/b.svg", kind: "svg", svg_variables: { label: "A" } },
  ];
  const inspections = [inspection("assets/a.svg", ["force", "angle"]), inspection("assets/b.svg", ["force", "label"])];

  it("lists the question's values and every drawing input, with who uses them", () => {
    const rows = questionVariableRows({ force: "40", unused: "1" }, assets, inspections);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(rows.map((row) => row.name)).toEqual(["force", "unused", "angle", "label"]);
    expect(byName.force).toMatchObject({ value: "40", usedBy: ["a.svg", "b.svg"], unsetIn: [] });
    expect(byName.force.info?.units).toBe("N");
    expect(byName.unused.usedBy).toEqual([]);
  });

  it("flags inputs nothing sets, and notes ones a drawing sets for itself", () => {
    const rows = Object.fromEntries(questionVariableRows({}, assets, inspections).map((row) => [row.name, row]));
    expect(rows.angle.unsetIn).toEqual(["a.svg"]);
    expect(rows.label.setIn).toEqual([{ file: "b.svg", value: "A" }]);
    expect(rows.label.unsetIn).toEqual([]);
  });
});

describe("variables used in the question's text", () => {
  it("finds names in placeholders and calc expressions", () => {
    expect(namesInText("A {{force}} N push; Fx = {{calc: round(force * cos(angle), 1)}}").sort()).toEqual(["angle", "cos", "force", "round"]);
  });

  it("lists where the question's variables are used, ignoring unknown names", () => {
    const rows = questionVariableRows({ force: "40" }, [], [], { prompt: "Push {{force}} N", "choice A": "{{calc: 2 * force}} and $\\frac{{a}}{b}$" });
    expect(rows.map((row) => [row.name, row.usedBy])).toEqual([["force", ["prompt", "choice A"]]]);
  });
});
