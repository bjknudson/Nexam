import { describe, expect, it } from "vitest";

import { evaluateToText, fillPlaceholders, formatRounded } from "./preview";
import type { SceneDocument } from "./scene";
import { parseSvg, serializeSvg } from "./svgIO";
import { declarationOf, derivedNames, setDeclaration, withDerived } from "./variables";

const doc: SceneDocument = {
  rootAttrs: { viewBox: "0 0 100 100" },
  elements: [{ key: "t", kind: "text", attrs: { x: "0", y: "0" }, text: "{{Fx}} N" }],
  variables: [
    { name: "force", label: "Force", units: "N", sample: "40" },
    { name: "angle", units: "°", sample: "30" },
    { name: "Fx", formula: "force * cos(angle)", units: "N", show: { kind: "decimals", places: 1 } },
    { name: "twice", formula: "2 * Fx" },
  ],
};

describe("declared variables", () => {
  it("are saved in a readable metadata block and read back", () => {
    const svg = serializeSvg(doc);
    expect(svg).toContain('<metadata id="nexam-variables">{"variables": [');
    expect(svg).toContain('{"name":"Fx","units":"N","formula":"force * cos(angle)","show":{"kind":"decimals","places":1}}');
    const reread = parseSvg(svg).document;
    expect(reread.variables).toEqual(doc.variables);
    expect(reread.elements).toHaveLength(1);
    expect(serializeSvg(reread)).toBe(svg);
  });

  it("leave a drawing without them unchanged", () => {
    const plain = serializeSvg({ rootAttrs: {}, elements: [] });
    expect(plain).not.toContain("metadata");
    expect(parseSvg(plain).document.variables).toBeUndefined();
    expect(parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><metadata id="nexam-variables">{oops</metadata></svg>').document.variables).toBeUndefined();
  });

  it("work out derived variables in order, with their rounding", () => {
    const values = withDerived(doc, { force: "40", angle: "30" });
    expect(values.Fx).toBe("34.6");
    expect(values.twice).toBe("69.2");
    expect(fillPlaceholders("{{Fx}} N", values, true)).toBe("34.6 N");
    expect(derivedNames(doc)).toEqual(["Fx", "twice"]);
  });

  it("can be added, changed and removed", () => {
    const added = setDeclaration(doc, "mass", { name: "mass", units: "kg", sample: "2" });
    expect(added.variables?.map((variable) => variable.name)).toEqual(["force", "angle", "Fx", "twice", "mass"]);
    expect(declarationOf(added, "mass").units).toBe("kg");
    expect(declarationOf(added, "unknown")).toEqual({ name: "unknown" });
    expect(setDeclaration(added, "mass", null).variables).toHaveLength(4);
  });
});

describe("round and sig", () => {
  it("round half away from zero and keep trailing zeros", () => {
    expect(evaluateToText("round(x, 2)", { x: "30" })).toBe("30.00");
    expect(evaluateToText("sig(x, 3)", { x: "30" })).toBe("30.0");
    expect(evaluateToText("sig(x, 2)", { x: "12345" })).toBe("12000");
    expect(evaluateToText("round(2.5)", {})).toBe("3");
    expect(evaluateToText("round(-2.5)", {})).toBe("-3");
    expect(evaluateToText("round(1.005, 2)", {})).toBe("1.01");
    expect(evaluateToText("sig(0.0012345, 3)", {})).toBe("0.00123");
  });

  it("only format the whole expression; inside a sum they're plain numbers", () => {
    expect(evaluateToText("1 + round(x, 1)", { x: "30" })).toBe("31");
    expect(evaluateToText("round(a, 1) + round(b, 1)", { a: "1.04", b: "2" })).toBe("3");
  });

  it("show zero without a minus sign", () => {
    expect(formatRounded(-0.0001, "decimals", 2)).toBe("0.00");
  });
});
