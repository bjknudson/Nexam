// Builds the demo bank's physics drawings with the drawing tool's own code,
// so they are exactly what the editor makes (and stay editable there).
//
//   cd app/frontend && npx vite-node scripts/demo-drawings.ts
//
// Writes samples/demo-bank/assets/*.svg; then run scripts/build_demo_bok.py.
// See "Question-driven variables" in docs/svg-editor-plan.md.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

// parseSvg (used for stamps) needs a DOM.
const dom = new JSDOM("");
Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });

const { createArcFromDrag } = await import("../src/drawing/arcs");
const { attachText, relayoutAnchors } = await import("../src/drawing/anchors");
const { createControlFromDrag, setControlAttrs } = await import("../src/drawing/controls");
const { createDocument } = await import("../src/drawing/scene");
const { createShapeAtPoint, createShapeFromDrag } = await import("../src/drawing/shapes");
const { BUILT_IN_STAMPS, createStampElement } = await import("../src/drawing/stamps");
const { defaultStyle } = await import("../src/drawing/styles");
const { serializeSvg } = await import("../src/drawing/svgIO");
const { readGroupTransform, writeGroupTransform } = await import("../src/drawing/transforms");

type SceneElement = import("../src/drawing/scene").SceneElement;
type SceneDocument = import("../src/drawing/scene").SceneDocument;
type DeclaredVariable = import("../src/drawing/variables").DeclaredVariable;

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "../../../samples/demo-bank/assets");
const WIDTH = 318;
const HEIGHT = 200;
const style = defaultStyle();
const dashed = { "stroke-dasharray": "6 4.5" };

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function stamp(name: string, x: number, y: number, extra: { rotation?: number; scale?: number } = {}): SceneElement {
  const found = BUILT_IN_STAMPS.find((item) => item.name === name);
  if (!found) throw new Error(`No built-in stamp ${name}`);
  const element = createStampElement(found, { x, y }, { width: WIDTH, height: HEIGHT });
  const placed = readGroupTransform(element);
  return placed ? writeGroupTransform(element, { ...placed, rotation: extra.rotation ?? 0, scale: extra.scale ?? placed.scale }) : element;
}

/** A variable arrow from (x, y) at `angle` (degrees, counterclockwise from +x). */
function arrow(
  x: number,
  y: number,
  angle: number,
  variable: string,
  attrs: Record<string, string> = {},
): SceneElement {
  const created = createControlFromDrag("variable-arrow", { x, y }, { x: x + 40, y }, style, [], 20);
  if (!created) throw new Error("arrow");
  return setControlAttrs(created.element, { "data-variable": variable, "data-angle": String(angle), ...attrs });
}

function text(x: number, y: number, value: string, attrs: Record<string, string> = {}): SceneElement {
  const element = createShapeAtPoint("text", { x, y }, style);
  if (!element || element.kind !== "text") throw new Error("text");
  return { ...element, attrs: { ...element.attrs, ...attrs }, text: value };
}

function line(x1: number, y1: number, x2: number, y2: number, attrs: Record<string, string> = {}): SceneElement {
  const element = createShapeFromDrag("line", { x: x1, y: y1 }, { x: x2, y: y2 }, style);
  if (!element || element.kind === "passthrough") throw new Error("line");
  return { ...element, attrs: { ...element.attrs, ...attrs } } as SceneElement;
}

function drawing(
  file: string,
  elements: SceneElement[],
  variables: DeclaredVariable[],
  preview: Record<string, string>,
  topics: string[],
) {
  const base = createDocument(WIDTH, HEIGHT);
  let document: SceneDocument = {
    ...base,
    rootAttrs: {
      ...base.rootAttrs,
      "data-nexam-topics": topics.join("; "),
      "data-nexam-preview": Object.entries(preview)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    },
    elements,
    variables,
  };
  document = relayoutAnchors(document);
  writeFileSync(join(ASSETS, file), serializeSvg(document));
  console.log(`wrote ${file}`);
}

/** Attaches `label` to `target` at `point`, returning both (the target gains an id). */
function attached(elements: SceneElement[], target: SceneElement, label: SceneElement, point: "top" | "bottom" | "left" | "right" | "center") {
  const result = attachText({ rootAttrs: {}, elements }, label, target, point);
  return [result.target, result.text];
}

// ---------------------------------------------------------------------------
// q_fr_0002: a crate pulled across a floor, with friction
// ---------------------------------------------------------------------------
{
  const forces = { "data-scale": "0.45", "data-scale-group": "Forces" };
  const crate = stamp("Block", 159, 100);
  const [crateWithId, crateLabel] = attached([], crate, text(159, 100, "{{mass}} kg", { "text-anchor": "middle" }), "center");
  drawing(
    "crate-friction-fbd.svg",
    [
      line(20, 120, 298, 120, { "stroke-width": "2" }),
      crateWithId,
      crateLabel,
      arrow(189, 100, 0, "force", { ...forces, "data-label": "$F_{app}$ = {{force}} N" }),
      arrow(129, 100, 180, "Ff", { ...forces, "data-label": "$F_f$ = {{Ff}} N" }),
      arrow(159, 80, 90, "Fg", { ...forces, "data-label": "$F_N$" }),
      arrow(159, 120, 270, "Fg", { ...forces, "data-label": "$F_g$ = {{Fg}} N" }),
    ],
    [
      { name: "mass", label: "Mass of the crate", units: "kg", sample: "12" },
      { name: "force", label: "Applied force", units: "N", sample: "48" },
      { name: "mu", label: "Coefficient of kinetic friction", sample: "0.20" },
      { name: "Fg", formula: "mass * 9.8", units: "N", show: { kind: "decimals", places: 1 } },
      { name: "Ff", formula: "mu * Fg", units: "N", show: { kind: "decimals", places: 1 } },
    ],
    { mass: "12", force: "48", mu: "0.20" },
    ["Forces", "Friction", "Newton's second law"],
  );
}

// ---------------------------------------------------------------------------
// q_mc_0001: a cart speeding up from rest
// ---------------------------------------------------------------------------
{
  const cart = stamp("Cart", 110, 115);
  drawing(
    "cart-accelerating.svg",
    [
      stamp("Ground", 159, 145, { scale: 2.4 }),
      cart,
      arrow(160, 80, 0, "a", { "data-scale": "20", "data-label": "a = {{a}} m/s²", "data-label-at": "mid" }),
      text(110, 40, "starts at rest · t = {{t}} s", { "text-anchor": "middle" }),
    ],
    [
      { name: "a", label: "Acceleration", units: "m/s²", sample: "2" },
      { name: "t", label: "Time", units: "s", sample: "3" },
    ],
    { a: "2", t: "3" },
    ["Kinematics", "Acceleration"],
  );
}

// ---------------------------------------------------------------------------
// q_mc_0041: a book resting on a table (the forces on the book)
// ---------------------------------------------------------------------------
{
  const forces = { "data-scale": "1.6", "data-heads": "end" };
  drawing(
    "book-on-table-fbd.svg",
    [
      line(60, 120, 260, 120, { "stroke-width": "3" }),
      line(80, 120, 80, 185, { "stroke-width": "3" }),
      line(240, 120, 240, 185, { "stroke-width": "3" }),
      stamp("Block", 160, 105, { scale: 0.75 }),
      text(160, 106, "book", { "text-anchor": "middle", "font-size": "12" }),
      arrow(160, 90, 90, "weight", { ...forces, "data-label": "$F_N$ (table on book)", "data-label-orient": "horizontal" }),
      arrow(160, 120, 270, "weight", { ...forces, "data-label": "$F_g$ (Earth on book)" }),
    ],
    [{ name: "weight", label: "Weight of the book", units: "N", sample: "25" }],
    { weight: "25" },
    ["Forces", "Newton's third law"],
  );
}

// ---------------------------------------------------------------------------
// q_mc_0042: a ball dropped from rest
// ---------------------------------------------------------------------------
{
  const ball = createShapeFromDrag("circle", { x: 110, y: 40 }, { x: 120, y: 40 }, { ...style, fill: "#a6a6a6" })!;
  drawing(
    "ball-drop.svg",
    [
      stamp("Ground", 159, 186, { scale: 2.4 }),
      ball,
      line(110, 52, 110, 178, dashed),
      text(118, 30, "released from rest", { "font-size": "12" }),
      arrow(220, 40, 270, "v", { "data-scale": "4", "data-max-length": "135", "data-label": "v after {{t}} s", "data-label-at": "end" }),
      text(30, 115, "d = ?", { "font-size": "14" }),
    ],
    [
      { name: "t", label: "Time falling", units: "s", sample: "2.5" },
      { name: "g", label: "Gravitational acceleration", units: "m/s²", sample: "9.8" },
      { name: "v", formula: "g * t", units: "m/s", show: { kind: "sig", places: 2 } },
    ],
    { t: "2.5", g: "9.8" },
    ["Kinematics", "Free fall"],
  );
}

// ---------------------------------------------------------------------------
// Circuits: q_fr_0003 (series), q_mc_0010 (one resistor), q_mc_0037 (parallel)
// ---------------------------------------------------------------------------
{
  // A loop: battery on the left side, resistors along the top and right.
  drawing(
    "series-circuit.svg",
    [
      line(60, 40, 110, 40),
      stamp("Resistor", 150, 40),
      line(190, 40, 240, 40),
      line(240, 40, 240, 70),
      stamp("Resistor", 240, 110, { rotation: 90 }),
      line(240, 150, 240, 170),
      line(240, 170, 60, 170),
      line(60, 170, 60, 142),
      stamp("Battery", 58, 110, { rotation: -90 }),
      line(60, 80, 60, 40),
      text(150, 22, "$R_1$ = {{R1}} Ω", { "text-anchor": "middle" }),
      text(226, 114, "$R_2$ = {{R2}} Ω", { "text-anchor": "end" }),
      text(84, 114, "V = {{V}} V"),
    ],
    [
      { name: "R1", label: "First resistor", units: "Ω", sample: "12" },
      { name: "R2", label: "Second resistor", units: "Ω", sample: "18" },
      { name: "V", label: "Battery voltage", units: "V", sample: "15" },
    ],
    { R1: "12", R2: "18", V: "15" },
    ["Circuits", "Series circuits"],
  );

  drawing(
    "ohms-law-circuit.svg",
    [
      line(60, 50, 120, 50),
      stamp("Resistor", 160, 50),
      line(200, 50, 260, 50),
      line(260, 50, 260, 160),
      line(260, 160, 60, 160),
      line(60, 160, 60, 132),
      stamp("Battery", 58, 100, { rotation: -90 }),
      line(60, 70, 60, 50),
      text(160, 30, "R = ?", { "text-anchor": "middle" }),
      text(84, 104, "V = {{V}} V"),
      text(160, 148, "I = {{I}} A", { "text-anchor": "middle" }),
      arrow(140, 160, 180, "I", { "data-scale": "80", "data-max-length": "60", "data-heads": "end" }),
    ],
    [
      { name: "V", label: "Battery voltage", units: "V", sample: "9.0" },
      { name: "I", label: "Current", units: "A", sample: "0.25" },
    ],
    { V: "9.0", I: "0.25" },
    ["Circuits", "Ohm's law"],
  );

  drawing(
    "parallel-resistors.svg",
    [
      line(50, 100, 100, 100),
      line(100, 50, 100, 150),
      line(100, 50, 120, 50),
      stamp("Resistor", 160, 50),
      line(200, 50, 220, 50),
      line(100, 150, 120, 150),
      stamp("Resistor", 160, 150),
      line(200, 150, 220, 150),
      line(220, 50, 220, 150),
      line(220, 100, 270, 100),
      createShapeAtPoint("point", { x: 50, y: 100 }, style)!,
      createShapeAtPoint("point", { x: 270, y: 100 }, style)!,
      text(160, 32, "$R_1$ = {{R1}} Ω", { "text-anchor": "middle" }),
      text(160, 132, "$R_2$ = {{R2}} Ω", { "text-anchor": "middle" }),
      text(40, 88, "A", { "text-anchor": "middle" }),
      text(280, 88, "B", { "text-anchor": "middle" }),
    ],
    [
      { name: "R1", label: "First resistor", units: "Ω", sample: "6.0" },
      { name: "R2", label: "Second resistor", units: "Ω", sample: "3.0" },
    ],
    { R1: "6.0", R2: "3.0" },
    ["Circuits", "Parallel circuits"],
  );
}

// ---------------------------------------------------------------------------
// New: a force at an angle and its components (variable angle + arc)
// ---------------------------------------------------------------------------
{
  const origin = { x: 70, y: 160 };
  const forces = { "data-scale": "2.4", "data-scale-group": "Force" };
  const arc = createArcFromDrag(origin, { x: origin.x + 34, y: origin.y }, style, "angle");
  if (!arc) throw new Error("arc");
  drawing(
    "force-components.svg",
    [
      line(40, origin.y, 300, origin.y, { stroke: "#808080", "stroke-width": "1" }),
      line(origin.x, 190, origin.x, 20, { stroke: "#808080", "stroke-width": "1" }),
      arrow(origin.x, origin.y, 0, "Fx", { ...forces, ...dashed, stroke: "#595959", "data-label": "$F_x$", "data-label-side": "below" }),
      arrow(origin.x, origin.y, 90, "Fy", { ...forces, ...dashed, stroke: "#595959", "data-label": "$F_y$", "data-label-at": "mid" }),
      arrow(origin.x, origin.y, 0, "force", {
        ...forces,
        "data-angle-variable": "angle",
        "data-label": "F = {{force}} N",
      }),
      setControlAttrs(arc.element, { "data-label": "θ = {{angle}}°", "data-label-side": "outside", "data-label-gap": "14" }),
    ],
    [
      { name: "force", label: "Force", units: "N", sample: "50" },
      { name: "angle", label: "Angle above the horizontal", units: "°", sample: "37" },
      { name: "Fx", formula: "force * cos(angle)", units: "N", show: { kind: "decimals", places: 1 } },
      { name: "Fy", formula: "force * sin(angle)", units: "N", show: { kind: "decimals", places: 1 } },
    ],
    { force: "50", angle: "37" },
    ["Forces", "Vectors", "Components"],
  );
}

// ---------------------------------------------------------------------------
// New: two forces on a box (net force), one scale for both
// ---------------------------------------------------------------------------
{
  const forces = { "data-scale": "1.2", "data-scale-group": "Forces", "data-max-length": "110", "data-min-length": "8" };
  const box = stamp("Block", 159, 110);
  drawing(
    "two-forces-box.svg",
    [
      line(10, 130, 308, 130, { "stroke-width": "2" }),
      box,
      text(159, 111, "{{mass}} kg", { "text-anchor": "middle" }),
      arrow(189, 110, 0, "F1", { ...forces, "data-label": "$F_1$" }),
      arrow(129, 110, 180, "F2", { ...forces, "data-label": "$F_2$" }),
      text(159, 158, "$F_1$ = {{F1}} N, $F_2$ = {{F2}} N", { "text-anchor": "middle" }),
      text(159, 180, "frictionless surface", { "text-anchor": "middle", "font-size": "12", fill: "#595959" }),
    ],
    [
      { name: "F1", label: "Force to the right", units: "N", sample: "60" },
      { name: "F2", label: "Force to the left", units: "N", sample: "35" },
      { name: "mass", label: "Mass of the box", units: "kg", sample: "5" },
    ],
    { F1: "60", F2: "35", mass: "5" },
    ["Forces", "Net force", "Newton's second law"],
  );
}
