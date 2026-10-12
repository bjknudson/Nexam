// Plain SVG <-> SceneDocument. See scene.ts for why values stay strings.
//
// Export is deliberately boring: one element per line, attributes in source
// order, placeholders written exactly as they came in. A teacher (or git diff)
// should be able to read the saved file.

import { hasMath, mathToSvg } from "./mathText";
import {
  SHAPE_KINDS,
  newElementKey,
  type SceneDocument,
  type SceneElement,
  type ShapeKind,
} from "./scene";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ParseResult {
  document: SceneDocument;
  /** Tag names kept as untouched passthrough markup, for a "can't edit these yet" notice. */
  passthroughTags: string[];
}

export function parseSvg(source: string): ParseResult {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (parsed.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg") {
    throw new Error("This file is not a readable SVG.");
  }

  const passthroughTags = new Set<string>();
  const serializer = new XMLSerializer();

  const readAttrs = (element: Element, skip: string[] = []): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(element.attributes)) {
      if (skip.includes(attr.name)) continue;
      attrs[attr.name] = attr.value;
    }
    return attrs;
  };

  const readChildren = (parent: Element): SceneElement[] => {
    const elements: SceneElement[] = [];
    for (const child of Array.from(parent.children)) {
      const tag = child.localName;
      if ((SHAPE_KINDS as readonly string[]).includes(tag)) {
        const kind = tag as ShapeKind;
        if (kind === "text") {
          // Math text keeps its typed source in data-nexam-tex; its <tspan>s
          // are regenerated on save rather than read back.
          const attrs = readAttrs(child, ["data-nexam-tex"]);
          const source = child.getAttribute("data-nexam-tex");
          elements.push({ key: newElementKey(), kind, attrs, text: source ?? child.textContent ?? "" });
        } else {
          elements.push({ key: newElementKey(), kind, attrs: readAttrs(child) });
        }
      } else if (tag === "g") {
        elements.push({
          key: newElementKey(),
          kind: "group",
          attrs: readAttrs(child),
          children: readChildren(child),
        });
      } else {
        passthroughTags.add(tag);
        elements.push({
          key: newElementKey(),
          kind: "passthrough",
          tagName: tag,
          // XMLSerializer repeats the namespace on every detached node; strip it
          // so the saved file doesn't grow a new xmlns on each round trip.
          markup: serializer.serializeToString(child).replace(` xmlns="${SVG_NS}"`, ""),
        });
      }
    }
    return elements;
  };

  return {
    document: { rootAttrs: readAttrs(root, ["xmlns"]), elements: readChildren(root) },
    passthroughTags: [...passthroughTags],
  };
}

export function serializeSvg(document: SceneDocument): string {
  const lines = [`<svg xmlns="${SVG_NS}"${formatAttrs(document.rootAttrs)}>`];
  writeElements(document.elements, 1, lines);
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

/** Markup for one element, for drawing it on the editor canvas. Every element
 *  (nested ones too) gets data-editor-key so a click can be traced back to it;
 *  the key never reaches a saved file (serializeSvg doesn't add it). */
export function elementMarkup(element: SceneElement): string {
  const lines: string[] = [];
  writeElements([element], 0, lines, true);
  return lines.join("\n");
}

function writeElements(elements: SceneElement[], depth: number, lines: string[], withKeys = false): void {
  const indent = "  ".repeat(depth);
  for (const element of elements) {
    const key = withKeys ? ` data-editor-key="${escapeXml(element.key)}"` : "";
    if (element.kind === "passthrough") {
      lines.push(`${indent}${withKeys ? element.markup.replace(/^<([\w:-]+)/, `<$1${key}`) : element.markup}`);
    } else if (element.kind === "group") {
      lines.push(`${indent}<g${key}${formatAttrs(element.attrs)}>`);
      writeElements(element.children, depth + 1, lines, withKeys);
      lines.push(`${indent}</g>`);
    } else if (element.kind === "text") {
      const text = element.text ?? "";
      if (hasMath(text)) {
        const attrs = { ...element.attrs, "data-nexam-tex": text };
        lines.push(`${indent}<text${key}${formatAttrs(attrs)}>${mathToSvg(text).markup}</text>`);
      } else {
        lines.push(`${indent}<text${key}${formatAttrs(element.attrs)}>${escapeXml(text)}</text>`);
      }
    } else {
      lines.push(`${indent}<${element.kind}${key}${formatAttrs(element.attrs)}/>`);
    }
  }
}

function formatAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${escapeXml(value).replace(/"/g, "&quot;")}"`)
    .join("");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
