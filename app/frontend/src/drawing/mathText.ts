// A small LaTeX subset for text in drawings: `$F_{net}$ = {{force}} N`.
// SVG <text> can't show LaTeX (KaTeX makes HTML, which breaks in images and
// print), so math is turned into real SVG text: <tspan>s for sub/superscripts,
// Unicode for symbols, italics for single-letter variables. {{placeholders}}
// stay literal so the backend still fills them per question. The typed source
// is kept on the <text> (data-nexam-tex) so it stays editable.
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
  | { kind: "bold"; children: MathNode[] };

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

export function mathToSvg(text: string): MathConversion {
  const unsupported: string[] = [];
  const parts = splitSegments(text).map((segment) => {
    if (!segment.math) return escapeXml(segment.value);
    const parser = new MathParser(segment.value, unsupported);
    const nodes = parser.parseSequence(null);
    return `<tspan font-family="${MATH_FONT}">${renderNodes(nodes)}</tspan>`;
  });
  return { markup: parts.join(""), unsupported: [...new Set(unsupported)] };
}

function renderNodes(nodes: MathNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "placeholder") return escapeXml(node.value);
      if (node.kind === "text") {
        return node.italic ? `<tspan font-style="italic">${escapeXml(node.value)}</tspan>` : escapeXml(node.value);
      }
      if (node.kind === "bold") return `<tspan font-weight="bold">${renderNodes(node.children)}</tspan>`;
      return `<tspan baseline-shift="${node.position}" font-size="70%">${renderNodes(node.children)}</tspan>`;
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
    if (name === "frac") {
      // Inline in drawings: a/b (stacked fractions may come later).
      const numerator = this.parseArgument();
      const denominator = this.parseArgument();
      const wrap = (nodes: MathNode[]) =>
        nodes.length > 1 ? [{ kind: "text" as const, value: "(", italic: false }, ...nodes, { kind: "text" as const, value: ")", italic: false }] : nodes;
      return [...wrap(numerator), { kind: "text", value: "/", italic: false }, ...wrap(denominator)];
    }
    if (name === "sqrt") {
      const argument = this.parseArgument();
      const wrap = argument.length > 1;
      return [
        { kind: "text", value: wrap ? "√(" : "√", italic: false },
        ...argument,
        ...(wrap ? [{ kind: "text" as const, value: ")", italic: false }] : []),
      ];
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
  return mathToSvg(text).markup.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
