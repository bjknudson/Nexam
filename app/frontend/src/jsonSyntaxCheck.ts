/**
 * A from-scratch JSON parser whose only job is to report WHERE and WHY parsing
 * failed, since `JSON.parse`'s own error text can't be trusted for that: V8
 * (the browser dev flow) includes a character position ("...at position 42"),
 * but JavaScriptCore (WebKit, which is what the real Tauri desktop shell runs
 * on macOS) does not -- its messages are plain text like "JSON Parse error:
 * Unterminated string" with no offset at all. Scanning the text ourselves
 * gives a consistent message and an exact offset regardless of which engine
 * actually rejected the input.
 */

export interface JsonSyntaxError {
  message: string;
  offset: number;
  line: number;
}

class JsonScanError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** Returns null if `text` is valid JSON, otherwise a located, friendly error. */
export function findJsonSyntaxError(text: string): JsonSyntaxError | null {
  let i = 0;
  const len = text.length;

  function skipWhitespace() {
    while (i < len && isWhitespace(text[i])) i++;
  }

  function parseValue(): void {
    skipWhitespace();
    if (i >= len) throw new JsonScanError("Unexpected end of JSON input", i);
    const ch = text[i];
    if (ch === '"') return parseString();
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    if (text.startsWith("true", i)) {
      i += 4;
      return;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return;
    }
    throw new JsonScanError(`Unexpected token '${ch}'`, i);
  }

  function parseString(): void {
    const start = i;
    i++; // opening quote
    while (true) {
      if (i >= len || text[i] === "\n") {
        throw new JsonScanError("Unterminated string", start);
      }
      const ch = text[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        return;
      }
      i++;
    }
  }

  function parseNumber(): void {
    const start = i;
    if (text[i] === "-") i++;
    while (i < len && text[i] >= "0" && text[i] <= "9") i++;
    if (text[i] === ".") {
      i++;
      while (i < len && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      while (i < len && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (i === start) throw new JsonScanError("Unexpected token", start);
  }

  function parseObject(): void {
    i++; // '{'
    skipWhitespace();
    if (text[i] === "}") {
      i++;
      return;
    }
    while (true) {
      skipWhitespace();
      if (text[i] !== '"') {
        throw new JsonScanError(
          i >= len ? "Unexpected end of JSON input" : "Expected a property name in quotes",
          i,
        );
      }
      parseString();
      skipWhitespace();
      if (text[i] !== ":") {
        throw new JsonScanError(
          i >= len ? "Unexpected end of JSON input" : "Expected ':' after property name",
          i,
        );
      }
      i++;
      parseValue();
      skipWhitespace();
      if (text[i] === ",") {
        const commaOffset = i;
        i++;
        skipWhitespace();
        if (text[i] === "}") {
          throw new JsonScanError("Trailing comma before '}'", commaOffset);
        }
        continue;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      throw new JsonScanError(
        i >= len ? "Unexpected end of JSON input" : "Expected ',' or '}'",
        i,
      );
    }
  }

  function parseArray(): void {
    i++; // '['
    skipWhitespace();
    if (text[i] === "]") {
      i++;
      return;
    }
    while (true) {
      parseValue();
      skipWhitespace();
      if (text[i] === ",") {
        const commaOffset = i;
        i++;
        skipWhitespace();
        if (text[i] === "]") {
          throw new JsonScanError("Trailing comma before ']'", commaOffset);
        }
        continue;
      }
      if (text[i] === "]") {
        i++;
        return;
      }
      throw new JsonScanError(
        i >= len ? "Unexpected end of JSON input" : "Expected ',' or ']'",
        i,
      );
    }
  }

  try {
    parseValue();
    skipWhitespace();
    if (i < len) {
      throw new JsonScanError("Unexpected trailing content after JSON", i);
    }
    return null;
  } catch (error) {
    if (error instanceof JsonScanError) {
      return { message: error.message, offset: error.offset, line: lineAt(text, error.offset) };
    }
    throw error;
  }
}
