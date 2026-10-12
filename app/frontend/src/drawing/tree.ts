// The drawing as a tree: groups the editor can enter, layer order, and
// grouping/ungrouping. See "Selection, grouping, and layers" in
// docs/svg-editor-plan.md.
//
// A "scope" is the path of group keys the user has entered (double-clicked
// into), outermost first; [] is the drawing itself. Selection, moving,
// drawing and layer order all work on the elements of the current scope.

import { controlKind, controlVariable, isControl } from "./controls";
import { mathToPlainText } from "./mathText";
import { literalNumber, newElementKey, type SceneDocument, type SceneElement } from "./scene";
import { isArrow, isLabeledLine, translateElement } from "./shapes";

export type Scope = string[];
export type LayerMove = "front" | "forward" | "backward" | "back";

/** Plain groups and stamps can be entered; arrows and variable controls act
 *  as single objects because the editor regenerates their insides. */
export function canEnterGroup(element: SceneElement): boolean {
  return element.kind === "group" && !isArrow(element) && !isControl(element) && element.attrs["data-nexam-shape"] !== "arc";
}

export function scopeElements(document: SceneDocument, scope: Scope): SceneElement[] {
  let list = document.elements;
  for (const key of scope) {
    const group = list.find((element) => element.key === key);
    if (!group || group.kind !== "group") return [];
    list = group.children;
  }
  return list;
}

/** The longest prefix of `scope` that still exists (undo can remove a group). */
export function validScope(document: SceneDocument, scope: Scope): Scope {
  let list = document.elements;
  const valid: Scope = [];
  for (const key of scope) {
    const group = list.find((element) => element.key === key);
    if (!group || group.kind !== "group" || !canEnterGroup(group)) break;
    valid.push(key);
    list = group.children;
  }
  return valid;
}

export function updateScope(
  document: SceneDocument,
  scope: Scope,
  update: (elements: SceneElement[]) => SceneElement[],
): SceneDocument {
  const visit = (elements: SceneElement[], depth: number): SceneElement[] => {
    if (depth === scope.length) return update(elements);
    return elements.map((element) =>
      element.key === scope[depth] && element.kind === "group"
        ? { ...element, children: visit(element.children, depth + 1) }
        : element,
    );
  };
  return { ...document, elements: visit(document.elements, 0) };
}

export function replaceInScope(document: SceneDocument, scope: Scope, key: string, next: SceneElement): SceneDocument {
  return updateScope(document, scope, (elements) => elements.map((element) => (element.key === key ? next : element)));
}

/** The scope (parent groups) an element lives in, searching only groups the
 *  editor can enter; null if it isn't found. */
export function scopeOf(document: SceneDocument, key: string): Scope | null {
  const search = (elements: SceneElement[], path: Scope): Scope | null => {
    for (const element of elements) {
      if (element.key === key) return path;
      if (element.kind === "group" && canEnterGroup(element)) {
        const found = search(element.children, [...path, element.key]);
        if (found) return found;
      }
    }
    return null;
  };
  return search(document.elements, []);
}

/** Every element, including those inside groups the editor can enter. */
export function allElements(elements: SceneElement[]): SceneElement[] {
  return elements.flatMap((element) =>
    element.kind === "group" && canEnterGroup(element) ? [element, ...allElements(element.children)] : [element],
  );
}

/** `update` applied to every element at any depth (not inside arrows or
 *  controls, whose insides the editor regenerates). */
export function mapDeep(elements: SceneElement[], update: (element: SceneElement) => SceneElement): SceneElement[] {
  return elements.map((element) => {
    const next = update(element);
    return next.kind === "group" && canEnterGroup(next) ? { ...next, children: mapDeep(next.children, update) } : next;
  });
}

// ---------------------------------------------------------------------------
// Layer order
// ---------------------------------------------------------------------------

/** Moves the selected elements in z-order, keeping their order among themselves.
 *  The list runs back to front: the last element is drawn on top. */
export function reorderElements(elements: SceneElement[], keys: Set<string>, move: LayerMove): SceneElement[] {
  const isSelected = (element: SceneElement) => keys.has(element.key);
  if (move === "front") return [...elements.filter((element) => !isSelected(element)), ...elements.filter(isSelected)];
  if (move === "back") return [...elements.filter(isSelected), ...elements.filter((element) => !isSelected(element))];

  const list = [...elements];
  if (move === "forward") {
    for (let index = list.length - 2; index >= 0; index -= 1) {
      if (isSelected(list[index]) && !isSelected(list[index + 1])) {
        [list[index], list[index + 1]] = [list[index + 1], list[index]];
      }
    }
  } else {
    for (let index = 1; index < list.length; index += 1) {
      if (isSelected(list[index]) && !isSelected(list[index - 1])) {
        [list[index], list[index - 1]] = [list[index - 1], list[index]];
      }
    }
  }
  return list;
}

/** Puts `key` directly in front of `targetKey` (just above it in the Layers list). */
export function moveInFrontOf(elements: SceneElement[], key: string, targetKey: string): SceneElement[] {
  if (key === targetKey) return elements;
  const moving = elements.find((element) => element.key === key);
  if (!moving) return elements;
  const rest = elements.filter((element) => element.key !== key);
  const targetIndex = rest.findIndex((element) => element.key === targetKey);
  if (targetIndex < 0) return elements;
  rest.splice(targetIndex + 1, 0, moving);
  return rest;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** Wraps the selected elements in a new group placed where the topmost of
 *  them was, so nothing changes visually. */
export function groupElements(
  elements: SceneElement[],
  keys: Set<string>,
): { elements: SceneElement[]; group: SceneElement } | null {
  const chosen = elements.filter((element) => keys.has(element.key));
  if (chosen.length === 0) return null;
  const group: SceneElement = {
    key: newElementKey(),
    kind: "group",
    attrs: { "data-nexam-group": "true" },
    children: chosen,
  };
  const topmost = chosen[chosen.length - 1];
  const next: SceneElement[] = [];
  for (const element of elements) {
    if (!keys.has(element.key)) next.push(element);
    else if (element === topmost) next.push(group);
  }
  return { elements: next, group };
}

// Presentation attributes children inherit from a <g>. Ungrouping copies them
// onto children that don't set their own, so nothing changes visually.
const INHERITED_ATTRS = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "color",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
];

export interface UngroupResult {
  elements: SceneElement[];
  childKeys: string[];
  /** Set when a control or arrow was turned into plain shapes. */
  converted: string | null;
}

/** Replaces a group with its children, folding the group's transform and
 *  inherited styles into them. */
export function ungroupElement(elements: SceneElement[], key: string): UngroupResult | null {
  const group = elements.find((element) => element.key === key);
  if (!group || group.kind !== "group") return null;

  const inherited: Record<string, string> = {};
  for (const name of INHERITED_ATTRS) {
    if (group.attrs[name] !== undefined) inherited[name] = group.attrs[name];
  }
  const transform = group.attrs.transform?.trim() || null;
  const offset = transform ? pureTranslate(transform) : null;

  const children = group.children.map((child): SceneElement => {
    if (child.kind === "passthrough") {
      // Can't add attributes to markup the editor doesn't parse: wrap it instead.
      if (!transform && Object.keys(inherited).length === 0) return child;
      return {
        key: newElementKey(),
        kind: "group",
        attrs: { ...inherited, ...(transform ? { transform } : {}) },
        children: [child],
      };
    }
    const attrs = { ...child.attrs };
    for (const [name, value] of Object.entries(inherited)) {
      if (attrs[name] === undefined) attrs[name] = value;
    }
    let next: SceneElement = { ...child, attrs } as SceneElement;
    if (transform) {
      const moved = offset ? translateElement(next, offset.x, offset.y) : null;
      if (moved) next = moved;
      else if (next.kind !== "passthrough") {
        const own = next.attrs.transform;
        next = { ...next, attrs: { ...next.attrs, transform: own ? `${transform} ${own}` : transform } } as SceneElement;
      }
    }
    return next;
  });

  const index = elements.indexOf(group);
  const next = [...elements.slice(0, index), ...children, ...elements.slice(index + 1)];
  const converted = isControl(group)
    ? (controlKind(group) ?? "control").replace("-", " ")
    : isArrow(group)
      ? "arrow"
      : group.attrs["data-nexam-shape"] === "arc"
        ? "arc"
        : null;
  return { elements: next, childKeys: children.map((child) => child.key), converted };
}

function pureTranslate(transform: string): { x: number; y: number } | null {
  const match = transform.match(/^translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)$/);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2] ?? 0) };
}

// ---------------------------------------------------------------------------
// Names for the Layers panel
// ---------------------------------------------------------------------------

export function describeElement(element: SceneElement): string {
  if (element.kind === "passthrough") return `<${element.tagName}>`;
  if (element.kind === "group") {
    const stamp = element.attrs["data-nexam-stamp"];
    if (stamp) return stamp;
    const kind = controlKind(element);
    if (kind) {
      const name = kind === "variable-arrow" ? "Variable arrow" : kind === "variable-bar" ? "Variable bar" : "Variable arc";
      return `${name} (${controlVariable(element)})`;
    }
    if (isLabeledLine(element)) return "Line";
    if (element.attrs["data-nexam-shape"] === "arc") return "Arc";
    if (isArrow(element)) return "Arrow";
    return `Group (${element.children.length})`;
  }
  switch (element.kind) {
    case "text": {
      const text = mathToPlainText(element.text ?? "").trim();
      return text ? `Text “${text.length > 18 ? `${text.slice(0, 17)}…` : text}”` : "Text";
    }
    case "line":
      return "Line";
    case "rect":
      return "Rectangle";
    case "circle":
      return literalNumber(element.attrs.r) === 3 && element.attrs.stroke === undefined ? "Point" : "Circle";
    case "ellipse":
      return "Ellipse";
    case "polygon":
      return "Polygon";
    case "polyline":
      return "Polyline";
    default:
      return "Shape";
  }
}
