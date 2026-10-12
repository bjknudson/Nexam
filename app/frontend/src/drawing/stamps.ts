/// <reference types="vite/client" />
// Stamps: reusable diagram pieces inserted as a <g data-nexam-stamp>.
// Built-in stamps are plain SVG files in ./stamps; the teacher's own come from
// their stamp folder through the caller (see DrawingEditor's `stampLibrary`).
// Inserting copies the markup into the drawing, so a saved asset never
// depends on the library still having that stamp.

import { writeGroupTransform } from "./transforms";
import { previewElement } from "./preview";
import { literalNumber, newElementKey, type SceneElement } from "./scene";
import { parseSvg, serializeSvg } from "./svgIO";

export interface Stamp {
  id: string;
  name: string;
  /** The subject heading, e.g. "Physics" (stamp packs file into collection › category). */
  collection?: string;
  category: string;
  topics?: string[];
  tags?: string[];
  description?: string;
  /** A loose stamp from before collections, waiting to be filed. */
  unfiled?: boolean;
  svg: string;
  source: "built-in" | "mine";
}

const BUILT_IN_FILES = import.meta.glob("./stamps/*.svg", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

// Display names and categories for the files above; order here is display order.
const BUILT_IN_INFO: [file: string, name: string, category: string][] = [
  ["block", "Block", "Mechanics"],
  ["cart", "Cart", "Mechanics"],
  ["hanging-mass", "Hanging mass", "Mechanics"],
  ["pulley", "Pulley", "Mechanics"],
  ["spring", "Spring", "Mechanics"],
  ["incline", "Incline", "Mechanics"],
  ["ground", "Ground", "Mechanics"],
  ["ceiling", "Ceiling", "Mechanics"],
  ["axes", "Axes", "Graphs"],
  ["resistor", "Resistor", "Circuits"],
  ["battery", "Battery", "Circuits"],
  ["bulb", "Bulb", "Circuits"],
];

export const BUILT_IN_STAMPS: Stamp[] = BUILT_IN_INFO.flatMap(([file, name, category]) => {
  const svg = BUILT_IN_FILES[`./stamps/${file}.svg`];
  return svg ? [{ id: `built-in:${file}`, name, collection: "Physics", category, svg, source: "built-in" as const }] : [];
});

/** Stamps grouped by collection, then category: [collection, [category, stamps][]][].
 *  Collections are alphabetical with "Unfiled" last; built-ins and the
 *  teacher's own stamps share collections (e.g. Physics › Mechanics). */
export function groupByCollection(stamps: Stamp[]): [collection: string, categories: [string, Stamp[]][]][] {
  const collections = new Map<string, Stamp[]>();
  for (const stamp of stamps) {
    const name = stamp.collection || "My stamps";
    collections.set(name, [...(collections.get(name) ?? []), stamp]);
  }
  return [...collections.entries()]
    .sort(([a], [b]) => (a === "Unfiled" ? 1 : b === "Unfiled" ? -1 : a.localeCompare(b)))
    .map(([name, list]) => [name, groupByCategory(list)]);
}

/** Stamps grouped by category, categories in first-seen order. */
export function groupByCategory(stamps: Stamp[]): [category: string, stamps: Stamp[]][] {
  const groups = new Map<string, Stamp[]>();
  for (const stamp of stamps) {
    const list = groups.get(stamp.category) ?? [];
    list.push(stamp);
    groups.set(stamp.category, list);
  }
  return [...groups.entries()];
}

/** A data: URL for showing a stamp in the library. Placeholders are filled
 *  with 0 / kept as text so a variable stamp still draws something. */
export function stampThumbnailUrl(stamp: Stamp): string {
  try {
    const { document } = parseSvg(stamp.svg);
    const svg = serializeSvg({ ...document, elements: document.elements.map((element) => previewElement(element, {})) });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return "";
  }
}

// Root <svg> presentation attributes that its children inherit, so moving the
// children into a <g> doesn't change how they look.
const INHERITED_ROOT_ATTRS = [
  "color",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "font-family",
  "font-size",
  "font-weight",
];

/** A stamp as a group centered on `at`, shrunk if needed to fit the canvas. */
export function createStampElement(
  stamp: Stamp,
  at: { x: number; y: number },
  canvas: { width: number; height: number },
): SceneElement {
  const { document } = parseSvg(stamp.svg);
  const root = document.rootAttrs;
  const box = (root.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  const hasBox = box.length === 4 && box.every(Number.isFinite);
  const minX = hasBox ? box[0] : 0;
  const minY = hasBox ? box[1] : 0;
  const width = (hasBox ? box[2] : literalNumber(root.width)) || 50;
  const height = (hasBox ? box[3] : literalNumber(root.height)) || 50;

  const scale = Math.round(Math.min(1, (canvas.width * 0.8) / width, (canvas.height * 0.8) / height) * 1000) / 1000;

  // The category travels with the copy so the bank's asset search can find
  // drawings by it ("Mechanics"), even if the stamp library changes later.
  const attrs: Record<string, string> = { "data-nexam-stamp": stamp.name, "data-nexam-stamp-category": stamp.category };
  if (stamp.topics && stamp.topics.length > 0) attrs["data-nexam-stamp-topics"] = stamp.topics.join("; ");
  // Stamps drawn with currentColor print black unless the stamp sets a color,
  // rather than taking whatever text colour surrounds the drawing.
  if (stamp.svg.includes("currentColor") && attrs.color === undefined) attrs.color = "#000000";
  for (const name of INHERITED_ROOT_ATTRS) {
    if (root[name] !== undefined) attrs[name] = root[name];
  }
  // Placed by its centre, so resizing and rotating pivot there (transforms.ts).
  return writeGroupTransform(
    { key: newElementKey(), kind: "group", attrs, children: document.elements },
    { cx: at.x, cy: at.y, rotation: 0, scale, ox: minX + width / 2, oy: minY + height / 2, width, height },
  );
}

export function isStamp(element: SceneElement): boolean {
  return element.kind === "group" && element.attrs["data-nexam-stamp"] !== undefined;
}

/** What to say about a file before adding it to My Stamps, or null if it can't be a stamp. */
export function checkStampFile(source: string): { ok: true; passthroughTags: string[] } | { ok: false; reason: string } {
  try {
    const { passthroughTags } = parseSvg(source);
    return { ok: true, passthroughTags };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Not a readable SVG." };
  }
}
