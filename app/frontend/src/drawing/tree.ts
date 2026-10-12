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
import { canonicalize, readGroupTransform, writeGroupTransform, type Matrix } from "./transforms";

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
// Moving between groups (Layers panel)
// ---------------------------------------------------------------------------

/** True when `scope` is `key` or lies inside it (a group can't go into itself). */
export function isInside(scope: Scope, key: string): boolean {
  return scope.includes(key);
}

function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

const round = (value: number) => Math.round(value * 10000) / 10000;

/** `element` re-expressed in another group's coordinates, drawn in the same
 *  place. `matrix` maps the old group's coordinates to the new one's. A pure
 *  shift moves the coordinates; a placed stamp or group gets its placement
 *  recomputed; anything else is wrapped in a group carrying the matrix. */
export function carryInto(element: SceneElement, matrix: Matrix): SceneElement {
  const m = { a: round(matrix.a), b: round(matrix.b), c: round(matrix.c), d: round(matrix.d), e: matrix.e, f: matrix.f };
  const shiftOnly = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
  if (shiftOnly) {
    if (Math.abs(m.e) < 0.005 && Math.abs(m.f) < 0.005) return element;
    const moved = translateElement(element, Math.round(m.e * 100) / 100, Math.round(m.f * 100) / 100);
    if (moved) return moved;
  }
  const placed = readGroupTransform(element);
  if (placed) {
    // Its own transform as a matrix, then the new one in front of it.
    const radians = (placed.rotation * Math.PI) / 180;
    const sx = placed.flipX ? -placed.scale : placed.scale;
    const sy = placed.flipY ? -placed.scale : placed.scale;
    const own: Matrix = {
      a: Math.cos(radians) * sx,
      b: Math.sin(radians) * sx,
      c: -Math.sin(radians) * sy,
      d: Math.cos(radians) * sy,
      e: 0,
      f: 0,
    };
    own.e = placed.cx - (own.a * placed.ox + own.c * placed.oy);
    own.f = placed.cy - (own.b * placed.ox + own.d * placed.oy);
    const next = canonicalize(
      { x: placed.ox - placed.width / 2, y: placed.oy - placed.height / 2, width: placed.width, height: placed.height },
      multiply(m, own),
    );
    // canonicalize reads a mirror as a left-right flip; keep an upside-down flip as it was.
    return writeGroupTransform(element, placed.flipY && !placed.flipX ? { ...next, flipX: false, flipY: true, rotation: next.rotation + 180 } : next);
  }
  const transform = `matrix(${[m.a, m.b, m.c, m.d, Math.round(m.e * 100) / 100, Math.round(m.f * 100) / 100].join(" ")})`;
  return { key: newElementKey(), kind: "group", attrs: { "data-nexam-group": "true", transform }, children: [element] };
}

/** Moves `key` from the group at `from` to the group at `to`, just in front
 *  of `targetKey` there (or on top when null), keeping where it's drawn.
 *  `matrix` maps `from`'s coordinates to `to`'s. Returns the moved element's
 *  key (a new one if it had to be wrapped), or null if nothing moved. */
export function moveBetweenGroups(
  document: SceneDocument,
  key: string,
  from: Scope,
  to: Scope,
  targetKey: string | null,
  matrix: Matrix,
): { document: SceneDocument; key: string } | null {
  if (isInside(to, key)) return null;
  const moving = scopeElements(document, from).find((element) => element.key === key);
  if (!moving) return null;
  if (from.join("/") === to.join("/")) {
    if (!targetKey) return { document: updateScope(document, from, (list) => [...list.filter((element) => element.key !== key), moving]), key };
    return { document: updateScope(document, from, (list) => moveInFrontOf(list, key, targetKey)), key };
  }
  const carried = carryInto(moving, matrix);
  let next = updateScope(document, from, (list) => list.filter((element) => element.key !== key));
  next = updateScope(next, to, (list) => {
    const index = targetKey ? list.findIndex((element) => element.key === targetKey) : -1;
    if (index < 0) return [...list, carried];
    return [...list.slice(0, index + 1), carried, ...list.slice(index + 1)];
  });
  return { document: next, key: carried.key };
}

// ---------------------------------------------------------------------------
// Locking (saved as data-nexam-locked, so a finished background stays put)
// ---------------------------------------------------------------------------

export function isLocked(element: SceneElement): boolean {
  return element.kind !== "passthrough" && element.attrs["data-nexam-locked"] === "true";
}

export function lockedKeys(document: SceneDocument): Set<string> {
  return new Set(allElements(document.elements).filter(isLocked).map((element) => element.key));
}

export function toggleLock(document: SceneDocument, key: string): SceneDocument {
  return {
    ...document,
    elements: mapDeep(document.elements, (element) => {
      if (element.key !== key || element.kind === "passthrough") return element;
      const { "data-nexam-locked": _locked, ...rest } = element.attrs;
      return { ...element, attrs: isLocked(element) ? rest : { ...element.attrs, "data-nexam-locked": "true" } } as SceneElement;
    }),
  };
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
