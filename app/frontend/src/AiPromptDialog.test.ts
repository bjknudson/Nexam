import { describe, expect, it } from "vitest";

import { buildPromptTemplate, changesQuestions, offeredOptions } from "./AiPromptDialog";

describe("AI prompts", () => {
  it("leave a placeholder with example requests when nothing is chosen", () => {
    expect(buildPromptTemplate("question")).toContain('Instructions: <describe the change you want here, for example "Make a new version with different values"');
    expect(buildPromptTemplate("test")).toContain('"Order the items from easiest to hardest"');
  });

  it("turn ticked requests and the teacher's own words into the instructions", () => {
    const prompt = buildPromptTemplate("test", { testHasQuestions: true }, {
      options: ["change-order", "same-difficulty", "same-standards"],
      custom: "Make it a little easier",
    });
    expect(prompt).toContain(
      [
        "Instructions:",
        "- Change the order of the questions (shuffle them, keeping sections together).",
        "- Keep each question's difficulty level the same as the one it replaces.",
        "- Keep the same standards distribution: each question covers the same standards as the one it replaces.",
        "- Make it a little easier",
      ].join("\n"),
    );
    expect(prompt).not.toContain("<describe the change");
    expect(buildPromptTemplate("question", {}, { options: [], custom: "Use a skateboard" })).toContain("Instructions: Use a skateboard");
  });

  it("explain math in $…$ and doubled backslashes in JSON, for both", () => {
    for (const kind of ["question", "test"] as const) {
      const prompt = buildPromptTemplate(kind);
      expect(prompt).toContain("Never leave a LaTeX command such as \\ln, \\frac or \\theta outside $...$.");
      expect(prompt).toContain('write "$\\\\frac{1}{2}$"');
    }
  });

  it("explain variables only when they are used or asked for, and offer that request only then", () => {
    expect(buildPromptTemplate("question")).not.toContain("Variables:");
    expect(buildPromptTemplate("question", { usesVariables: true })).toContain("{{calc: round(force * cos(angle), 1)}}");
    expect(offeredOptions("question", {}).map((option) => option.id)).not.toContain("new-values");
    expect(offeredOptions("test", { usesVariables: true }).map((option) => option.id)).toContain("new-values");
  });

  it("tell the AI what a test's JSON applies", () => {
    expect(buildPromptTemplate("test", { testHasQuestions: false })).toContain("are created in the bank and added to the test in order");
    expect(buildPromptTemplate("test", { testHasQuestions: true })).toContain('Change the "test" object only.');
    // Requests that change questions ask for every question back, ids kept.
    const version = buildPromptTemplate("test", { testHasQuestions: true }, { options: ["new-version", "new-questions"], custom: "" });
    expect(version).toContain("Keep each question's \"id\" as it is, even when you rewrite it");
    expect(changesQuestions({ options: ["change-order"], custom: "" })).toBe(false);
    expect(changesQuestions({ options: ["new-questions"], custom: "" })).toBe(true);
  });
});
