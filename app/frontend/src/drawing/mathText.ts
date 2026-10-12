// A small LaTeX subset for text in drawings: `$F_{net}$ = {{force}} N`.
// SVG <text> can't show LaTeX (KaTeX makes HTML, which breaks in images and
// print), so math is turned into real SVG text: <tspan>s for sub/superscripts,
// Unicode for symbols, italics for single-letter variables. {{placeholders}}
// stay literal so the backend still fills them per question. The typed source
// is kept on the <text> (data-nexam-tex) so it stays editable.
//
// \frac{a}{b} is stacked inside the same <text>: a bar (a dash stretched to
// length with textLength), then the numerator and denominator at 80% size,
// moved into place with dx/dy. Their widths can't be measured (a question's
// {{value}} isn't known until it renders), so they're estimated from the
// characters, which centres them closely enough for short fractions.
// \sqrt{…} of more than one character draws an overline over its argument.
// See "Text: symbols and math" in docs/svg-editor-plan.md.

const MATH_FONT = "'STIX Two Math', 'Cambria Math', 'Times New Roman', serif";

const SYMBOLS: Record<string, string> = {
  // Greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
  Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Operators and relations
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥",
  approx: "≈", neq: "≠", ne: "≠", propto: "∝", infty: "∞", sim: "∼", equiv: "≡", sum: "∑", int: "∫",
  partial: "∂", nabla: "∇",
  // Arrows and geometry
  to: "→", rightarrow: "→", leftarrow: "←", uparrow: "↑", downarrow: "↓", leftrightarrow: "↔",
  Rightarrow: "⇒", perp: "⊥", parallel: "∥", angle: "∠", triangle: "△",
  // Marks and units
  circ: "°", degree: "°", prime: "′", ell: "ℓ", hbar: "ℏ", AA: "Å", ohm: "Ω",
  // Spacing
  ",": " ", ";": " ", quad: " ", " ": " ",
};

// Relations and binary operators get a space on each side, as TeX spaces
// them; typed spaces in math are ignored, also as in TeX ("\Delta x" is Δx).
const OPERATORS = new Set(["=", "+", "−", "<", ">", "·", "×", "÷", "±", "∓", "≤", "≥", "≈", "≠", "∝", "∼", "≡", "→", "←", "↔", "⇒"]);

// Combining marks for accents; the font decides exactly how they look.
const ACCENTS: Record<string, string> = { vec: "⃗", hat: "̂", bar: "̅", dot: "̇", tilde: "̃" };

const UPRIGHT_COMMANDS = new Set(["text", "mathrm", "textrm", "mathbf"]);

type MathNode =
  | { kind: "text"; value: string; italic: boolean }
  | { kind: "placeholder"; value: string }
  | { kind: "script"; position: "sub" | "super"; children: MathNode[] }
  | { kind: "bold"; children: MathNode[] }
  | { kind: "frac"; numerator: MathNode[]; denominator: MathNode[] }
  | { kind: "sqrt"; children: MathNode[] };

export interface MathConversion {
  /** <tspan> markup for the inside of a <text>. */
  markup: string;
  /** Commands the subset doesn't support, left as typed. */
  unsupported: string[];
}

/** True when `text` has at least one $…$ math segment. */
export function hasMath(text: string | undefined): boolean {
  return !!text && splitSegments(text).some((segment) => segment.math);
}

/** Plain text and $…$ math segments; `\$` is a literal dollar sign. */
export function splitSegments(text: string): { math: boolean; value: string }[] {
  const segments: { math: boolean; value: string }[] = [];
  let current = "";
  let inMath = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && text[index + 1] === "$") {
      current += inMath ? "\\$" : "$";
      index += 1;
    } else if (char === "$") {
      if (current) segments.push({ math: inMath, value: current });
      current = "";
      inMath = !inMath;
    } else {
      current += char;
    }
  }
  // An unclosed $ is just a dollar sign.
  if (inMath) segments.push({ math: false, value: `$${current}` });
  else if (current) segments.push({ math: false, value: current });
  return segments;
}

/** `fontSize` (px) is the text's size, for placing stacked fractions. */
export function mathToSvg(text: string, fontSize = 14): MathConversion {
  const unsupported: string[] = [];
  const parts = splitSegments(text).map((segment) => {
    if (!segment.math) return escapeXml(segment.value);
    const parser = new MathParser(segment.value, unsupported);
    const nodes = parser.parseSequence(null);
    return `<tspan font-family="${MATH_FONT}">${renderNodes(nodes, fontSize)}</tspan>`;
  });
  return { markup: parts.join(""), unsupported: [...new Set(unsupported)] };
}

/** Size of a fraction's numerator and denominator, relative to the text. */
const FRACTION_SCALE = 0.8;
/** A zero-width character to carry a dx/dy move without drawing anything. */
const ZERO_WIDTH = "\u200B";

const px = (value: number) => String(Math.round(value * 100) / 100);

function renderNodes(nodes: MathNode[], fontSize: number): string {
  return nodes
    .map((node) => {
      if (node.kind === "placeholder") return escapeXml(node.value);
      if (node.kind === "text") {
        return node.italic ? `<tspan font-style="italic">${escapeXml(node.value)}</tspan>` : escapeXml(node.value);
      }
      if (node.kind === "bold") return `<tspan font-weight="bold">${renderNodes(node.children, fontSize)}</tspan>`;
      if (node.kind === "frac") return renderFraction(node.numerator, node.denominator, fontSize);
      if (node.kind === "sqrt") {
        const long = estimateEm(node.children) > 0.75;
        const inside = renderNodes(node.children, fontSize);
        return long ? `√<tspan text-decoration="overline">${inside}</tspan>` : `√${inside}`;
      }
      return `<tspan baseline-shift="${node.position}" font-size="70%">${renderNodes(node.children, fontSize * 0.7)}</tspan>`;
    })
    .join("");
}

/** A stacked fraction (see the note at the top). Positions are in px from
 *  the baseline: the bar sits where a dash does (about the math axis), the
 *  numerator's baseline half a line above, the denominator's just under the
 *  bar. Afterwards the pen is back on the baseline at the fraction's end,
 *  so the text's alignment (start, middle, end) still works. */
function renderFraction(numerator: MathNode[], denominator: MathNode[], size: number): string {
  const small = size * FRACTION_SCALE;
  const wN = estimateEm(numerator) * small;
  const wD = estimateEm(denominator) * small;
  const width = Math.max(wN, wD) + 0.3 * size;
  const part = (nodes: MathNode[], dx: number, dy: number) =>
    `<tspan font-size="${FRACTION_SCALE * 100}%" dx="${px(dx)}" dy="${px(dy)}">${ZERO_WIDTH}${renderNodes(nodes, small)}</tspan>`;
  return [
    `<tspan textLength="${px(width)}" lengthAdjust="spacingAndGlyphs">—</tspan>`,
    part(numerator, -(width + wN) / 2, -0.5 * size),
    part(denominator, -(wN + wD) / 2, 0.95 * size),
    `<tspan dx="${px((width - wD) / 2)}" dy="${px(-0.45 * size)}">${ZERO_WIDTH}</tspan>`,
  ].join("");
}

/** Rough width in ems: enough to centre a fraction's parts. A {{value}} is
 *  counted as a three-character number. */
function estimateEm(nodes: MathNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === "placeholder") total += 1.5;
    else if (node.kind === "text") {
      for (const char of node.value) {
        total += char === " " ? 0.25 : /[0-9]/.test(char) ? 0.5 : /[A-Z]/.test(char) ? 0.65 : /[a-z]/.test(char) ? 0.48 : /[.,:;'′]/.test(char) ? 0.25 : 0.6;
      }
    } else if (node.kind === "script") total += 0.7 * estimateEm(node.children);
    else if (node.kind === "frac") total += FRACTION_SCALE * Math.max(estimateEm(node.numerator), estimateEm(node.denominator)) + 0.3;
    else if (node.kind === "sqrt") total += 0.6 + estimateEm(node.children);
    else total += estimateEm(node.children);
  }
  return total;
}

/** The same math as one line of plain text: a/b for fractions, √(…) for roots. */
function plainNodes(nodes: MathNode[]): string {
  const wrap = (inner: MathNode[]) => (inner.length > 1 || estimateEm(inner) > 0.75 ? `(${plainNodes(inner)})` : plainNodes(inner));
  return nodes
    .map((node) => {
      if (node.kind === "placeholder" || node.kind === "text") return node.value;
      if (node.kind === "frac") return `${wrap(node.numerator)}/${wrap(node.denominator)}`;
      if (node.kind === "sqrt") return `√${wrap(node.children)}`;
      return plainNodes(node.children);
    })
    .join("");
}

class MathParser {
  private index = 0;
  /** Inside \text{…}, where typed spaces count. */
  private literalDepth = 0;
  /** Whether anything has been emitted yet, to tell unary from binary minus. */
  private emitted = false;

  constructor(
    private readonly source: string,
    private readonly unsupported: string[],
  ) {}

  /** Nodes until `close` (or the end); merges neighbouring plain text. */
  parseSequence(close: string | null): MathNode[] {
    const nodes: MathNode[] = [];
    while (this.index < this.source.length) {
      if (close && this.source[this.index] === close) {
        this.index += 1;
        return merge(nodes);
      }
      const node = this.parseAtom();
      if (node) nodes.push(...node);
    }
    return merge(nodes);
  }

  private parseAtom(): MathNode[] | null {
    const nodes = this.parseAtomInner();
    if (nodes && nodes.length > 0) this.emitted = true;
    return nodes;
  }

  /** A relation or operator with TeX-like spacing (none for a leading sign: "−5"). */
  private operator(symbol: string): MathNode[] {
    const unary = !this.emitted && (symbol === "−" || symbol === "+" || symbol === "±");
    return [{ kind: "text", value: unary ? symbol : ` ${symbol} `, italic: false }];
  }

  private parseAtomInner(): MathNode[] | null {
    const rest = this.source.slice(this.index);
    const placeholder = rest.match(/^\{\{[^{}]+\}\}/);
    if (placeholder) {
      this.index += placeholder[0].length;
      return [{ kind: "placeholder", value: placeholder[0] }];
    }
    const char = this.source[this.index];
    if (char === "{") {
      this.index += 1;
      return this.parseSequence("}");
    }
    if (char === "_" || char === "^") {
      this.index += 1;
      return [{ kind: "script", position: char === "_" ? "sub" : "super", children: this.parseArgument() }];
    }
    if (char === "\\") return this.parseCommand();
    this.index += 1;
    if (char === " " && this.literalDepth === 0) return [];
    if (/[A-Za-z]/.test(char)) return [{ kind: "text", value: char, italic: this.literalDepth === 0 }];
    if (char === "-") return this.operator("−");
    if (OPERATORS.has(char)) return this.operator(char);
    if (char === "*") return [{ kind: "text", value: "∗", italic: false }];
    if (char === "'") return [{ kind: "text", value: "′", italic: false }];
    return [{ kind: "text", value: char, italic: false }];
  }

  /** One argument: a {group}, a placeholder, a command, or a single character. */
  private parseArgument(): MathNode[] {
    while (this.source[this.index] === " ") this.index += 1;
    if (this.index >= this.source.length) return [];
    return this.parseAtom() ?? [];
  }

  private parseCommand(): MathNode[] {
    this.index += 1;
    const named = this.source.slice(this.index).match(/^[A-Za-z]+/);
    const name = named ? named[0] : this.source[this.index] ?? "";
    this.index += name.length;

    if (name in SYMBOLS) {
      const symbol = SYMBOLS[name];
      return OPERATORS.has(symbol) ? this.operator(symbol) : [{ kind: "text", value: symbol, italic: false }];
    }
    if (name in ACCENTS) {
      const base = this.parseArgument();
      return [...base, { kind: "text", value: ACCENTS[name], italic: false }];
    }
    if (UPRIGHT_COMMANDS.has(name)) {
      this.literalDepth += 1;
      const argument = this.parseArgument().map((node) => (node.kind === "text" ? { ...node, italic: false } : node));
      this.literalDepth -= 1;
      return name === "mathbf" ? [{ kind: "bold", children: argument }] : argument;
    }
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const numerator = this.parseArgument();
      const denominator = this.parseArgument();
      return [{ kind: "frac", numerator, denominator }];
    }
    if (name === "sqrt") {
      return [{ kind: "sqrt", children: this.parseArgument() }];
    }
    if (name === "{" || name === "}" || name === "%" || name === "&" || name === "_" || name === "#") {
      return [{ kind: "text", value: name, italic: false }];
    }
    this.unsupported.push(`\\${name}`);
    return [{ kind: "text", value: `\\${name}`, italic: false }];
  }
}

function merge(nodes: MathNode[]): MathNode[] {
  const merged: MathNode[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (last?.kind === "text" && node.kind === "text" && last.italic === node.italic) {
      merged[merged.length - 1] = { ...last, value: last.value + node.value };
    } else {
      merged.push(node);
    }
  }
  return merged;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain-text reading of the math, for places that can't show tspans (e.g. names in the Layers panel). */
export function mathToPlainText(text: string): string {
  return splitSegments(text)
    .map((segment) => (segment.math ? plainNodes(new MathParser(segment.value, []).parseSequence(null)) : segment.value))
    .join("");
}
