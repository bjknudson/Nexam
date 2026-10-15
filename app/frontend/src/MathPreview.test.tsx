import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { hasMathMarkup, MathTextPreview } from "./MathPreview";

const rendersAsMath = (text: string) =>
  renderToStaticMarkup(<MathTextPreview text={text} preferWholeExpression />).includes('class="katex"');

describe("math without $…$", () => {
  it("renders common functions and symbols typed bare, like a choice \\ln(x)", () => {
    for (const text of ["\\ln(x)", "\\log_{10}(x)", "\\vec{F}", "x \\to \\infty", "\\Omega"]) {
      expect(hasMathMarkup(text), text).toBe(true);
      expect(rendersAsMath(text), text).toBe(true);
    }
  });

  it("still renders the same text inside $…$, and leaves prose alone", () => {
    expect(rendersAsMath("$\\ln(x)$")).toBe(true);
    expect(rendersAsMath("The table pushes up on the book")).toBe(false);
  });
});
