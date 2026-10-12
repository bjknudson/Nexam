// In-memory scene model for the drawing window. See docs/svg-editor-plan.md.
//
// This folder must not import anything from the rest of Nexam: it only knows
// about SVG and {{placeholder}} text, so it can be tested on its own (or lifted
// into a standalone tool later).
//
// Attribute values are kept as strings, not numbers, because bank SVGs put
// placeholders straight into geometry, e.g. y2="{{calc: 60 - arrow_length}}".
// Use literalNumber() to get a draggable number, and leave a value alone when
// it is a placeholder.

export type ShapeKind =
  | "line"
  | "rect"
  | "circle"
  | "ellipse"
  | "polygon"
  | "polyline"
  | "text";

export type SceneElement =
  | {
      /** Editor-only handle. Never written to the SVG; a source `id` attribute lives in attrs. */
      key: string;
      kind: ShapeKind;
      /** Attributes in source order, so a round trip keeps the file diff small. */
      attrs: Record<string, string>;
      /** Text content, for kind "text" only. May contain {{placeholders}}. */
      text?: string;
    }
  | {
      key: string;
      kind: "group";
      attrs: Record<string, string>;
      children: SceneElement[];
    }
  | {
      /** Markup the editor does not understand yet (path, defs, marker, ...).
       *  It is kept exactly as written instead of being silently dropped. */
      key: string;
      kind: "passthrough";
      tagName: string;
      markup: string;
    };

export interface SceneDocument {
  /** Root <svg> attributes other than xmlns, in source order (width, height, viewBox, ...). */
  rootAttrs: Record<string, string>;
  elements: SceneElement[];
}

export const SHAPE_KINDS: readonly ShapeKind[] = [
  "line",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "text",
];

const PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Function names allowed inside {{calc: ...}}; never variables. */
/** Functions {{calc:}} understands: min/max, and sin/cos in degrees. */
export const CALC_FUNCTIONS = ["min", "max", "sin", "cos"];

let keyCounter = 0;

export function newElementKey(): string {
  keyCounter += 1;
  return `el_${keyCounter}`;
}

export function createDocument(width = 320, height = 180): SceneDocument {
  return {
    rootAttrs: {
      width: String(width),
      height: String(height),
      viewBox: `0 0 ${width} ${height}`,
    },
    elements: [],
  };
}

export function hasPlaceholder(value: string | undefined): boolean {
  return value !== undefined && value.includes("{{");
}

/** The numeric value of an attribute, or null when it is missing, a
 *  placeholder, or not a plain number (so the editor should not drag it). */
export function literalNumber(value: string | undefined): number | null {
  if (value === undefined || hasPlaceholder(value)) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Placeholder names used anywhere in the document, in first-seen order.
 *  `{{label}}` yields "label"; `{{calc: 60 - arrow_length}}` yields
 *  "arrow_length", since that is the variable a teacher actually sets. */
export function listVariables(document: SceneDocument): string[] {
  const seen = new Set<string>();
  const visit = (value: string | undefined) => {
    if (!value) return;
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
      const body = match[1];
      if (body.startsWith("calc:")) {
        for (const name of body.slice("calc:".length).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
          if (!CALC_FUNCTIONS.includes(name)) seen.add(name);
        }
      } else {
        seen.add(body);
      }
    }
  };
  const walk = (elements: SceneElement[]) => {
    for (const element of elements) {
      if (element.kind === "passthrough") {
        visit(element.markup);
        continue;
      }
      Object.values(element.attrs).forEach(visit);
      if (element.kind === "group") {
        walk(element.children);
      } else {
        visit(element.text);
      }
    }
  };
  Object.values(document.rootAttrs).forEach(visit);
  walk(document.elements);
  return [...seen];
}
