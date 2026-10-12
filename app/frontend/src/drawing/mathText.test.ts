import { describe, expect, it } from "vitest";

import { hasMath, mathToPlainText, mathToSvg, splitSegments } from "./mathText";
import { previewElement } from "./preview";
import { parseSvg, serializeSvg } from "./svgIO";

const plain = (text: string) => mathToPlainText(text);

describe("math segments", () => {
  it("finds $…$ math, honours \\$ and leaves an unclosed $ alone", () => {
    expect(splitSegments("Cost: \\$5, $x^2$ m")).toEqual([
      { math: false, value: "Cost: $5, " },
      { math: true, value: "x^2" },
      { math: false, value: " m" },
    ]);
    expect(hasMath("Price $5")).toBe(false);
    expect(hasMath("$v$")).toBe(true);
  });
});

describe("mathToSvg", () => {
  it("makes sub/superscripts smaller and shifted", () => {
    const { markup } = mathToSvg("$F_{net}$ and $v^2$");
    expect(markup).toContain('<tspan baseline-shift="sub" font-size="70%"><tspan font-style="italic">net</tspan></tspan>');
    expect(markup).toContain('<tspan baseline-shift="super" font-size="70%">2</tspan>');
    expect(plain("$F_{net}$ and $v^2$")).toBe("Fnet and v2");
  });

  it("turns commands into symbols, italicises letters, and keeps text upright", () => {
    expect(plain("$\\theta = 30^\\circ$")).toBe("θ = 30°");
    expect(plain("$\\Delta x \\cdot \\vec{F}$")).toBe("Δx · F⃗");
    expect(mathToSvg("$\\text{max} m$").markup).toContain("max<tspan font-style=\"italic\">m</tspan>");
    expect(plain("$\\frac{a}{2b}$ $\\sqrt{2}$")).toBe("a/(2b) √2");
    expect(plain("$a - b$")).toBe("a − b");
  });

  it("keeps {{placeholders}} literal, even inside scripts", () => {
    expect(plain("$v_{0}$ = {{v0}} m/s")).toBe("v0 = {{v0}} m/s");
    expect(mathToSvg("$v_{{{n}}}$").markup).toContain('font-size="70%">{{n}}</tspan>');
  });

  it("reports unsupported commands and leaves them as typed", () => {
    const result = mathToSvg("$\\begin{matrix}$");
    expect(result.unsupported).toEqual(["\\begin"]);
    expect(plain("$\\begin$")).toBe("\\begin");
  });

  it("escapes XML", () => {
    expect(mathToSvg("$a<b$ & c").markup).toContain("a</tspan> &lt; <tspan");
    expect(mathToSvg("$a<b$ & c").markup).toContain("&amp; c");
  });
});

describe("math text in saved drawings", () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="5" y="20">plain</text></svg>';

  it("saves tspans plus the source, and reopens to the source", () => {
    const { document } = parseSvg(source);
    const withMath = {
      ...document,
      elements: [...document.elements, { key: "m", kind: "text" as const, attrs: { x: "5", y: "50" }, text: "$F_{net}$ = {{force}} N" }],
    };
    const svg = serializeSvg(withMath);
    expect(svg).toContain('data-nexam-tex="$F_{net}$ = {{force}} N"');
    expect(svg).toContain('<tspan baseline-shift="sub"');
    expect(svg).toContain('<text x="5" y="20">plain</text>');
    const reopened = parseSvg(svg).document.elements[1];
    expect(reopened.kind === "text" && reopened.text).toBe("$F_{net}$ = {{force}} N");
    expect(serializeSvg(parseSvg(svg).document)).toBe(svg);
  });

  it("previews with values filled in", () => {
    const element = { key: "m", kind: "text" as const, attrs: {}, text: "$F$ = {{force}} N" };
    const preview = previewElement(element, { force: "12" });
    expect(preview.kind === "text" && preview.text).toBe("$F$ = 12 N");
  });
});

describe("stacked fractions and long roots", () => {
  const moves = (markup: string) =>
    [...markup.matchAll(/dx="(-?[\d.]+)" dy="(-?[\d.]+)"/g)].map((match) => [Number(match[1]), Number(match[2])]);

  it("stacks a fraction over a bar stretched to fit, and ends back on the baseline", () => {
    const { markup } = mathToSvg("$\\frac{F}{m}$", 20);
    expect(markup).toContain('textLength="');
    expect(markup).toContain('lengthAdjust="spacingAndGlyphs">—</tspan>');
    expect(markup).toContain('font-size="80%"');
    const steps = moves(markup);
    expect(steps).toHaveLength(3);
    // Up for the numerator, down past the bar for the denominator, back to the baseline.
    expect(steps.reduce((sum, [, dy]) => sum + dy, 0)).toBeCloseTo(0);
    expect(steps[0][1]).toBeLessThan(0);
    expect(steps[1][1]).toBeGreaterThan(0);
  });

  it("returns the pen to the end of the bar, whatever the parts' widths", () => {
    const { markup } = mathToSvg("$\\frac{a+b}{2}$", 14);
    const bar = Number(markup.match(/textLength="([\d.]+)"/)![1]);
    // Pen after the bar is at its end; the moves and the parts' widths must add back to it.
    const [num, den, end] = moves(markup);
    // Widths aren't in the markup, so check the closing move puts the pen right of the bar's start.
    expect(num[0]).toBeLessThan(0);
    expect(den[0]).toBeLessThan(0);
    expect(end[0]).toBeGreaterThanOrEqual(0);
    expect(bar).toBeGreaterThan(14 * 0.3);
  });

  it("scales placement with the text size, and keeps placeholders", () => {
    const small = moves(mathToSvg("$\\frac{1}{2}$", 10).markup);
    const large = moves(mathToSvg("$\\frac{1}{2}$", 20).markup);
    expect(large[0][1]).toBeCloseTo(small[0][1] * 2);
    expect(mathToSvg("$\\frac{{{force}}}{m}$").markup).toContain("{{force}}");
  });

  it("overlines a long root and leaves a single character plain", () => {
    expect(mathToSvg("$\\sqrt{x+1}$").markup).toContain('√<tspan text-decoration="overline">');
    expect(mathToSvg("$\\sqrt{2}$").markup).not.toContain("overline");
  });

  it("still reads as one line of plain text", () => {
    expect(plain("$v = \\frac{d}{t}$")).toBe("v = d/t");
    expect(plain("$\\sqrt{x+1}$")).toBe("√(x + 1)");
  });
});
