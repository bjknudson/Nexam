/**
 * Maps a validation issue's `location` (e.g. ["answer", "choices", 2]) to a
 * character range inside the raw-JSON textarea's text, for click-to-jump.
 *
 * This can't be done with JSON.parse + in-memory object walking: the textarea
 * is hand-editable, so the only trustworthy source of positions is the actual
 * text on screen, not whatever shape the last successful parse produced. This
 * is a small hand-rolled scanner (not a full parser) -- it only needs to walk
 * past keys/values it doesn't care about to find the one it does.
 */

export interface JsonLocation {
  start: number;
  end: number;
  line: number;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function skipWhitespace(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && isWhitespace(text[i])) i++;
  return i;
}

/** text[pos] must be '"'. Returns the offset just past the closing quote. */
function scanString(text: string, pos: number): number {
  let i = pos + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return i;
}

function parseStringLiteral(text: string, start: number, end: number): string {
  try {
    return JSON.parse(text.slice(start, end)) as string;
  } catch {
    return text.slice(start + 1, end - 1);
  }
}

/** Returns the offset just past the value starting at/after `pos`. */
function scanValue(text: string, pos: number): number {
  const start = skipWhitespace(text, pos);
  const ch = text[start];
  if (ch === '"') return scanString(text, start);
  if (ch === "{") return scanContainer(text, start, "}");
  if (ch === "[") return scanContainer(text, start, "]");
  let i = start;
  while (i < text.length && !isWhitespace(text[i]) && text[i] !== "," && text[i] !== "}" && text[i] !== "]") {
    i++;
  }
  return i;
}

/** text[pos] must be the container's opening bracket. Returns offset just past the matching close. */
function scanContainer(text: string, pos: number, close: "}" | "]"): number {
  let i = skipWhitespace(text, pos + 1);
  if (text[i] === close) return i + 1;
  while (i < text.length) {
    if (close === "}") {
      i = skipWhitespace(text, i);
      i = scanString(text, i); // key
      i = skipWhitespace(text, i);
      if (text[i] === ":") i++;
    }
    i = scanValue(text, i);
    i = skipWhitespace(text, i);
    if (text[i] === ",") {
      i = skipWhitespace(text, i + 1);
      continue;
    }
    if (text[i] === close) return i + 1;
    break; // malformed input -- stop rather than loop forever
  }
  return i;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** text[pos] must be '{'. Returns the offset of the matching key's value, or null if absent. */
function findObjectKey(text: string, pos: number, key: string): number | null {
  let i = skipWhitespace(text, pos + 1);
  if (text[i] === "}") return null;
  while (i < text.length) {
    i = skipWhitespace(text, i);
    if (text[i] !== '"') return null; // malformed
    const keyStart = i;
    const keyEnd = scanString(text, i);
    const keyValue = parseStringLiteral(text, keyStart, keyEnd);
    i = skipWhitespace(text, keyEnd);
    if (text[i] === ":") i++;
    if (keyValue === key) return i;
    i = scanValue(text, i);
    i = skipWhitespace(text, i);
    if (text[i] === ",") {
      i = skipWhitespace(text, i + 1);
      continue;
    }
    break;
  }
  return null;
}

/** text[pos] must be '['. Returns the offset of the value at `index`, or null if out of range. */
function findArrayIndex(text: string, pos: number, index: number): number | null {
  let i = skipWhitespace(text, pos + 1);
  if (text[i] === "]") return null;
  let current = 0;
  while (i < text.length) {
    if (current === index) return i;
    i = scanValue(text, i);
    i = skipWhitespace(text, i);
    if (text[i] === ",") {
      i = skipWhitespace(text, i + 1);
      current++;
      continue;
    }
    break;
  }
  return null;
}

export function locateJsonPath(
  rawJsonText: string,
  path: Array<string | number>,
): JsonLocation | null {
  let pos = skipWhitespace(rawJsonText, 0);

  for (const segment of path) {
    const ch = rawJsonText[pos];
    if (typeof segment === "string") {
      if (ch !== "{") return null;
      const found = findObjectKey(rawJsonText, pos, segment);
      if (found == null) return null;
      pos = skipWhitespace(rawJsonText, found);
    } else {
      if (ch !== "[") return null;
      const found = findArrayIndex(rawJsonText, pos, segment);
      if (found == null) return null;
      pos = skipWhitespace(rawJsonText, found);
    }
  }

  if (pos >= rawJsonText.length) return null;
  const end = scanValue(rawJsonText, pos);
  return { start: pos, end, line: lineOf(rawJsonText, pos) };
}
