// Fills {{placeholders}} with preview values so the canvas can draw a
// variable diagram live. Mirrors BankWorkspaceService.render_svg in
// app/backend/service.py: {{calc: ...}} supports + - * /, parentheses and
// min()/max() and sin()/cos() in degrees; unknown or non-numeric variables count as 0, and a bad
// expression gives 0.
// The saved file always keeps the placeholders; this is only for display.

import { CALC_FUNCTIONS, type SceneElement } from "./scene";

export type PreviewValues = Record<string, string>;

const CALC_PATTERN = /\{\{\s*calc:\s*([^}]+?)\s*\}\}/g;
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Text placeholders without a preview value stay visible as {{name}}, so the
 *  author can see where the variable sits; attribute ones fall back to 0. */
export function fillPlaceholders(value: string, values: PreviewValues, keepUnknown: boolean): string {
  return value
    .replace(CALC_PATTERN, (_match, expression: string) => formatResult(evaluateExpression(expression, values)))
    .replace(PLACEHOLDER_PATTERN, (match, name: string) => {
      const filled = values[name];
      if (filled !== undefined && filled !== "") return filled;
      return keepUnknown ? match : "0";
    });
}

export function previewElement(element: SceneElement, values: PreviewValues): SceneElement {
  if (element.kind === "passthrough") {
    return { ...element, markup: fillPlaceholders(element.markup, values, true) };
  }
  const attrs: Record<string, string> = {};
  for (const [name, value] of Object.entries(element.attrs)) {
    attrs[name] = fillPlaceholders(value, values, false);
  }
  if (element.kind === "group") {
    return { ...element, attrs, children: element.children.map((child) => previewElement(child, values)) };
  }
  return {
    ...element,
    attrs,
    text: element.text === undefined ? undefined : fillPlaceholders(element.text, values, true),
  };
}

/** Why an expression can't be used, or null if it's fine. Names other than
 *  `allowedNames` (and min/max) are reported, since they would silently be 0. */
export function expressionError(expression: string, allowedNames: string[]): string | null {
  if (expression.trim() === "") return "Enter a formula.";
  const unknown = (expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter(
    (name) => !allowedNames.includes(name) && !CALC_FUNCTIONS.includes(name),
  );
  if (unknown.length > 0) return `Unknown name: ${unknown[0]}. Use ${allowedNames.join(", ")}.`;
  try {
    const parser = new ExpressionParser(expression, {});
    parser.parseSum();
    parser.expectEnd();
    return null;
  } catch (error) {
    return `Can't read that formula (${error instanceof Error ? error.message : "syntax error"}).`;
  }
}

export function evaluateExpression(expression: string, values: PreviewValues): number {
  try {
    const parser = new ExpressionParser(expression, values);
    const result = parser.parseSum();
    parser.expectEnd();
    return Number.isFinite(result) ? result : 0;
  } catch {
    return 0;
  }
}

function formatResult(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

class ExpressionParser {
  private readonly tokens: string[];
  private index = 0;

  constructor(
    expression: string,
    private readonly values: PreviewValues,
  ) {
    this.tokens = expression.match(/\d+(?:\.\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),]|\S/g) ?? [];
  }

  parseSum(): number {
    let value = this.parseProduct();
    while (this.peek() === "+" || this.peek() === "-") {
      const operator = this.next();
      const right = this.parseProduct();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  private parseProduct(): number {
    let value = this.parseUnary();
    while (this.peek() === "*" || this.peek() === "/") {
      const operator = this.next();
      const right = this.parseUnary();
      // Division by zero is 0, like the backend.
      value = operator === "*" ? value * right : right === 0 ? 0 : value / right;
    }
    return value;
  }

  private parseUnary(): number {
    if (this.peek() === "-") {
      this.next();
      return -this.parseUnary();
    }
    if (this.peek() === "+") {
      this.next();
      return this.parseUnary();
    }
    return this.parseAtom();
  }

  private parseAtom(): number {
    const token = this.next();
    if (token === "(") {
      const value = this.parseSum();
      if (this.next() !== ")") throw new Error("missing )");
      return value;
    }
    if (token !== undefined && /^[\d.]/.test(token)) return Number(token);
    if (token !== undefined && CALC_FUNCTIONS.includes(token) && this.peek() === "(") {
      this.next();
      const args = [this.parseSum()];
      while (this.peek() === ",") {
        this.next();
        args.push(this.parseSum());
      }
      if (this.next() !== ")") throw new Error("missing )");
      if (token === "sin" || token === "cos") {
        // Degrees; values within rounding of zero snap to it, so sin(180) draws as 0.
        const radians = (args[0] * Math.PI) / 180;
        const value = token === "sin" ? Math.sin(radians) : Math.cos(radians);
        return Math.abs(value) < 1e-12 ? 0 : value;
      }
      return token === "min" ? Math.min(...args) : Math.max(...args);
    }
    if (token !== undefined && /^[A-Za-z_]/.test(token)) {
      const raw = Number((this.values[token] ?? "0").trim());
      return Number.isFinite(raw) ? raw : 0;
    }
    throw new Error(`unexpected ${token ?? "end"}`);
  }

  expectEnd(): void {
    if (this.index < this.tokens.length) throw new Error("trailing input");
  }

  private peek(): string | undefined {
    return this.tokens[this.index];
  }

  private next(): string | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }
}
