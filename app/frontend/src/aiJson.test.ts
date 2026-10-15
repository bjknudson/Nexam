import { describe, expect, it } from "vitest";

import { parseAiJson } from "./aiJson";

describe("parseAiJson", () => {
  it("reads plain JSON, fenced JSON and JSON with a sentence around it", () => {
    expect(parseAiJson('{"test": {"title": "Quiz"}}')).toEqual({ value: { test: { title: "Quiz" } } });
    expect(parseAiJson('Here you go:\n```json\n{"questions": []}\n```\nLet me know!')).toEqual({ value: { questions: [] } });
    expect(parseAiJson('Sure! {"a": 1} Hope that helps.')).toEqual({ value: { a: 1 } });
  });

  it("treats a bare array as the questions", () => {
    expect(parseAiJson('[{"prompt": "Hi"}]')).toEqual({ value: { questions: [{ prompt: "Hi" }] } });
  });

  it("fixes single backslashes in LaTeX", () => {
    // Single backslashes (what an AI often returns): \f and \t would otherwise be JSON escapes.
    expect(parseAiJson('{"prompt": "$\\frac{1}{2}mv^2$ at $\\theta$"}')).toEqual({ value: { prompt: "$\\frac{1}{2}mv^2$ at $\\theta$" } });
    // Already doubled: left alone.
    expect(parseAiJson('{"prompt": "$\\\\frac{1}{2}$"}')).toEqual({ value: { prompt: "$\\frac{1}{2}$" } });
  });

  it("explains what's wrong otherwise", () => {
    expect("error" in parseAiJson("no json here")).toBe(true);
    expect(parseAiJson('{"test": ').hasOwnProperty("error")).toBe(true);
  });
});
