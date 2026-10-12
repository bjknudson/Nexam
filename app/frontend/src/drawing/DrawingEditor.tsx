// The drawing editor: tool rail, canvas, inspector. It knows nothing about
// banks or the backend -- the caller hands it SVG text and gets SVG text back
// through onSave. See docs/svg-editor-plan.md.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  controlAnchor,
  controlAngleVariable,
  controlEnd,
  controlKind,
  controlLabelFrame,
  controlPreviewDefaults,
  controlScaleGroup,
  controlUsesCcw,
  controlVariable,
  SHARED_SCALE_ATTRS,
  sharedScale,
  convertToCcw,
  createControlFromDrag,
  dragControlEnd,
  isControl,
  fitToRange,
  isValidVariableName,
  lengthReadout,
  type LengthReadout,
  rebuildControl,
  setControlAttrs,
  uniqueVariableName,
  type BarDirection,
  type ControlKind,
  type RangeFit,
} from "./controls";
import { alignDeltas, distributeDeltas, type AlignEdge, type Box, type Delta } from "./align";
import { directionsFrom, nearestSnap, segmentsOf, snapPoints, type Segment, type SnapPoint } from "./snapping";
import { formatCoefficient } from "./geometry";
import {
  boxCorners,
  boxScaleFromCorner,
  canonicalize,
  framesBox,
  groupCorners,
  readGroupTransform,
  rotateTowards,
  rotationHandle,
  scaleFramesTogether,
  scaleFromCorner,
  topMiddle,
  writeGroupTransform,
  type GroupTransform,
  type Matrix,
} from "./transforms";
import "./drawing.css";
import {
  arcStartPoint,
  dragArcStart,
  fixedArcToVariable,
  isFixedArc,
  radiusReadout,
  readArcSettings,
  readFixedArc,
  type ArcHeads,
} from "./arcs";
import {
  anchorCandidates,
  anchorPointsFor,
  anchorSpotsNear,
  type AnchorSpot,
  anchorTargetId,
  attachText,
  detachText,
  isAnchoredText,
  moveAnchoredText,
  relayoutAnchors,
  uniqueElementId,
  type AnchorPoint,
} from "./anchors";
import { dragInLabelFrame, readLabelSettings } from "./labelLayout";
import LayersPanel from "./LayersPanel";
import StampPanel, { type StampLibraryProps } from "./StampPanel";
import SymbolPicker, { MathHint, insertAtSelection, useCaretAfterUpdate } from "./SymbolPicker";
import { createStampElement, isStamp, type Stamp } from "./stamps";
import { expressionError, previewElement, type PreviewValues } from "./preview";
import {
  CALC_FUNCTIONS,
  createDocument,
  hasPlaceholder,
  listVariables,
  literalNumber,
  type SceneDocument,
  type SceneElement,
} from "./scene";
import {
  POINT_BY_POINT_TOOLS,
  createShapeAtPoint,
  createShapeFromDrag,
  createShapeFromPoints,
  duplicateElement,
  formatNumber,
  getHandles,
  arrowLabelFrame,
  groupScale,
  isArrow,
  isLabeledLine,
  moveHandle,
  rebuildArrow,
  rebuildShape,
  setGroupScale,
  setLineLabel,
  translateElement,
  type ArrowHeads,
  type DrawingTool,
  type Point,
} from "./shapes";
import {
  CANVAS_PRESETS,
  FILL_SWATCHES,
  LINE_TYPES,
  STROKE_SWATCHES,
  STROKE_WEIGHTS,
  applyStrokeAttrs,
  defaultStyle,
  findPreset,
  readStyle,
  type CanvasPreset,
  type DrawingStyle,
  type LineType,
  type Swatch,
} from "./styles";
import { elementMarkup, parseSvg, serializeSvg } from "./svgIO";
import {
  allElements,
  canEnterGroup,
  describeElement,
  groupElements,
  mapDeep,
  lockedKeys,
  moveBetweenGroups,
  toggleLock,
  reorderElements,
  replaceInScope,
  scopeElements,
  ungroupElement,
  updateScope,
  validScope,
  type LayerMove,
  type Scope,
} from "./tree";

export interface DrawingEditorProps {
  /** SVG to open, or null for a new drawing. */
  initialSource: string | null;
  /** Called with the SVG to save; throw to show an error, or return
   *  "cancelled" when the user backed out (the drawing stays unsaved). */
  onSave: (svg: string) => Promise<void | "cancelled">;
  /** Starting preview values, e.g. the variables of the question the drawing was opened from. */
  initialPreviewValues?: PreviewValues;
  /** Topic suggestions for the drawing's Topics & tags: the bank's topics, and
   *  those of the questions that use this drawing (offered first). */
  topicSuggestions?: { bank: string[]; fromQuestions: string[] };
  /** Shown at the left of the toolbar (file name, etc.). */
  headerStart?: ReactNode;
  /** The teacher's own stamps; built-in stamps are always available. */
  stampLibrary?: StampLibraryProps;
}

const TOOLS: { id: DrawingTool; label: string; icon: string; shortcut?: string }[] = [
  { id: "select", label: "Select", icon: "↖", shortcut: "V" },
  { id: "line", label: "Line", icon: "╱", shortcut: "L" },
  { id: "arrow", label: "Arrow", icon: "→", shortcut: "A" },
  { id: "rect", label: "Rectangle", icon: "▭", shortcut: "R" },
  { id: "circle", label: "Circle", icon: "○", shortcut: "C" },
  { id: "ellipse", label: "Ellipse", icon: "⬭", shortcut: "E" },
  { id: "arc", label: "Arc", icon: "◜" },
  { id: "triangle", label: "Triangle", icon: "△" },
  { id: "right-triangle", label: "Right triangle", icon: "◺" },
  { id: "polygon", label: "Polygon", icon: "⬠", shortcut: "P" },
  { id: "polyline", label: "Polyline", icon: "⌇" },
  { id: "point", label: "Point", icon: "•", shortcut: "." },
  { id: "text", label: "Text", icon: "T", shortcut: "T" },
];

const CONTROL_TOOLS: { id: DrawingTool & ControlKind; label: string; icon: string }[] = [
  { id: "variable-arrow", label: "Variable arrow", icon: "⇢" },
  { id: "variable-bar", label: "Variable bar", icon: "▮" },
  { id: "variable-arc", label: "Variable arc", icon: "◠" },
];

function isControlTool(tool: DrawingTool): tool is DrawingTool & ControlKind {
  return tool === "variable-arrow" || tool === "variable-bar" || tool === "variable-arc";
}

const TOOL_HINTS: Partial<Record<DrawingTool, string>> = {
  select: "Click a shape to select it. Drag to move; drag the round handles to reshape.",
  line: "Drag to draw. Hold Shift to snap the angle to 15°.",
  arrow: "Drag from tail to tip. Hold Shift to snap the angle to 15°.",
  rect: "Drag to draw. Hold Shift for a square.",
  circle: "Drag out from the center.",
  arc: "Drag out from the centre to where the arc starts, then drag its end handle to set the sweep.",
  ellipse: "Drag to draw. Hold Shift for a circle.",
  triangle: "Drag to draw. Hold Shift for equal width and height.",
  "right-triangle": "Drag to draw. The right angle is at the bottom left.",
  polygon: "Click to add points. Click the first point or press Enter to close.",
  polyline: "Click to add points. Double-click or press Enter to finish.",
  point: "Click to place a point.",
  text: "Click to place a label, then type in the inspector.",
  "variable-arrow": "Drag from the tail. Its length becomes a variable each question can set.",
  "variable-bar": "Drag up, down, left or right from the base. Its length becomes a variable.",
  "variable-arc": "Drag out from the centre to where the arc starts. Its sweep (degrees, + counterclockwise) becomes a variable.",
};

const ZOOMS = [1, 1.25, 1.5, 2, 3, 4];
const FONT_SIZES = [10, 12, 14, 16, 18, 24];
const HISTORY_LIMIT = 100;
/** Dragging a loose text shows anchor points this close (screen px), and snaps within ANCHOR_SNAP. */
const ANCHOR_REACH = 60;
const ANCHOR_SNAP = 14;
/** An arc's centre snaps to line ends and crossings this close (screen px). */
const CENTRE_SNAP = 10;

type DragState =
  | { mode: "create"; start: Point }
  | {
      mode: "move";
      start: Point;
      originals: SceneElement[];
      before: SceneDocument;
      changed: boolean;
      warned: boolean;
      /** A plain click on one shape of a multi-selection selects just it, on release. */
      clickedKey: string | null;
      /** A loose text dropped here attaches to it. */
      attachTo: AnchorSpot | null;
    }
  | { mode: "handle"; key: string; handleId: string; original: SceneElement; before: SceneDocument; changed: boolean }
  | { mode: "marquee"; start: Point; additive: boolean; base: string[] }
  | {
      /** Several stamps or groups, by a corner of the box around them all. */
      mode: "multiscale";
      corner: number;
      originals: SceneElement[];
      starts: GroupTransform[];
      box: Box;
      before: SceneDocument;
      changed: boolean;
    }
  | {
      mode: "transform";
      key: string;
      action: "scale" | "rotate";
      corner: number;
      original: SceneElement;
      start: GroupTransform;
      startPoint: Point;
      before: SceneDocument;
      changed: boolean;
    }
  | {
      mode: "label";
      key: string;
      original: SceneElement;
      start: Point;
      startOffset: Point;
      frame: number;
      before: SceneDocument;
      changed: boolean;
    };

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export default function DrawingEditor({
  initialSource,
  onSave,
  headerStart,
  stampLibrary,
  initialPreviewValues,
  topicSuggestions,
}: DrawingEditorProps) {
  const initial = useMemo(() => loadDocument(initialSource), [initialSource]);
  const initialPreset = findPreset(canvasSize(initial.document).width) ?? CANVAS_PRESETS[0];

  const [doc, setDoc] = useState<SceneDocument>(initial.document);
  const [past, setPast] = useState<SceneDocument[]>([]);
  const [future, setFuture] = useState<SceneDocument[]>([]);
  const [savedSource, setSavedSource] = useState(() =>
    initialSource === null ? "" : serializeSvg(initial.document),
  );
  // Keys of selected elements, all within the current scope.
  const [selection, setSelection] = useState<string[]>([]);
  // Groups the user has double-clicked into, outermost first.
  const [scopeState, setScope] = useState<Scope>([]);
  // Editor-only: never saved.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // Locks are saved with the drawing (data-nexam-locked), so they come from it.
  const locked = useMemo(() => lockedKeys(doc), [doc]);
  const [tool, setTool] = useState<DrawingTool>("select");
  const [arrowHeads, setArrowHeads] = useState<ArrowHeads>("end");
  const [style, setStyle] = useState<DrawingStyle>(() => defaultStyle(initialPreset));
  const [gridSize, setGridSize] = useState(initialPreset.gridSize);
  const [showGrid, setShowGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(initialPreset.zoom);
  const [previewValues, setPreviewValues] = useState<PreviewValues>(() => ({
    ...defaultPreviewValues(initial.document),
    ...initialPreviewValues,
  }));
  const [draft, setDraft] = useState<SceneElement | null>(null);
  // Preview value for a control being dragged out, before it is committed.
  const [draftValues, setDraftValues] = useState<PreviewValues>({});
  const [polyPoints, setPolyPoints] = useState<Point[]>([]);
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null);
  const [marquee, setMarquee] = useState<Bounds | null>(null);
  const [anchorSpots, setAnchorSpots] = useState<AnchorSpot[]>([]);
  /** Where an arc's centre has snapped to, shown while placing it. */
  const [centreSnap, setCentreSnap] = useState<SnapPoint | null>(null);
  useEffect(() => setCentreSnap(null), [tool]);
  const [selectionBoxes, setSelectionBoxes] = useState<Bounds[]>([]);
  const [scopeBox, setScopeBox] = useState<Bounds | null>(null);
  const [scopeMatrix, setScopeMatrix] = useState<Matrix | null>(null);
  // Canvas position of the selected shape's built-in label, for its drag handle.
  const [labelHandle, setLabelHandle] = useState<Point | null>(null);
  // Where the selected stamp or group sits and how it's turned, for its resize/rotate handles.
  const [groupFrame, setGroupFrame] = useState<GroupTransform | null>(null);
  /** Placements of a multi-selection made only of stamps and groups (they resize together). */
  const [multiFrames, setMultiFrames] = useState<GroupTransform[] | null>(null);
  const [notice, setNotice] = useState<string | null>(initial.notice);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [focusTextField, setFocusTextField] = useState(false);
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [infoMenuOpen, setInfoMenuOpen] = useState(false);
  const [sidebar, setSidebar] = useState(readSidebarPrefs);
  // A press on a stamp tile: becomes a drop if the pointer moves onto the canvas.
  const stampPressRef = useRef<{ stamp: Stamp; x: number; y: number; moved: boolean } | null>(null);
  const [draggingStamp, setDraggingStamp] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const contentRef = useRef<SVGGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const textFieldRef = useRef<HTMLTextAreaElement | null>(null);

  const { width, height } = canvasSize(doc);
  const viewBox = doc.rootAttrs.viewBox ?? `0 0 ${width} ${height}`;
  const scope = validScope(doc, scopeState);
  const scopeId = scope.join("/");
  const scopeList = scopeElements(doc, scope);
  const selectedElements = scopeList.filter((element) => selection.includes(element.key));
  const selected = selectedElements.length === 1 ? selectedElements[0] : null;
  const selectedKeys = new Set(selectedElements.map((element) => element.key));
  const variables = listVariables(doc);
  const scaleGroups = collectScaleGroups(doc);
  const currentSource = serializeSvg(doc);
  const dirty = currentSource !== savedSource;
  const activePreset = findPreset(width);

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  /** Record the current drawing as an undo step before changing it. */
  function snapshot(before: SceneDocument = doc) {
    setPast((items) => [...items, before].slice(-HISTORY_LIMIT));
    setFuture([]);
  }

  /** Every edit goes through here so attached texts follow their shapes. */
  function setDocument(next: SceneDocument | ((current: SceneDocument) => SceneDocument)) {
    setDoc((current) => relayoutAnchors(typeof next === "function" ? next(current) : next));
  }

  function commit(next: SceneDocument) {
    snapshot();
    setDocument(next);
  }

  function undo() {
    if (past.length === 0) return;
    setFuture((items) => [doc, ...items]);
    setDoc(past[past.length - 1]);
    setPast((items) => items.slice(0, -1));
  }

  function redo() {
    if (future.length === 0) return;
    setPast((items) => [...items, doc]);
    setDoc(future[0]);
    setFuture((items) => items.slice(1));
  }

  /** A control's settings changed. Controls sharing a scale group keep one
   *  scale: joining a group adopts its scale; changing it updates them all. */
  function changeControl(changed: SceneElement) {
    const previous = selected;
    let next = changed;
    const group = controlScaleGroup(next);
    let nextDoc: SceneDocument;
    if (group && previous && previous.kind === "group" && next.kind === "group") {
      const joined = previous.attrs["data-scale-group"] !== next.attrs["data-scale-group"];
      const others = allElements(doc.elements).filter(
        (element) => element.key !== next.key && isControl(element) && controlScaleGroup(element) === group,
      );
      if (joined && others[0]?.kind === "group") {
        const adopted = sharedScale(others[0], next);
        next = setControlAttrs(next, adopted.attrs, adopted.remove);
        nextDoc = replaceInScope(doc, scope, next.key, next);
      } else {
        nextDoc = replaceInScope(doc, scope, next.key, next);
        const changedShared = SHARED_SCALE_ATTRS.some((name) => previous.attrs[name] !== (next as typeof previous).attrs[name]);
        if (changedShared && others.length > 0) {
          const keys = new Set(others.map((element) => element.key));
          const source = next;
          nextDoc = {
            ...nextDoc,
            elements: mapDeep(nextDoc.elements, (element) => {
              if (!keys.has(element.key)) return element;
              const shared = sharedScale(source, element);
              return setControlAttrs(element, shared.attrs, shared.remove);
            }),
          };
          setNotice(`Updated the scale of ${others.length} other control${others.length === 1 ? "" : "s"} in “${group}”.`);
        }
      }
    } else {
      nextDoc = replaceInScope(doc, scope, next.key, next);
    }
    commit(nextDoc);
  }

  function updateSelected(next: SceneElement, record: boolean) {
    const updated = replaceInScope(doc, scope, next.key, next);
    if (record) commit(updated);
    else setDocument(updated);
  }

  /** Adds a new element on top of the current scope and selects it. */
  function addElement(element: SceneElement) {
    commit(updateScope(doc, scope, (elements) => [...elements, element]));
    setSelection([element.key]);
    setTool("select");
  }

  function updateSelection(update: (element: SceneElement) => SceneElement) {
    if (selectedElements.length === 0) return;
    commit(updateScope(doc, scope, (elements) => elements.map((element) => (selectedKeys.has(element.key) ? update(element) : element))));
  }

  // ---------------------------------------------------------------------------
  // Coordinates
  // ---------------------------------------------------------------------------

  /** Moves an element; an attached text instead changes its offset from its
   *  shape, and stays put if its shape is moving with it. */
  function moveElement(element: SceneElement, dx: number, dy: number, movingIds: Set<string>): SceneElement | null {
    if (isAnchoredText(element)) {
      const targetId = anchorTargetId(element);
      if (targetId && movingIds.has(targetId)) return element;
      const target = scopeList.find((item) => item.kind !== "passthrough" && item.attrs.id === targetId);
      return moveAnchoredText(element, dx, dy, target);
    }
    return translateElement(element, dx, dy);
  }

  function nodeFor(key: string): SVGGraphicsElement | null {
    return (contentRef.current?.querySelector(`[data-editor-key="${CSS.escape(key)}"]`) as SVGGraphicsElement | null) ?? null;
  }

  function screenToLocal(event: { clientX: number; clientY: number }, node: SVGGraphicsElement | null): Point {
    const matrix = node?.getScreenCTM();
    const svg = svgRef.current;
    if (!svg || !matrix) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }

  /** Canvas (root) coordinates: used for the selection box and stamp drops. */
  function toCanvasPoint(event: { clientX: number; clientY: number }): Point {
    return screenToLocal(event, svgRef.current);
  }

  /** Coordinates inside the entered group, where shapes are drawn and moved. */
  function toLocalPoint(event: { clientX: number; clientY: number }): Point {
    const scopeNode = scope.length > 0 ? nodeFor(scope[scope.length - 1]) : null;
    return screenToLocal(event, scopeNode ?? svgRef.current);
  }

  function toCanvas(point: Point): Point {
    if (!scopeMatrix) return point;
    const { a, b, c, d, e, f } = scopeMatrix;
    return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
  }

  /** An arc's centre near a line end or crossing goes onto it (Alt: freely). */
  function snapCentre(point: Point, skipKey: string | null, free: boolean): Point {
    const found = free ? null : nearestSnap(snapPoints(segmentsOf(scopeList, previewValues), skipKey ?? undefined), point, CENTRE_SNAP / zoom);
    setCentreSnap(found);
    return found ? { x: round2(found.x), y: round2(found.y) } : point;
  }

  function snapPoint(point: Point): Point {
    if (!snap) return { x: round2(point.x), y: round2(point.y) };
    return { x: Math.round(point.x / gridSize) * gridSize, y: Math.round(point.y / gridSize) * gridSize };
  }

  function snapDelta(value: number): number {
    return snap ? Math.round(value / gridSize) * gridSize : round2(value);
  }

  /** A stamp's or group's placement: stored settings, or (for one placed
   *  before centred transforms) worked out from how it is drawn. */
  function frameOfGroup(element: SceneElement): GroupTransform | null {
    const stored = readGroupTransform(element);
    if (stored) return stored;
    const node = nodeFor(element.key);
    if (!node || typeof node.getBBox !== "function") return null;
    const box = node.getBBox();
    const matrix = (node as SVGGraphicsElement).transform?.baseVal.consolidate()?.matrix;
    return canonicalize(
      { x: box.x, y: box.y, width: box.width, height: box.height },
      matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    );
  }

  /** The canvas-space box of an element as the browser drew it. */
  function measure(key: string): Bounds | null {
    const svg = svgRef.current;
    const node = nodeFor(key);
    if (!svg || !node || typeof node.getBBox !== "function") return null;
    const box = node.getBBox();
    const toRoot = svg.getScreenCTM()?.inverse().multiply(node.getScreenCTM() ?? new DOMMatrix());
    const corners = [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(toRoot));
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }

  /** The element of the current scope under the pointer (skipping locked ones). */
  function hitInScope(target: Element): string | null {
    const keys = new Set(scopeList.map((element) => element.key));
    for (let node: Element | null = target; node && node !== svgRef.current; node = node.parentElement) {
      const key = node.getAttribute("data-editor-key");
      if (key && keys.has(key)) return locked.has(key) ? null : key;
    }
    return null;
  }

  /** The top-level element under the pointer, for clicks outside an entered group. */
  function hitAtRoot(target: Element): string | null {
    const keys = new Set(doc.elements.map((element) => element.key));
    let found: string | null = null;
    for (let node: Element | null = target; node && node !== svgRef.current; node = node.parentElement) {
      const key = node.getAttribute("data-editor-key");
      if (key && keys.has(key)) found = key;
    }
    return found && !locked.has(found) ? found : null;
  }

  // ---------------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------------

  // These are on the whole stage, so a selection box can start and end in
  // the empty space around the canvas.
  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest("button, a, input, select, textarea")) return;
    const onCanvas = svgRef.current?.contains(target) ?? false;
    if (!onCanvas && tool !== "select") return;
    const capture = () => event.currentTarget.setPointerCapture(event.pointerId);
    const local = toLocalPoint(event);
    const point = snapPoint(local);

    const handleId = target.getAttribute("data-handle");
    if ((handleId === "rotate" || handleId?.startsWith("corner-")) && selected && groupFrame) {
      dragRef.current = {
        mode: "transform",
        key: selected.key,
        action: handleId === "rotate" ? "rotate" : "scale",
        corner: handleId === "rotate" ? 0 : Number(handleId.slice("corner-".length)),
        original: selected,
        start: groupFrame,
        startPoint: local,
        before: doc,
        changed: false,
      };
      capture();
      return;
    }
    if (handleId?.startsWith("multi-corner-") && multiFrames) {
      dragRef.current = {
        mode: "multiscale",
        corner: Number(handleId.slice("multi-corner-".length)),
        originals: selectedElements,
        starts: multiFrames,
        box: framesBox(multiFrames),
        before: doc,
        changed: false,
      };
      capture();
      return;
    }
    if (handleId === "label" && selected && selected.kind === "group") {
      const settings = readLabelSettings(selected.attrs, "data-label");
      dragRef.current = {
        mode: "label",
        key: selected.key,
        original: selected,
        start: local,
        startOffset: { x: settings.dx, y: settings.dy },
        frame: isControl(selected)
          ? controlLabelFrame(selected, previewValues)
          : isFixedArc(selected)
            ? 0
            : arrowLabelFrame(selected),
        before: doc,
        changed: false,
      };
      capture();
      return;
    }
    if (handleId && selected) {
      dragRef.current = { mode: "handle", key: selected.key, handleId, original: selected, before: doc, changed: false };
      capture();
      return;
    }

    if (tool === "select") {
      const key = hitInScope(target);
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;

      if (!key) {
        const outside = scope.length > 0 ? hitAtRoot(target) : null;
        if (outside) {
          // Clicking something outside the entered group leaves the group.
          setScope([]);
          setSelection([outside]);
          return;
        }
        dragRef.current = { mode: "marquee", start: toCanvasPoint(event), additive, base: additive ? selection : [] };
        if (!additive) setSelection([]);
        capture();
        return;
      }

      let next = selection.filter((item) => selectedKeys.has(item));
      // Pressing on a shape that's part of a multi-selection keeps the group
      // (so it can be dragged together); releasing without a drag selects it alone.
      const narrowOnRelease = !additive && next.length > 1 && next.includes(key) ? key : null;
      if (additive) {
        if (next.includes(key)) {
          setSelection(next.filter((item) => item !== key));
          return;
        }
        next = [...next, key];
      } else if (!next.includes(key)) {
        next = [key];
      }
      setSelection(next);
      const moving = new Set(next);
      dragRef.current = {
        mode: "move",
        start: local,
        originals: scopeList.filter((item) => moving.has(item.key)),
        before: doc,
        changed: false,
        warned: false,
        clickedKey: narrowOnRelease,
        attachTo: null,
      };
      capture();
      return;
    }

    if (tool === "point" || tool === "text") {
      const element = createShapeAtPoint(tool, point, style);
      if (element) {
        addElement(element);
        if (tool === "text") setFocusTextField(true);
      }
      return;
    }

    if (POINT_BY_POINT_TOOLS.includes(tool)) {
      const first = polyPoints[0];
      const closesPolygon =
        tool === "polygon" &&
        polyPoints.length >= 3 &&
        first !== undefined &&
        Math.hypot(first.x - point.x, first.y - point.y) <= 8 / zoom + (snap ? gridSize / 2 : 0);
      if (closesPolygon) {
        finishPolyShape(polyPoints);
      } else {
        setPolyPoints((points) => [...points, point]);
      }
      return;
    }

    const isArcTool = tool === "arc" || tool === "variable-arc";
    dragRef.current = { mode: "create", start: isArcTool ? snapCentre(local, null, event.altKey) : point };
    capture();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;

    if (!drag) {
      if (POINT_BY_POINT_TOOLS.includes(tool) && polyPoints.length > 0) setHoverPoint(snapPoint(toLocalPoint(event)));
      // Show where a new arc's centre would snap before pressing.
      if (tool === "arc" || tool === "variable-arc") snapCentre(toLocalPoint(event), null, event.altKey);
      return;
    }

    if (drag.mode === "marquee") {
      const end = toCanvasPoint(event);
      // Clamped to the canvas: a box dragged out past the edge selects up to it.
      const origin = viewBoxOrigin(viewBox);
      const clamp = (value: number, min: number, size: number) => Math.min(Math.max(value, min), min + size);
      const x1 = clamp(Math.min(drag.start.x, end.x), origin.x, width);
      const y1 = clamp(Math.min(drag.start.y, end.y), origin.y, height);
      const x2 = clamp(Math.max(drag.start.x, end.x), origin.x, width);
      const y2 = clamp(Math.max(drag.start.y, end.y), origin.y, height);
      setMarquee({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
      return;
    }

    const local = toLocalPoint(event);

    if (drag.mode === "transform") {
      const next =
        drag.action === "rotate"
          ? rotateTowards(drag.start, drag.startPoint, local, event.shiftKey)
          : scaleFromCorner(drag.start, drag.corner, local, event.altKey);
      if (!drag.changed) {
        snapshot(drag.before);
        drag.changed = true;
      }
      setDocument((current) => replaceInScope(current, scope, drag.key, writeGroupTransform(drag.original, next)));
      return;
    }

    if (drag.mode === "multiscale") {
      const { factor, about } = boxScaleFromCorner(drag.box, drag.corner, local, event.altKey);
      const frames = scaleFramesTogether(drag.starts, about, Math.round(factor * 1000) / 1000);
      const placed = new Map(drag.originals.map((element, index) => [element.key, writeGroupTransform(element, frames[index])]));
      if (!drag.changed) {
        snapshot(drag.before);
        drag.changed = true;
      }
      setDocument((current) => updateScope(current, scope, (elements) => elements.map((element) => placed.get(element.key) ?? element)));
      return;
    }

    if (drag.mode === "label") {
      const offset = dragInLabelFrame({ x: local.x - drag.start.x, y: local.y - drag.start.y }, drag.frame);
      const attrs = {
        "data-label-dx": formatNumber(drag.startOffset.x + offset.x),
        "data-label-dy": formatNumber(drag.startOffset.y + offset.y),
      };
      const next = isControl(drag.original)
        ? setControlAttrs(drag.original, attrs)
        : rebuildShape({ ...drag.original, attrs: { ...(drag.original as { attrs: Record<string, string> }).attrs, ...attrs } } as SceneElement);
      if (!drag.changed) {
        snapshot(drag.before);
        drag.changed = true;
      }
      setDocument((current) => replaceInScope(current, scope, drag.key, next));
      return;
    }

    if (drag.mode === "create") {
      if (isControlTool(tool)) {
        const created = createControlFromDrag(tool, drag.start, snapPoint(local), style, listVariables(doc), gridSize * 2);
        setDraft(created?.element ?? null);
        setDraftValues(created ? { [created.variable]: String(created.value) } : {});
        return;
      }
      const end = constrain(tool, drag.start, snapPoint(local), event.shiftKey);
      const shape = createShapeFromDrag(tool, drag.start, end, style);
      setDraft(shape && isArrow(shape) ? withArrowHeads(shape, arrowHeads) : shape);
      return;
    }

    if (drag.mode === "move") {
      let dx = snapDelta(local.x - drag.start.x);
      let dy = snapDelta(local.y - drag.start.y);
      // A single arc moved by its body: its centre snaps to line ends and crossings.
      const centre = drag.originals.length === 1 ? arcCentre(drag.originals[0]) : null;
      if (centre) {
        const unsnapped = { x: centre.x + dx, y: centre.y + dy };
        const target = snapCentre(unsnapped, drag.originals[0].key, event.altKey);
        if (target !== unsnapped) {
          dx = round2(target.x - centre.x);
          dy = round2(target.y - centre.y);
        }
      }
      if (dx === 0 && dy === 0 && !drag.changed) return;
      const moved = new Map<string, SceneElement>();
      const movingIds = idsOf(drag.originals);
      for (const original of drag.originals) {
        const next = moveElement(original, dx, dy, movingIds);
        if (next) moved.set(original.key, next);
      }
      if (moved.size === 0) {
        const only = drag.originals[0];
        setNotice(
          drag.originals.length === 1 && only.kind === "passthrough"
            ? `Nexam can't move <${only.tagName}> yet. It is kept exactly as it was.`
            : "The position of this selection uses variables, so it can't be dragged. Change it in the inspector.",
        );
        dragRef.current = null;
        return;
      }
      if (moved.size < drag.originals.length && !drag.warned) {
        setNotice("Some selected shapes have variable or uneditable positions, so they stay where they are.");
        drag.warned = true;
      }
      if (!drag.changed) {
        snapshot(drag.before);
        drag.changed = true;
      }
      setDocument((current) => updateScope(current, scope, (elements) => elements.map((element) => moved.get(element.key) ?? element)));
      // A single loose text shows the anchor points near the pointer and
      // snaps to the closest; Alt drops it without attaching.
      const only = drag.originals[0];
      if (drag.originals.length === 1 && only.kind === "text" && !isAnchoredText(only) && !event.altKey) {
        const spots = anchorSpotsNear(scopeList, only, local, ANCHOR_REACH / zoom, previewValues);
        drag.attachTo = spots[0] && spots[0].distance <= ANCHOR_SNAP / zoom ? spots[0] : null;
        setAnchorSpots(spots);
      } else if (drag.attachTo || anchorSpots.length > 0) {
        drag.attachTo = null;
        setAnchorSpots([]);
      }
      return;
    }

    if (isControl(drag.original)) {
      const point = snapPoint(local);
      const arc = readArcSettings(drag.original);
      if (arc && drag.handleId === "start") {
        const result = dragArcStart(arc, point);
        setPreviewValues((values) => ({ ...values, ...result.preview }));
        if (Object.keys(result.attrs).length === 0) return;
        if (!drag.changed) {
          snapshot(drag.before);
          drag.changed = true;
        }
        setDocument((current) => replaceInScope(current, scope, drag.key, setControlAttrs(drag.original, result.attrs)));
        return;
      }
      if (drag.handleId === "end") {
        const result = dragControlEnd(drag.original, point, previewValues);
        if (!result) return;
        setPreviewValues((values) => ({ ...values, ...result.preview }));
        if (result.element === drag.original) return;
        if (!drag.changed) {
          snapshot(drag.before);
          drag.changed = true;
        }
        setDocument((current) => replaceInScope(current, scope, drag.key, result.element));
        return;
      }
      const anchor = controlAnchor(drag.original);
      const to = arc ? snapCentre(local, drag.key, event.altKey) : point;
      const moved = anchor ? translateElement(drag.original, to.x - anchor.x, to.y - anchor.y) : null;
      if (!moved) return;
      if (!drag.changed) {
        snapshot(drag.before);
        drag.changed = true;
      }
      setDocument((current) => replaceInScope(current, scope, drag.key, moved));
      return;
    }

    if (!drag.changed) {
      snapshot(drag.before);
      drag.changed = true;
    }
    // Reshape the shape as it is now, not as it was when the drag began, so a
    // handle that follows the pointer round (an arc's sweep) stays continuous.
    const point = snapPoint(local);
    setDocument((current) => {
      const live = scopeElements(current, scope).find((element) => element.key === drag.key) ?? drag.original;
      return replaceInScope(current, scope, drag.key, moveHandle(live, drag.handleId, point));
    });
  }

  // Pointer events always report detail 0, so double-clicks are handled here.
  function handleDoubleClick(event: ReactMouseEvent<HTMLElement>) {
    if (POINT_BY_POINT_TOOLS.includes(tool)) {
      // Both clicks of the double-click already added a point; drop the repeats.
      const points = polyPoints.filter(
        (point, index) => index === 0 || Math.hypot(point.x - polyPoints[index - 1].x, point.y - polyPoints[index - 1].y) > 0.5,
      );
      finishPolyShape(points);
      return;
    }
    if (tool !== "select") return;
    // The first click's pointer capture retargets the dblclick to the <svg>,
    // so look up what is actually under the pointer.
    const target = document.elementFromPoint(event.clientX, event.clientY) ?? (event.target as Element);
    const key = hitInScope(target);
    const element = key ? scopeList.find((item) => item.key === key) : undefined;
    if (!element) return;
    if (element.kind === "group" && canEnterGroup(element)) {
      // Enter the group (or stamp) and select the part under the pointer.
      const childKeys = new Set(element.children.map((child) => child.key));
      let childKey: string | null = null;
      for (let node: Element | null = target; node && node !== svgRef.current; node = node.parentElement) {
        const candidate = node.getAttribute("data-editor-key");
        if (candidate && childKeys.has(candidate) && !locked.has(candidate)) {
          childKey = candidate;
          break;
        }
      }
      setScope([...scope, element.key]);
      setSelection(childKey ? [childKey] : []);
    } else if (element.kind === "text") {
      setSelection([element.key]);
      setFocusTextField(true);
    }
  }

  function handlePointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (tool !== "arc" && tool !== "variable-arc") setCentreSnap(null);
    if (drag?.mode === "move" && !drag.changed && drag.clickedKey) {
      setSelection([drag.clickedKey]);
      return;
    }
    if (drag?.mode === "move") {
      setAnchorSpots([]);
      const spot = drag.attachTo;
      if (spot && drag.changed) {
        // Part of the same undo step as the move.
        setDocument((current) => {
          const elements = scopeElements(current, scope);
          const text = elements.find((element) => element.key === drag.originals[0].key);
          const target = elements.find((element) => element.key === spot.target.key);
          if (!text || !target) return current;
          const result = attachText(current, text, target, spot.point);
          return updateScope(current, scope, (list) =>
            list.map((element) => (element.key === target.key ? result.target : element.key === text.key ? result.text : element)),
          );
        });
        setNotice(`Attached to ${describeElement(spot.target)} · ${spot.label}. Undo, or Detach in the inspector, frees it.`);
      }
      return;
    }
    if (drag?.mode === "marquee") {
      if (marquee && (marquee.width > 2 || marquee.height > 2)) {
        const hits = scopeList
          .filter((element) => !hidden.has(element.key) && !locked.has(element.key))
          .filter((element) => {
            const box = measure(element.key);
            return box !== null && intersects(box, marquee);
          })
          .map((element) => element.key);
        setSelection([...new Set([...drag.base, ...hits])]);
      }
      setMarquee(null);
      return;
    }
    if (drag?.mode === "create") {
      if (draft) {
        addElement(draft);
        setPreviewValues((values) => ({ ...values, ...draftValues }));
      }
      setDraft(null);
      setDraftValues({});
    }
  }

  function finishPolyShape(points: Point[]) {
    const element = createShapeFromPoints(tool, points, style);
    setPolyPoints([]);
    setHoverPoint(null);
    if (element) addElement(element);
  }

  function chooseTool(next: DrawingTool) {
    setTool(next);
    setPolyPoints([]);
    setHoverPoint(null);
    setDraft(null);
    if (next !== "select") setSelection([]);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  function deleteSelected() {
    if (selectedElements.length === 0) return;
    const deletedIds = idsOf(selectedElements);
    let detached = 0;
    commit(
      updateScope(doc, scope, (elements) =>
        elements
          .filter((element) => !selectedKeys.has(element.key))
          .map((element) => {
            const targetId = anchorTargetId(element);
            if (!targetId || !deletedIds.has(targetId)) return element;
            detached += 1;
            return detachText(element, previewValues);
          }),
      ),
    );
    setSelection([]);
    if (detached > 0) {
      setNotice(`${detached} attached text${detached === 1 ? " was" : "s were"} left where ${detached === 1 ? "it is" : "they are"}, no longer attached. Undo brings the shape back.`);
    }
  }

  function duplicateSelected() {
    if (selectedElements.length === 0) return;
    const copies: string[] = [];
    // Copies of shapes get their own ids; copied texts attached to a copied
    // shape follow the copy, others stay attached to the original.
    const newIds = new Map<string, string>();
    const taken = new Set<string>();
    const next = updateScope(doc, scope, (elements) =>
      elements.flatMap((element) => {
        if (!selectedKeys.has(element.key)) return [element];
        let copy = duplicateElement(element, gridSize);
        if (copy.kind !== "passthrough" && copy.attrs.id) {
          const id = uniqueElementId(doc, copy, taken.size === 0 ? undefined : taken);
          taken.add(id);
          newIds.set(copy.attrs.id, id);
          copy = { ...copy, attrs: { ...copy.attrs, id } } as SceneElement;
        }
        copies.push(copy.key);
        return [element, copy];
      }),
    );
    const relinked = updateScope(next, scope, (elements) =>
      elements.map((element) => {
        const targetId = copies.includes(element.key) ? anchorTargetId(element) : null;
        const copyId = targetId ? newIds.get(targetId) : undefined;
        return copyId && element.kind === "text"
          ? { ...element, attrs: { ...element.attrs, "data-nexam-anchor": copyId } }
          : element;
      }),
    );
    commit(relinked);
    setSelection(copies);
  }

  function attachSelectedText(targetKey: string, point: AnchorPoint) {
    let target = scopeList.find((element) => element.key === targetKey);
    if (!selected || !target) return;
    // A group placed before centred transforms is measured and converted
    // first, so the text has a frame to follow (nothing moves).
    if (target.kind === "group" && canEnterGroup(target) && !readGroupTransform(target)) {
      const frame = frameOfGroup(target);
      if (frame) target = writeGroupTransform(target, frame);
    }
    const result = attachText(doc, selected, target, point);
    commit(
      updateScope(doc, scope, (elements) =>
        elements.map((element) => (element.key === target.key ? result.target : element.key === selected.key ? result.text : element)),
      ),
    );
  }

  /** The matrix from a scope's own coordinates to the canvas, as drawn. */
  function scopeFrame(path: Scope): Matrix {
    const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const svg = svgRef.current;
    const node = path.length > 0 ? nodeFor(path[path.length - 1]) : null;
    if (!svg || !node) return identity;
    const m = svg.getScreenCTM()?.inverse().multiply(node.getScreenCTM() ?? new DOMMatrix());
    return m ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } : identity;
  }

  /** A Layers row dropped onto another: restack, or move into or out of a
   *  group, keeping it where it's drawn. The moved row is then selected. */
  function moveLayer(from: Scope, key: string, to: Scope, targetKey: string) {
    const toDom = ({ a, b, c, d, e, f }: Matrix) => new DOMMatrix([a, b, c, d, e, f]);
    const source = toDom(scopeFrame(from));
    const target = toDom(scopeFrame(to));
    const m = target.inverse().multiply(source);
    const result = moveBetweenGroups(doc, key, from, to, targetKey, { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f });
    if (!result) return;
    commit(result.document);
    if (from.join("/") !== to.join("/")) {
      setScope(to);
      setSelection([result.key]);
    }
  }

  /** Resizes every selected stamp or group by `factor`: about the centre of
   *  the box around them all (so their spacing grows too), or each in place. */
  function resizeTogether(factor: number, inPlace: boolean) {
    if (!multiFrames || !(factor > 0)) return;
    const box = framesBox(multiFrames);
    const frames = scaleFramesTogether(multiFrames, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, factor, inPlace);
    const placed = new Map(selectedElements.map((element, index) => [element.key, writeGroupTransform(element, frames[index])]));
    commit(updateScope(doc, scope, (elements) => elements.map((element) => placed.get(element.key) ?? element)));
  }

  /** Moves elements by canvas-space amounts (converted into the entered
   *  group's coordinates), skipping any whose position is a variable. */
  function moveSelectionBy(deltas: Map<string, Delta>) {
    const movingIds = idsOf(selectedElements);
    let stuck = 0;
    const toLocal = (delta: Delta): Delta => {
      if (!scopeMatrix) return delta;
      const { a, b, c, d } = scopeMatrix;
      const det = a * d - b * c || 1;
      return { dx: (d * delta.dx - c * delta.dy) / det, dy: (a * delta.dy - b * delta.dx) / det };
    };
    const next = updateScope(doc, scope, (elements) =>
      elements.map((element) => {
        const delta = deltas.get(element.key);
        if (!delta || (Math.abs(delta.dx) < 0.005 && Math.abs(delta.dy) < 0.005)) return element;
        const local = toLocal(delta);
        const moved = moveElement(element, round2(local.dx), round2(local.dy), movingIds);
        if (!moved) {
          stuck += 1;
          return element;
        }
        return moved;
      }),
    );
    commit(next);
    if (stuck > 0) setNotice(`${stuck} selected shape${stuck === 1 ? " has" : "s have"} a variable position, so ${stuck === 1 ? "it stays" : "they stay"} put.`);
  }

  function measuredSelection(): { key: string; box: Box }[] {
    return selectedElements.flatMap((element) => {
      const box = measure(element.key);
      return box ? [{ key: element.key, box }] : [];
    });
  }

  /** Several: line up with their combined bounds. One: on the canvas. */
  function alignSelection(edge: AlignEdge) {
    const measured = measuredSelection();
    if (measured.length === 0) return;
    const origin = viewBoxOrigin(viewBox);
    const reference = measured.length === 1 ? { x: origin.x, y: origin.y, width, height } : undefined;
    const deltas = alignDeltas(measured.map((item) => item.box), edge, reference);
    moveSelectionBy(new Map(measured.map((item, index) => [item.key, deltas[index]])));
  }

  function distributeSelection(axis: "horizontal" | "vertical") {
    const measured = measuredSelection();
    if (measured.length < 3) return;
    const deltas = distributeDeltas(measured.map((item) => item.box), axis);
    moveSelectionBy(new Map(measured.map((item, index) => [item.key, deltas[index]])));
  }

  function moveLayers(move: LayerMove) {
    if (selectedElements.length === 0) return;
    commit(updateScope(doc, scope, (elements) => reorderElements(elements, selectedKeys, move)));
  }

  function groupSelected() {
    if (selectedElements.length === 0) return;
    let groupKey: string | null = null;
    const next = updateScope(doc, scope, (elements) => {
      const result = groupElements(elements, selectedKeys);
      if (!result) return elements;
      groupKey = result.group.key;
      return result.elements;
    });
    if (!groupKey) return;
    commit(next);
    setSelection([groupKey]);
  }

  function ungroupSelected() {
    const groups = selectedElements.filter((element) => element.kind === "group");
    if (groups.length === 0) return;
    const childKeys: string[] = [];
    const converted: string[] = [];
    const next = updateScope(doc, scope, (elements) =>
      groups.reduce((list, group) => {
        const result = ungroupElement(list, group.key);
        if (!result) return list;
        childKeys.push(...result.childKeys);
        if (result.converted) converted.push(result.converted);
        return result.elements;
      }, elements),
    );
    commit(next);
    setSelection(childKeys);
    if (converted.length > 0) {
      setNotice(
        `Ungrouped the ${[...new Set(converted)].join(" and ")} into plain shapes. They no longer update as a control or arrow; undo to bring that back.`,
      );
    }
  }

  function nudgeSelected(dx: number, dy: number) {
    if (selectedElements.length === 0) return;
    const movingIds = idsOf(selectedElements);
    updateSelection((element) => moveElement(element, dx, dy, movingIds) ?? element);
  }

  function selectAll() {
    setTool("select");
    setSelection(scopeList.filter((element) => !hidden.has(element.key) && !locked.has(element.key)).map((element) => element.key));
  }

  function exitScope(levels = 1) {
    if (scope.length === 0) return;
    const nextScope = scope.slice(0, Math.max(0, scope.length - levels));
    setScope(nextScope);
    setSelection([scope[nextScope.length]]);
  }

  function updateSidebar(patch: Partial<SidebarPrefs>, persist = true) {
    setSidebar((current) => {
      const next = { ...current, ...patch };
      if (persist) writeSidebarPrefs(next);
      return next;
    });
  }

  function applyPreset(preset: CanvasPreset) {
    commit(resizeDocument(doc, preset.width, preset.height));
    setGridSize(preset.gridSize);
    setZoom(preset.zoom);
    setStyle((current) => ({ ...current, strokeWidth: preset.strokeWidth, fontSize: preset.fontSize }));
  }

  function changeStyle(patch: Partial<DrawingStyle>) {
    if (selectedElements.length > 0) {
      updateSelection((element) => applyStylePatch(element, patch, style));
    } else {
      setStyle((current) => ({ ...current, ...patch }));
    }
  }

  function insertStamp(stamp: Stamp, at?: Point) {
    const origin = viewBoxOrigin(viewBox);
    const center = at ?? { x: origin.x + width / 2, y: origin.y + height / 2 };
    let element: SceneElement;
    try {
      element = createStampElement(stamp, center, { width, height });
    } catch (error) {
      setNotice(`${stamp.name}: ${error instanceof Error ? error.message : "could not be added."}`);
      return;
    }
    // Stamps are placed in canvas coordinates, so they always go on the drawing itself.
    commit({ ...doc, elements: [...doc.elements, element] });
    setScope([]);
    setSelection([element.key]);
    setTool("select");
    setPreviewValues((values) => ({ ...defaultPreviewValues({ rootAttrs: {}, elements: [element] }), ...values }));
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      // Variable-angle arrows remember the preview direction in data-angle,
      // so the file reopens pointing the way it was last shown.
      const synced = withSavedPreview(
        { ...doc, elements: doc.elements.map((element) => rememberPreviewAngle(element, previewValues)) },
        previewValues,
      );
      const svg = serializeSvg(synced);
      if ((await onSave(svg)) === "cancelled") {
        setSaveMessage("Not saved");
        return;
      }
      if (svg !== serializeSvg(doc)) setDoc(synced);
      setSavedSource(svg);
      setSaveMessage("Saved");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Selection outlines and the entered group's frame, measured from what the
  // browser actually drew so they work for every element and transform.
  useLayoutEffect(() => {
    setSelectionBoxes(selectedElements.flatMap((element) => measure(element.key) ?? []));
    setGroupFrame(selected && selected.kind === "group" && canEnterGroup(selected) ? frameOfGroup(selected) : null);
    const allPlaced =
      selectedElements.length > 1 && selectedElements.every((element) => element.kind === "group" && canEnterGroup(element));
    const frames = allPlaced ? selectedElements.map(frameOfGroup) : [];
    setMultiFrames(allPlaced && frames.every(Boolean) ? (frames as GroupTransform[]) : null);
    const labelKey = selected ? builtInLabelKey(selected) : null;
    const labelBox = labelKey ? measure(labelKey) : null;
    setLabelHandle(labelBox ? { x: labelBox.x + labelBox.width / 2, y: labelBox.y + labelBox.height / 2 } : null);
    const svg = svgRef.current;
    const scopeNode = scope.length > 0 ? nodeFor(scope[scope.length - 1]) : null;
    if (svg && scopeNode) {
      setScopeBox(measure(scope[scope.length - 1]));
      const matrix = svg.getScreenCTM()?.inverse().multiply(scopeNode.getScreenCTM() ?? new DOMMatrix());
      setScopeMatrix(matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : null);
    } else {
      setScopeBox(null);
      setScopeMatrix(null);
    }
  }, [doc, selection, scopeId, zoom, previewValues, hidden]);

  // Keep the selection inside the scope after undo/redo removes things.
  useEffect(() => {
    if (scopeId !== scopeState.join("/")) setScope(scope);
    if (selection.some((key) => !selectedKeys.has(key))) setSelection(selection.filter((key) => selectedKeys.has(key)));
  });

  useEffect(() => {
    if (focusTextField && textFieldRef.current) {
      textFieldRef.current.focus();
      textFieldRef.current.select();
      setFocusTextField(false);
    }
  }, [focusTextField, selection]);

  // Finishing a press on a stamp tile: a drag that ends over the canvas drops
  // the stamp there; a plain click adds it to the middle of the canvas.
  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      const press = stampPressRef.current;
      if (!press || press.moved) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
        press.moved = true;
        setDraggingStamp(true);
      }
    }
    function onPointerUp(event: PointerEvent) {
      const press = stampPressRef.current;
      stampPressRef.current = null;
      setDraggingStamp(false);
      if (!press) return;
      if (!press.moved) {
        insertStamp(press.stamp);
        return;
      }
      const rect = svgRef.current?.getBoundingClientRect();
      const overCanvas =
        rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (overCanvas) insertStamp(press.stamp, snapPoint(toCanvasPoint(event)));
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  });

  // Keyboard shortcuts. Skipped while typing in a field, except Save.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (command && key === "s") {
        event.preventDefault();
        void save();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // A dialog over the editor (e.g. the save choice) owns the keyboard.
      if (document.querySelector('[aria-modal="true"]')) return;

      if (command && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (command && key === "d") {
        event.preventDefault();
        duplicateSelected();
      } else if (command && key === "a") {
        event.preventDefault();
        selectAll();
      } else if (command && key === "g") {
        event.preventDefault();
        if (event.shiftKey) ungroupSelected();
        else groupSelected();
      } else if (command && (event.code === "BracketRight" || event.code === "BracketLeft")) {
        event.preventDefault();
        const forward = event.code === "BracketRight";
        moveLayers(event.shiftKey ? (forward ? "front" : "back") : forward ? "forward" : "backward");
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
      } else if (event.key === "Escape") {
        if (polyPoints.length > 0 || draft) {
          setPolyPoints([]);
          setHoverPoint(null);
          setDraft(null);
        } else if (selectedElements.length > 0) {
          setSelection([]);
        } else {
          exitScope();
        }
        setTool("select");
      } else if (event.key === "Enter" && polyPoints.length > 0) {
        finishPolyShape(polyPoints);
      } else if (event.key.startsWith("Arrow") && selectedElements.length > 0) {
        event.preventDefault();
        const step = event.shiftKey ? gridSize : 1;
        const [dx, dy] =
          event.key === "ArrowLeft" ? [-step, 0] : event.key === "ArrowRight" ? [step, 0] : event.key === "ArrowUp" ? [0, -step] : [0, step];
        nudgeSelected(dx, dy);
      } else if (!command && !event.altKey) {
        const match = TOOLS.find((item) => item.shortcut?.toLowerCase() === key);
        if (match) chooseTool(match.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Warn before closing the window with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const visibleElements = withoutHidden(doc.elements, hidden).map((element) => previewElement(element, previewValues));
  const contentMarkup = visibleElements.map(elementMarkup).join("\n");
  const draftMarkup = draft ? elementMarkup(previewElement(draft, { ...previewValues, ...draftValues })) : "";
  const groupHandles =
    groupFrame && tool === "select"
      ? [
          ...groupCorners(groupFrame).map((corner, index) => ({ id: `corner-${index}`, ...corner })),
          { id: "rotate", ...rotationHandle(groupFrame, 20 / zoom) },
        ]
      : [];
  const angleVariables = collectAngleVariables(doc);
  const lineChoices: LineChoice[] = segmentsOf(scopeList, previewValues).map((segment) => {
    const element = scopeList.find((item) => item.key === segment.key)!;
    return { ...segment, label: describeElement(element), angleVariable: controlAngleVariable(element) };
  });
  const multiBox = multiFrames && tool === "select" ? framesBox(multiFrames) : null;
  const handles =
    selected && tool === "select"
      ? [...selectionHandles(selected, previewValues), ...groupHandles].map((handle) => ({ ...handle, ...toCanvas(handle) }))
      : multiBox
        ? boxCorners(multiBox).map((corner, index) => ({ id: `multi-corner-${index}`, ...toCanvas(corner) }))
        : [];
  const multiOutline = multiBox ? boxCorners(multiBox).map(toCanvas) : null;
  const groupOutline = groupFrame && tool === "select" ? groupCorners(groupFrame).map(toCanvas) : null;
  const rotateStem = groupFrame && tool === "select" ? [toCanvas(topMiddle(groupFrame)), toCanvas(rotationHandle(groupFrame, 20 / zoom))] : null;
  const canvasStyle = selected ? readStyle(selected, style) : style;
  const pixel = 1 / zoom;
  const scopeTransform = scopeMatrix
    ? `matrix(${scopeMatrix.a} ${scopeMatrix.b} ${scopeMatrix.c} ${scopeMatrix.d} ${scopeMatrix.e} ${scopeMatrix.f})`
    : undefined;
  const scopeNames = scope.map((key, index) => {
    const element = scopeElements(doc, scope.slice(0, index)).find((item) => item.key === key);
    return element ? describeElement(element) : "Group";
  });
  const elementActions = {
    onAlign: alignSelection,
    onDistribute: distributeSelection,
    selectionCount: selectedElements.length,
    onDuplicate: duplicateSelected,
    onDelete: deleteSelected,
    onLayer: moveLayers,
    onGroup: groupSelected,
    onUngroup: selectedElements.some((element) => element.kind === "group") ? ungroupSelected : undefined,
  };

  return (
    <div className={`drawing-editor ${draggingStamp ? "dragging-stamp" : ""}`}>
      <header className="drawing-toolbar">
        <div className="drawing-toolbar-group drawing-toolbar-title">{headerStart}</div>
        <div className="drawing-toolbar-group">
          <div className="drawing-canvas-menu">
            <button
              type="button"
              aria-expanded={canvasMenuOpen}
              onClick={() => setCanvasMenuOpen((open) => !open)}
              title="Canvas size and grid"
            >
              Canvas: {activePreset?.label ?? `${formatNumber(width)}×${formatNumber(height)}`} ▾
            </button>
            {canvasMenuOpen ? (
              <CanvasMenu
                width={width}
                height={height}
                gridSize={gridSize}
                activePresetId={activePreset?.id ?? null}
                onPreset={(preset) => applyPreset(preset)}
                onResize={(nextWidth, nextHeight) => commit(resizeDocument(doc, nextWidth, nextHeight))}
                onGridSize={setGridSize}
                onClose={() => setCanvasMenuOpen(false)}
              />
            ) : null}
          </div>
          <div className="drawing-canvas-menu">
            <button
              type="button"
              aria-expanded={infoMenuOpen}
              onClick={() => setInfoMenuOpen((open) => !open)}
              title="Topics and tags help find this drawing in the bank's assets"
            >
              Topics{listAttr(doc.rootAttrs["data-nexam-topics"]).length + listAttr(doc.rootAttrs["data-nexam-tags"]).length > 0
                ? ` (${listAttr(doc.rootAttrs["data-nexam-topics"]).length + listAttr(doc.rootAttrs["data-nexam-tags"]).length})`
                : ""} ▾
            </button>
            {infoMenuOpen ? (
              <TopicsMenu
                topics={listAttr(doc.rootAttrs["data-nexam-topics"])}
                tags={listAttr(doc.rootAttrs["data-nexam-tags"])}
                suggestions={topicSuggestions}
                stampCategories={stampCategoriesIn(doc)}
                onChange={(name, values) =>
                  commit({ ...doc, rootAttrs: withListAttr(doc.rootAttrs, name, values) })
                }
                onClose={() => setInfoMenuOpen(false)}
              />
            ) : null}
          </div>
          <label>
            Zoom
            <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
              {ZOOMS.map((value) => (
                <option key={value} value={value}>
                  {Math.round(value * 100)}%
                </option>
              ))}
            </select>
          </label>
          <label className="drawing-check">
            <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />
            Grid
          </label>
          <label className="drawing-check">
            <input type="checkbox" checked={snap} onChange={(event) => setSnap(event.target.checked)} />
            Snap
          </label>
        </div>
        <div className="drawing-toolbar-group">
          <button type="button" onClick={undo} disabled={past.length === 0} title="Undo (⌘Z)">
            Undo
          </button>
          <button type="button" onClick={redo} disabled={future.length === 0} title="Redo (⇧⌘Z)">
            Redo
          </button>
          <span className={`drawing-save-status ${dirty ? "dirty" : ""}`}>
            {saving ? "Saving…" : dirty ? "Unsaved changes" : saveMessage ?? "No changes"}
          </span>
          <button type="button" className="primary" onClick={() => void save()} disabled={saving} title="Save (⌘S)">
            Save
          </button>
        </div>
      </header>

      {notice ? (
        <div className="drawing-notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="drawing-body">
        <nav className="drawing-tools" aria-label="Drawing tools">
          <div className="drawing-tool-grid" role="toolbar" aria-label="Shapes">
            {TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={tool === item.id ? "active" : ""}
                onClick={() => chooseTool(item.id)}
                title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
                aria-label={item.label}
              >
                <span className="drawing-tool-icon" aria-hidden="true">
                  {item.icon}
                </span>
              </button>
            ))}
          </div>
          <h4 className="drawing-tools-heading">Variable controls</h4>
          <div className="drawing-tool-grid wide" role="toolbar" aria-label="Variable controls">
            {CONTROL_TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={tool === item.id ? "active" : ""}
                onClick={() => chooseTool(item.id)}
                title={item.label}
                aria-label={item.label}
              >
                <span className="drawing-tool-icon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </div>
          {tool === "arrow" ? (
            <label className="drawing-tool-option">
              Arrowheads
              <select value={arrowHeads} onChange={(event) => setArrowHeads(event.target.value as ArrowHeads)}>
                <option value="end">At tip</option>
                <option value="start">At tail</option>
                <option value="both">Both ends</option>
              </select>
            </label>
          ) : null}
          <StampPanel
            library={stampLibrary}
            onPointerDownStamp={(stamp, event) => {
              event.preventDefault();
              stampPressRef.current = { stamp, x: event.clientX, y: event.clientY, moved: false };
            }}
          />
        </nav>

        <main
          className="drawing-stage"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          onPointerLeave={() => setHoverPoint(null)}
        >
          {scope.length > 0 ? (
            <nav className="drawing-breadcrumb" aria-label="Editing inside">
              <button type="button" onClick={() => exitScope(scope.length)}>
                Drawing
              </button>
              {scopeNames.map((name, index) => (
                <span key={scope[index]}>
                  {" › "}
                  {index === scopeNames.length - 1 ? (
                    <strong>{name}</strong>
                  ) : (
                    <button type="button" onClick={() => exitScope(scope.length - 1 - index)}>
                      {name}
                    </button>
                  )}
                </span>
              ))}
              <span className="drawing-muted"> · Escape to leave</span>
            </nav>
          ) : null}
          <div className="drawing-canvas-frame">
            <svg
              ref={svgRef}
              className={`drawing-canvas tool-${tool}`}
              xmlns="http://www.w3.org/2000/svg"
              viewBox={viewBox}
              width={width * zoom}
              height={height * zoom}
            >
              <defs>
                <pattern id="drawing-grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
                  <path
                    d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`}
                    fill="none"
                    stroke="#d6dde6"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                </pattern>
              </defs>
              <rect x={viewBoxOrigin(viewBox).x} y={viewBoxOrigin(viewBox).y} width={width} height={height} fill="#ffffff" />
              {showGrid ? (
                <rect
                  x={viewBoxOrigin(viewBox).x}
                  y={viewBoxOrigin(viewBox).y}
                  width={width}
                  height={height}
                  fill="url(#drawing-grid)"
                  pointerEvents="none"
                />
              ) : null}
              <g ref={contentRef} dangerouslySetInnerHTML={{ __html: contentMarkup }} />
              {/* Wide invisible strokes on top so thin lines are easy to click. */}
              <g
                className="drawing-hit-layer"
                style={{ ["--hit-width" as string]: String(10 / zoom) }}
                dangerouslySetInnerHTML={{ __html: contentMarkup }}
              />
              {scopeBox ? (
                <rect
                  className="drawing-scope-frame"
                  x={scopeBox.x - 6 * pixel}
                  y={scopeBox.y - 6 * pixel}
                  width={scopeBox.width + 12 * pixel}
                  height={scopeBox.height + 12 * pixel}
                  pointerEvents="none"
                />
              ) : null}
              {draftMarkup ? (
                <g pointerEvents="none" transform={scopeTransform} dangerouslySetInnerHTML={{ __html: draftMarkup }} />
              ) : null}
              {polyPoints.length > 0 ? (
                <g pointerEvents="none">
                  <polyline
                    points={[...polyPoints, ...(hoverPoint ? [hoverPoint] : [])]
                      .map(toCanvas)
                      .map((p) => `${p.x},${p.y}`)
                      .join(" ")}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                  {polyPoints.map(toCanvas).map((p, index) => (
                    <circle key={index} cx={p.x} cy={p.y} r={3 * pixel} fill={index === 0 ? "#2563eb" : "#ffffff"} stroke="#2563eb" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  ))}
                </g>
              ) : null}
              {groupOutline ? (
                <polygon
                  className="drawing-selection"
                  points={groupOutline.map((point) => `${point.x},${point.y}`).join(" ")}
                  pointerEvents="none"
                />
              ) : null}
              {multiOutline ? (
                <polygon
                  className="drawing-selection"
                  points={multiOutline.map((point) => `${point.x},${point.y}`).join(" ")}
                  pointerEvents="none"
                />
              ) : null}
              {rotateStem ? (
                <line
                  className="drawing-rotate-stem"
                  x1={rotateStem[0].x}
                  y1={rotateStem[0].y}
                  x2={rotateStem[1].x}
                  y2={rotateStem[1].y}
                  pointerEvents="none"
                />
              ) : null}
              {tool === "select" && !groupOutline
                ? selectionBoxes.map((box, index) => (
                    <rect
                      key={index}
                      className="drawing-selection"
                      x={box.x - 3 * pixel}
                      y={box.y - 3 * pixel}
                      width={box.width + 6 * pixel}
                      height={box.height + 6 * pixel}
                      pointerEvents="none"
                    />
                  ))
                : null}
              {marquee ? (
                <rect className="drawing-marquee" x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height} pointerEvents="none" />
              ) : null}
              {centreSnap ? (
                <circle
                  className="drawing-anchor-spot snapped"
                  cx={toCanvas(centreSnap).x}
                  cy={toCanvas(centreSnap).y}
                  r={5 * pixel}
                  pointerEvents="none"
                />
              ) : null}
              {anchorSpots.map((spot, index) => {
                const at = toCanvas(spot);
                const snapped = index === 0 && spot.distance <= ANCHOR_SNAP / zoom;
                return (
                  <g key={`${spot.target.key}-${spot.point}`} pointerEvents="none">
                    <circle className={`drawing-anchor-spot${snapped ? " snapped" : ""}`} cx={at.x} cy={at.y} r={(snapped ? 6 : 4) * pixel} />
                    {snapped ? (
                      <text className="drawing-anchor-spot-label" x={at.x + 9 * pixel} y={at.y - 9 * pixel} fontSize={11 * pixel}>
                        {spot.label}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              {labelHandle && tool === "select" ? (
                <rect
                  className="drawing-handle drawing-label-handle"
                  data-handle="label"
                  x={labelHandle.x - 4 * pixel}
                  y={labelHandle.y - 4 * pixel}
                  width={8 * pixel}
                  height={8 * pixel}
                >
                  <title>Drag to move the label</title>
                </rect>
              ) : null}
              {handles.map((handle) => (
                <circle
                  key={handle.id}
                  className={`drawing-handle ${handle.id === "rotate" ? "rotate" : handle.id.includes("corner-") ? "corner" : ""}`}
                  data-handle={handle.id}
                  cx={handle.x}
                  cy={handle.y}
                  r={5 * pixel}
                />
              ))}
            </svg>
          </div>
          <p className="drawing-hint">
            {polyPoints.length > 0
              ? "Press Enter to finish, Escape to cancel."
              : tool === "select"
                ? "Click to select; Shift- or ⌘/Ctrl-click to add; drag on empty space to select an area. Double-click a group or stamp to edit inside it."
                : TOOL_HINTS[tool]}
            {activePreset ? ` · ${activePreset.hint}` : ""}
          </p>
        </main>

        <aside className="drawing-sidebar">
          <div className="drawing-inspector">
          {selectedElements.length > 1 ? (
            <MultiInspector
              elements={selectedElements}
              fallback={style}
              frames={multiFrames}
              onStyle={changeStyle}
              onResize={resizeTogether}
              actions={elementActions}
            />
          ) : selected && controlKind(selected) === "variable-arc" ? (
            <ArcInspector
              element={selected}
              style={canvasStyle}
              previewValues={previewValues}
              usedNames={variables}
              angleVariables={angleVariables}
              lines={lineChoices}
              onStyle={changeStyle}
              onPreviewValues={(patch) => setPreviewValues((values) => ({ ...values, ...patch }))}
              onChange={(next) => updateSelected(next, true)}
              onRename={(next, from, to) => {
                updateSelected(next, true);
                setPreviewValues((values) => {
                  const { [from]: moved, ...rest } = values;
                  return moved === undefined || rest[to] !== undefined ? rest : { ...rest, [to]: moved };
                });
              }}
              actions={elementActions}
            />
          ) : selected && isControl(selected) ? (
            <ControlInspector
              element={selected}
              style={canvasStyle}
              previewValues={previewValues}
              usedNames={variables}
              angleVariables={angleVariables}
              scaleGroups={scaleGroups.map((group) => group.name)}
              onStyle={changeStyle}
              onPreviewValues={(patch) => setPreviewValues((values) => ({ ...values, ...patch }))}
              onChange={changeControl}
              onNotice={setNotice}
              onRename={(next, from, to) => {
                updateSelected(next, true);
                setPreviewValues((values) => {
                  const { [from]: moved, ...rest } = values;
                  return moved === undefined || rest[to] !== undefined ? rest : { ...rest, [to]: moved };
                });
              }}
              actions={elementActions}
            />
          ) : selected ? (
            <SelectionInspector
              element={selected}
              style={canvasStyle}
              textFieldRef={textFieldRef}
              onStyle={changeStyle}
              onBeginEdit={() => snapshot()}
              onLiveChange={(next) => updateSelected(next, false)}
              onChange={(next) => updateSelected(next, true)}
              onEnter={canEnterGroup(selected) ? () => {
                setScope([...scope, selected.key]);
                setSelection([]);
              } : undefined}
              siblings={scopeList}
              lines={lineChoices}
              onAttach={attachSelectedText}
              onDetach={() => updateSelected(detachText(selected, previewValues), true)}
              groupFrame={groupFrame}
              onMakeVariable={() => {
                const name = uniqueVariableName("arc_angle", variables);
                const converted = fixedArcToVariable(selected, name);
                if (!converted) return;
                updateSelected(converted.element, true);
                setPreviewValues((values) => ({ ...values, [name]: formatNumber(converted.sweep) }));
              }}
              actions={elementActions}
            />
          ) : (
            <section className="drawing-panel">
              {scope.length > 0 ? (
                <p className="drawing-muted">
                  Editing inside <strong>{scopeNames[scopeNames.length - 1]}</strong>. New shapes go into it. Press Escape to leave.
                </p>
              ) : null}
              <h3>New shape style</h3>
              <StyleControls style={style} kind="any" onStyle={changeStyle} />
              <p className="drawing-muted">Canvas size and grid are under “Canvas” in the toolbar.</p>
            </section>
          )}

          <SidebarSection
            title={`Variables${variables.length > 0 ? ` (${variables.length})` : ""}`}
            open={sidebar.variablesOpen}
            onToggle={() => updateSidebar({ variablesOpen: !sidebar.variablesOpen })}
          >
            {variables.length === 0 ? (
              <p className="drawing-muted">
                No variables yet. Type <code>{"{{name}}"}</code> in a text label, e.g. <code>{"{{mass}} kg"}</code>.
              </p>
            ) : (
              <>
                <div className="drawing-variable-list">
                  {variables.map((name) => (
                    <label key={name}>
                      <code>{name}</code>
                      <input
                        value={previewValues[name] ?? ""}
                        placeholder="preview value"
                        onChange={(event) => setPreviewValues((values) => ({ ...values, [name]: event.target.value }))}
                      />
                    </label>
                  ))}
                </div>
                <p className="drawing-muted">
                  Preview values only. Each question sets its own values for these variables.
                </p>
              </>
            )}
            {scaleGroups.length > 0 ? (
              <div className="drawing-scale-groups">
                <h4>Scale groups</h4>
                <ul>
                  {scaleGroups.map((group) => (
                    <li key={group.name}>
                      <strong>{group.name}</strong> · {group.scale} · {group.count} control{group.count === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </SidebarSection>
          </div>

          <section
            className={`drawing-layers-dock ${sidebar.layersOpen ? "open" : ""}`}
            style={sidebar.layersOpen ? { height: `${sidebar.layersHeight}px` } : undefined}
          >
            {sidebar.layersOpen ? (
              <div
                className="drawing-layers-resize"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize layers"
                onPointerDown={(event) => {
                  event.preventDefault();
                  const startY = event.clientY;
                  const startHeight = sidebar.layersHeight;
                  const onMove = (move: PointerEvent) =>
                    updateSidebar({ layersHeight: Math.min(600, Math.max(120, startHeight + (startY - move.clientY))) }, false);
                  const onUp = () => {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    updateSidebar({}, true);
                  };
                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                }}
              />
            ) : null}
            <button
              type="button"
              className="drawing-section-header"
              aria-expanded={sidebar.layersOpen}
              onClick={() => updateSidebar({ layersOpen: !sidebar.layersOpen })}
            >
              <span aria-hidden="true">{sidebar.layersOpen ? "▾" : "▸"}</span> Layers
            </button>
            {sidebar.layersOpen ? (
              <div className="drawing-layers-body">
                <LayersPanel
                  elements={doc.elements}
                  scope={scope}
                  selection={selectedElements.map((element) => element.key)}
                  hidden={hidden}
                  locked={locked}
                  onSelect={(path, key, additive) => {
                    const samePlace = path.join("/") === scopeId;
                    setTool("select");
                    setScope(path);
                    setSelection(
                      additive && samePlace
                        ? selection.includes(key)
                          ? selection.filter((item) => item !== key)
                          : [...selection, key]
                        : [key],
                    );
                  }}
                  onToggleHidden={(key) => setHidden((current) => toggleInSet(current, key))}
                  onToggleLocked={(key) => commit(toggleLock(doc, key))}
                  onMove={moveLayer}
                />
              </div>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Inspector
// -----------------------------------------------------------------------------

function SelectionInspector({
  element,
  style,
  textFieldRef,
  onStyle,
  onBeginEdit,
  onLiveChange,
  onChange,
  onEnter,
  siblings,
  lines,
  onAttach,
  onDetach,
  onMakeVariable,
  groupFrame,
  actions,
}: {
  element: SceneElement;
  style: DrawingStyle;
  textFieldRef: MutableRefObject<HTMLTextAreaElement | null>;
  onStyle: (patch: Partial<DrawingStyle>) => void;
  onBeginEdit: () => void;
  onLiveChange: (next: SceneElement) => void;
  onChange: (next: SceneElement) => void;
  /** Present for groups and stamps: edit the parts inside. */
  onEnter?: () => void;
  /** Other elements at the same level, which a text can be attached to. */
  siblings: SceneElement[];
  /** Lines and arrows at the same level, for lining up an arc's start. */
  lines: LineChoice[];
  onAttach: (targetKey: string, point: AnchorPoint) => void;
  onDetach: () => void;
  /** For a fixed arc: turn it into a variable arc. */
  onMakeVariable: () => void;
  /** For a stamp or group: where it sits and how it's turned. */
  groupFrame: GroupTransform | null;
  actions: ElementActionProps;
}) {
  const kind = inspectorKind(element);
  const placeTextCaret = useCaretAfterUpdate(textFieldRef, element.kind === "text" ? element.text ?? "" : "");
  const setAttr = (name: string, value: string, live: boolean) => {
    if (element.kind === "passthrough") return;
    const next = { ...element, attrs: { ...element.attrs, [name]: value } } as SceneElement;
    const rebuilt = rebuildShape(next);
    if (live) onLiveChange(rebuilt);
    else onChange(rebuilt);
  };

  const isText = element.kind === "text";
  const canLabel = element.kind === "line" || isArrow(element);
  const placed = groupFrame && element.kind === "group" && canEnterGroup(element) ? groupFrame : null;
  const fixedArc = isFixedArc(element) && element.kind === "group" ? element : null;
  const fields = element.kind !== "passthrough" && !fixedArc ? geometryFields(element) : [];

  const look =
    kind !== "passthrough" && kind !== "group" ? (
      <>
        <StyleControls style={style} kind={kind} onStyle={onStyle} />
        {isText && !isAnchoredText(element) ? (
          <div className="drawing-stack">
            Align text
            <div className="drawing-segmented" role="group" aria-label="Alignment">
              {(["start", "middle", "end"] as const).map((anchor) => (
                <button
                  key={anchor}
                  type="button"
                  className={((element.kind === "text" && element.attrs["text-anchor"]) || "start") === anchor ? "active" : ""}
                  onClick={() => setAttr("text-anchor", anchor, false)}
                >
                  {anchor === "start" ? "Left" : anchor === "middle" ? "Center" : "Right"}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {isArrow(element) ? (
          <label className="drawing-stack">
            Arrowheads
            <select
              value={element.kind === "group" ? element.attrs["data-heads"] ?? "end" : "end"}
              onChange={(event) => setAttr("data-heads", event.target.value, false)}
            >
              <option value="end">At tip</option>
              <option value="start">At tail</option>
              <option value="both">Both ends</option>
              {isLabeledLine(element) ? <option value="none">None</option> : null}
            </select>
          </label>
        ) : null}
        {fixedArc ? <FixedArcLook element={fixedArc} onChange={onChange} /> : null}
      </>
    ) : null;

  const label = isText ? (
    <div className="drawing-stack">
      <div className="drawing-field-with-symbols">
        <textarea
          ref={textFieldRef}
          rows={2}
          aria-label="Text"
          value={element.kind === "text" ? element.text ?? "" : ""}
          onFocus={onBeginEdit}
          onChange={(event) => element.kind === "text" && onLiveChange({ ...element, text: event.target.value })}
        />
        <SymbolPicker
          fieldRef={textFieldRef}
          onInsert={(insert) => {
            if (element.kind !== "text") return;
            const next = insertAtSelection(element.text ?? "", textFieldRef.current, insert);
            placeTextCaret(next.caret);
            onChange({ ...element, text: next.value });
          }}
        />
      </div>
      <MathHint text={element.kind === "text" ? element.text ?? "" : ""} />
      <span className="drawing-muted">
        Type <code>{"{{name}}"}</code> for a variable, e.g. <code>{"{{mass}} kg"}</code>, and math between <code>$…$</code>, e.g.{" "}
        <code>{"$v_0$"}</code>.
      </span>
    </div>
  ) : canLabel ? (
    <>
      <LabelField
        value={element.kind === "group" ? element.attrs["data-label"] ?? "" : ""}
        onCommit={(text) => onChange(setLineLabel(element, text))}
      />
      {element.kind === "group" && (element.attrs["data-label"] ?? "").trim() !== "" ? (
        <LabelPlacementEditor
          attrs={element.attrs}
          prefix="data-label"
          points={[
            { value: "start", label: isLabeledLine(element) ? "Start" : "Tail" },
            { value: "mid", label: "Middle" },
            { value: "end", label: isLabeledLine(element) ? "End" : "Tip" },
          ]}
          onChange={(patch, remove) => {
            const attrs = { ...element.attrs, ...patch };
            for (const name of remove) delete attrs[name];
            onChange(rebuildShape({ ...element, attrs }));
          }}
        />
      ) : null}
    </>
  ) : fixedArc ? (
    <FixedArcLabel element={fixedArc} onChange={onChange} />
  ) : null;

  const place =
    placed && element.kind === "group" ? (
      <>
        <div className="drawing-field-grid">
          <NumberField label="Centre x" value={placed.cx} onCommit={(next) => onChange(writeGroupTransform(element, { ...placed, cx: next }))} />
          <NumberField label="Centre y" value={placed.cy} onCommit={(next) => onChange(writeGroupTransform(element, { ...placed, cy: next }))} />
          <NumberField
            label="Size (%)"
            value={Math.round(placed.scale * 1000) / 10}
            onCommit={(next) => next > 0 && onChange(writeGroupTransform(element, { ...placed, scale: next / 100 }))}
          />
          <NumberField
            label="Rotation (°)"
            value={Math.round(placed.rotation * 10) / 10}
            onCommit={(next) => onChange(writeGroupTransform(element, { ...placed, rotation: next }))}
          />
        </div>
        <div className="drawing-actions">
          <button type="button" title="Rotate 90° counterclockwise" onClick={() => onChange(writeGroupTransform(element, { ...placed, rotation: placed.rotation - 90 }))}>
            ⟲ 90°
          </button>
          <button type="button" title="Rotate 90° clockwise" onClick={() => onChange(writeGroupTransform(element, { ...placed, rotation: placed.rotation + 90 }))}>
            ⟳ 90°
          </button>
          <button
            type="button"
            title="Flip left-right"
            aria-pressed={!!placed.flipX}
            className={placed.flipX ? "active" : ""}
            onClick={() => onChange(writeGroupTransform(element, { ...placed, flipX: !placed.flipX }))}
          >
            ⇋ Flip
          </button>
          <button
            type="button"
            title="Flip upside down"
            aria-pressed={!!placed.flipY}
            className={placed.flipY ? "active" : ""}
            onClick={() => onChange(writeGroupTransform(element, { ...placed, flipY: !placed.flipY }))}
          >
            ⇵ Flip
          </button>
        </div>
        <p className="drawing-muted">Drag a corner to resize (Alt: from the centre), or the round handle above to rotate (Shift: freely).</p>
      </>
    ) : fixedArc ? (
      <FixedArcPlace element={fixedArc} lines={lines.filter((line) => !line.angleVariable)} onChange={onChange} />
    ) : fields.length > 0 || isText ? (
      <>
        {fields.length > 0 && element.kind !== "passthrough" ? (
          <div className="drawing-field-grid">
            {fields.map((field) => {
              const value = element.attrs[field.name];
              if (field.text || hasPlaceholder(value)) {
                return (
                  <label key={field.name} className={field.text ? "wide" : ""}>
                    {field.label}
                    <input
                      value={value ?? ""}
                      readOnly={hasPlaceholder(value)}
                      title={hasPlaceholder(value) ? "Set by a variable" : undefined}
                      className={hasPlaceholder(value) ? "drawing-variable-value" : ""}
                      onFocus={onBeginEdit}
                      onChange={(event) => setAttr(field.name, event.target.value, true)}
                    />
                  </label>
                );
              }
              return (
                <NumberField
                  key={field.name}
                  label={field.label}
                  value={literalNumber(value) ?? 0}
                  onCommit={(next) => setAttr(field.name, formatNumber(next), false)}
                />
              );
            })}
          </div>
        ) : null}
        {isText ? <AttachSection element={element} siblings={siblings} onAttach={onAttach} onDetach={onDetach} onChange={onChange} /> : null}
      </>
    ) : null;

  const more =
    onEnter || fixedArc || element.kind === "passthrough" ? (
      <>
        {onEnter ? (
          <button type="button" onClick={onEnter} title="Or double-click it on the canvas">
            Edit parts inside
          </button>
        ) : null}
        {fixedArc ? (
          <button type="button" onClick={onMakeVariable} title="Each question can then set how far the arc goes">
            Make sweep a variable
          </button>
        ) : null}
        {element.kind === "passthrough" ? (
          <p className="drawing-muted">
            Nexam can't edit <code>&lt;{element.tagName}&gt;</code> yet. It is saved exactly as it was.
          </p>
        ) : null}
      </>
    ) : null;

  return (
    <InspectorLayout
      title={isStamp(element) && element.kind === "group" ? `Stamp: ${element.attrs["data-nexam-stamp"]}` : fixedArc ? "Arc" : KIND_LABELS[kind]}
      look={look}
      labelTitle={isText ? "Text" : "Label"}
      label={label}
      place={place}
      more={more}
      actions={actions}
    />
  );
}

/** Every inspector lays its settings out in the same order, so a setting
 *  shared by different kinds of item (a label, a weight, a rotation) is
 *  always found in the same place:
 *    Appearance → Label (or Text) → Position → Settings → Arrange.
 *  A setting that a variable can drive stays in its usual place and shows
 *  the variable there (with a preview slider) instead of a number. */
function InspectorLayout({
  title,
  look,
  labelTitle = "Label",
  label,
  place,
  placeTitle = "Position",
  more,
  moreTitle = "Settings",
  note,
  actions,
}: {
  title: string;
  look?: ReactNode;
  labelTitle?: string;
  label?: ReactNode;
  place?: ReactNode;
  placeTitle?: string;
  more?: ReactNode;
  moreTitle?: string;
  note?: ReactNode;
  actions: ElementActionProps;
}) {
  return (
    <section className="drawing-panel drawing-inspector-layout">
      <h3>{title}</h3>
      <InspectorGroup title="Appearance">{look}</InspectorGroup>
      <InspectorGroup title={labelTitle}>{label}</InspectorGroup>
      <InspectorGroup title={placeTitle}>{place}</InspectorGroup>
      <InspectorGroup title={moreTitle}>{more}</InspectorGroup>
      <InspectorGroup title="Arrange">
        <ElementActions {...actions} />
      </InspectorGroup>
      {note ? <div className="drawing-inspector-note">{note}</div> : null}
    </section>
  );
}

function InspectorGroup({ title, children }: { title: string; children?: ReactNode }) {
  if (children === null || children === undefined || children === false) return null;
  return (
    <div className="drawing-inspector-group" role="group" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </div>
  );
}

interface ElementActionProps {
  onAlign: (edge: AlignEdge) => void;
  onDistribute: (axis: "horizontal" | "vertical") => void;
  selectionCount: number;
  onDuplicate: () => void;
  onDelete: () => void;
  onLayer: (move: LayerMove) => void;
  onGroup: () => void;
  /** Present when the selection includes a group. */
  onUngroup?: () => void;
}

const ALIGN_BUTTONS: { edge: AlignEdge; label: string; title: string }[] = [
  { edge: "left", label: "⇤", title: "Align left edges" },
  { edge: "center", label: "↔", title: "Align centres (left-right)" },
  { edge: "right", label: "⇥", title: "Align right edges" },
  { edge: "top", label: "⤒", title: "Align top edges" },
  { edge: "middle", label: "↕", title: "Align middles (up-down)" },
  { edge: "bottom", label: "⤓", title: "Align bottom edges" },
];

function ElementActions({ onAlign, onDistribute, selectionCount, onDuplicate, onDelete, onLayer, onGroup, onUngroup }: ElementActionProps) {
  const onCanvas = selectionCount === 1;
  return (
    <>
      <div className="drawing-stack">
        {onCanvas ? "Align on canvas" : "Align"}
        <div className="drawing-segmented drawing-align" role="group" aria-label={onCanvas ? "Align on canvas" : "Align"}>
          {ALIGN_BUTTONS.map((item) => (
            <button
              key={item.edge}
              type="button"
              title={onCanvas ? item.title.replace(/edges|centres|middles/, (word) => word.replace(/s$/, "")) + " with the canvas" : item.title}
              aria-label={item.title}
              onClick={() => onAlign(item.edge)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {selectionCount >= 3 ? (
          <div className="drawing-segmented" role="group" aria-label="Distribute">
            <button type="button" title="Equal gaps left to right" onClick={() => onDistribute("horizontal")}>
              Space ↔
            </button>
            <button type="button" title="Equal gaps top to bottom" onClick={() => onDistribute("vertical")}>
              Space ↕
            </button>
          </div>
        ) : null}
      </div>
      <div className="drawing-stack">
        Layer
        <div className="drawing-segmented" role="group" aria-label="Layer order">
          <button type="button" onClick={() => onLayer("front")} title="Bring to front (⇧⌘])">
            Front
          </button>
          <button type="button" onClick={() => onLayer("forward")} title="Bring forward (⌘])">
            Forward
          </button>
          <button type="button" onClick={() => onLayer("backward")} title="Send backward (⌘[)">
            Backward
          </button>
          <button type="button" onClick={() => onLayer("back")} title="Send to back (⇧⌘[)">
            Back
          </button>
        </div>
      </div>
      <div className="drawing-actions">
        <button type="button" onClick={onGroup} title="Group (⌘G)">
          Group
        </button>
        {onUngroup ? (
          <button type="button" onClick={onUngroup} title="Ungroup (⇧⌘G)">
            Ungroup
          </button>
        ) : null}
        <button type="button" onClick={onDuplicate} title="Duplicate (⌘D)">
          Duplicate
        </button>
        <button type="button" className="danger" onClick={onDelete} title="Delete (⌫)">
          Delete
        </button>
      </div>
    </>
  );
}

/** Several elements selected: shared style (marked "Mixed" where they differ) and actions. */
function MultiInspector({
  elements,
  fallback,
  frames,
  onStyle,
  onResize,
  actions,
}: {
  elements: SceneElement[];
  fallback: DrawingStyle;
  /** Set when every selected element is a stamp or group. */
  frames: GroupTransform[] | null;
  onStyle: (patch: Partial<DrawingStyle>) => void;
  onResize: (factor: number, inPlace: boolean) => void;
  actions: ElementActionProps;
}) {
  const [inPlace, setInPlace] = useState(false);
  const styles = elements.filter((element) => element.kind !== "passthrough").map((element) => readStyle(element, fallback));
  const first = styles[0] ?? fallback;
  const mixed: MixedStyle = {};
  for (const name of Object.keys(first) as (keyof DrawingStyle)[]) {
    mixed[name] = styles.some((item) => item[name] !== first[name]);
  }
  const allText = elements.every((element) => element.kind === "text");
  return (
    <InspectorLayout
      title={`${elements.length} selected`}
      look={
        <>
          <StyleControls style={first} kind={allText ? "text" : "shape"} mixed={mixed} onStyle={onStyle} />
          <p className="drawing-muted">Style changes apply to every selected shape that has that setting.</p>
        </>
      }
      place={frames ? <ResizeTogether frames={frames} inPlace={inPlace} onInPlace={setInPlace} onResize={onResize} /> : null}
      placeTitle="Size"
      actions={actions}
    />
  );
}

/** Size controls for several stamps at once. A common size can be typed;
 *  mixed sizes can be grown or shrunk together, or made all the same. */
function ResizeTogether({
  frames,
  inPlace,
  onInPlace,
  onResize,
}: {
  frames: GroupTransform[];
  inPlace: boolean;
  onInPlace: (inPlace: boolean) => void;
  onResize: (factor: number, inPlace: boolean) => void;
}) {
  const common = frames.every((frame) => Math.abs(frame.scale - frames[0].scale) < 0.0005) ? frames[0].scale : null;
  return (
    <div className="drawing-stack">
      <div className="drawing-field-grid">
        {common !== null ? (
          <NumberField
            label="Size (%)"
            value={Math.round(common * 1000) / 10}
            onCommit={(next) => next > 0 && onResize(next / 100 / common, inPlace)}
          />
        ) : (
          <span className="drawing-muted">Sizes differ.</span>
        )}
        <div className="drawing-segmented" role="group" aria-label="Resize together">
          <button type="button" title="10% smaller" onClick={() => onResize(1 / 1.1, inPlace)}>
            −
          </button>
          <button type="button" title="10% larger" onClick={() => onResize(1.1, inPlace)}>
            +
          </button>
        </div>
      </div>
      <div className="drawing-segmented" role="group" aria-label="Spacing when resizing">
        <button type="button" className={inPlace ? "" : "active"} onClick={() => onInPlace(false)} title="Spacing grows and shrinks with them, like one picture">
          As one picture
        </button>
        <button type="button" className={inPlace ? "active" : ""} onClick={() => onInPlace(true)} title="Each keeps its centre">
          Each in place
        </button>
      </div>
      <span className="drawing-muted">Or drag a corner of the box around them. Alt resizes about the centre.</span>
    </div>
  );
}

/** Direction buttons. Counterclockwise from the positive x-axis (90° up) for
 *  current arrows; old clockwise arrows keep their own meanings until converted. */
function arrowDirections(ccw: boolean): { label: string; angle: number }[] {
  return [
    { label: "↑", angle: ccw ? 90 : -90 },
    { label: "→", angle: 0 },
    { label: "↓", angle: ccw ? 270 : 90 },
    { label: "←", angle: 180 },
  ];
}

const BAR_DIRECTIONS: { label: string; direction: BarDirection }[] = [
  { label: "↑", direction: "up" },
  { label: "→", direction: "right" },
  { label: "↓", direction: "down" },
  { label: "←", direction: "left" },
];

function sameAngle(a: number, b: number): boolean {
  return (((a - b) % 360) + 360) % 360 === 0;
}

/** Inspector for a variable arrow or bar: its variables and preview values,
 *  direction, length scaling, and the usual style controls. */
function ControlInspector({
  element,
  style,
  previewValues,
  usedNames,
  angleVariables,
  scaleGroups,
  onStyle,
  onPreviewValues,
  onChange,
  onRename,
  onNotice,
  actions,
}: {
  element: SceneElement;
  style: DrawingStyle;
  previewValues: PreviewValues;
  usedNames: string[];
  angleVariables: string[];
  /** Scale groups already used in the drawing, for suggestions. */
  scaleGroups: string[];
  onStyle: (patch: Partial<DrawingStyle>) => void;
  onPreviewValues: (patch: PreviewValues) => void;
  onChange: (next: SceneElement) => void;
  onRename: (next: SceneElement, from: string, to: string) => void;
  onNotice: (message: string) => void;
  actions: ElementActionProps;
}) {
  const kind = controlKind(element);
  const variable = controlVariable(element);
  const angleVariable = controlAngleVariable(element);
  if (element.kind !== "group" || !kind || !variable) return null;

  const attrs = element.attrs;
  const ccw = controlUsesCcw(element);
  const set = (next: Record<string, string>, remove: string[] = []) =>
    onChange(setControlAttrs(element, next, remove));
  const lengthText = previewValues[variable] ?? "";
  const length = Number(lengthText) || 0;
  const lengthMax = Math.max(100, Math.ceil((length * 1.5) / 10) * 10);
  const fixedAngle = literalNumber(attrs["data-angle"]) ?? 0;
  const angleText = angleVariable ? previewValues[angleVariable] ?? "" : String(fixedAngle);
  const angle = angleVariable ? Number(angleText) || 0 : fixedAngle;

  const setDirection = (degrees: number) => {
    set({ "data-angle": String(degrees) });
    if (angleVariable) onPreviewValues({ [angleVariable]: String(degrees) });
  };
  const makeAngleVariable = () => {
    const name = uniqueVariableName("arrow_angle", [...usedNames, variable]);
    set({ "data-angle-variable": name });
    onPreviewValues({ [name]: formatNumber(fixedAngle) });
  };
  const makeAngleFixed = () => {
    set({ "data-angle": formatNumber(angle) }, ["data-angle-variable"]);
  };
  const convertAngles = () => {
    const converted = convertToCcw(element);
    onChange(converted.element);
    if (converted.angleVariable) {
      const name = converted.angleVariable;
      const current = Number(previewValues[name]);
      if (Number.isFinite(current)) onPreviewValues({ [name]: formatNumber(-current) });
      onNotice(
        `This arrow now measures ${name} counterclockwise. Questions that set ${name} need its sign flipped (for example −30 becomes 30) to draw the same as before.`,
      );
    }
  };

  const isArrowControl = kind === "variable-arrow";

  const look = (
    <>
      <StyleControls style={style} kind={isArrowControl ? "arrow" : "shape"} onStyle={onStyle} />
      {isArrowControl ? (
        <label className="drawing-stack">
          Arrowheads
          <select value={attrs["data-heads"] ?? "end"} onChange={(event) => set({ "data-heads": event.target.value })}>
            <option value="end">At tip</option>
            <option value="start">At tail</option>
            <option value="both">Both ends</option>
          </select>
        </label>
      ) : null}
    </>
  );

  const label = (
    <>
      <LabelField value={attrs["data-label"] ?? ""} onCommit={(text) => set({ "data-label": text })} />
      {(attrs["data-label"] ?? "").trim() !== "" ? (
        <LabelPlacementEditor
          attrs={attrs}
          prefix="data-label"
          points={
            isArrowControl
              ? [
                  { value: "start", label: "Tail" },
                  { value: "mid", label: "Middle" },
                  { value: "end", label: "Tip" },
                ]
              : [
                  { value: "start", label: "Base" },
                  { value: "mid", label: "Middle" },
                  { value: "end", label: "End" },
                ]
          }
          alongWarning={angleVariable ? "Along a variable-angle arrow, the label reads upside down for some angles." : undefined}
          onChange={(patch, remove) => set(patch, remove)}
        />
      ) : null}
    </>
  );

  const directionButtons = (
    <div className="drawing-segmented" role="group" aria-label="Direction">
      {isArrowControl
        ? arrowDirections(ccw).map((item) => (
            <button key={item.angle} type="button" className={sameAngle(angle, item.angle) ? "active" : ""} onClick={() => setDirection(item.angle)}>
              {item.label}
            </button>
          ))
        : BAR_DIRECTIONS.map((item) => (
            <button
              key={item.direction}
              type="button"
              className={attrs["data-direction"] === item.direction ? "active" : ""}
              onClick={() => set({ "data-direction": item.direction })}
            >
              {item.label}
            </button>
          ))}
    </div>
  );

  const place = (
    <>
      <div className="drawing-field-grid">
        <NumberField
          label={isArrowControl ? "Tail x" : "Base x"}
          value={literalNumber(attrs["data-x"]) ?? 0}
          onCommit={(next) => set({ "data-x": formatNumber(next) })}
        />
        <NumberField
          label={isArrowControl ? "Tail y" : "Base y"}
          value={literalNumber(attrs["data-y"]) ?? 0}
          onCommit={(next) => set({ "data-y": formatNumber(next) })}
        />
      </div>

      <div className="drawing-stack">
        Length
        <span className="drawing-muted">Always a variable on this {isArrowControl ? "arrow" : "bar"}; how it's drawn is under Length scaling.</span>
      </div>
      <VariableNameField
        label="Length variable"
        variable={variable}
        usedNames={usedNames}
        reserved={angleVariable}
        onRename={(to) => onRename(setControlAttrs(element, { "data-variable": to }), variable, to)}
      />
      <SliderField label="Preview value" min={0} max={lengthMax} text={lengthText} onChange={(value) => onPreviewValues({ [variable]: value })} />
      {!isArrowControl ? (
        <div className="drawing-field-grid">
          <NumberField
            label="Thickness"
            value={literalNumber(attrs["data-thickness"]) ?? 20}
            onCommit={(next) => next > 0 && set({ "data-thickness": formatNumber(next) })}
          />
        </div>
      ) : null}

      {isArrowControl ? (
        <>
          {!ccw ? (
            <div className="drawing-legacy-note">
              <p>This arrow uses the old clockwise angles (90° points down).</p>
              <button type="button" onClick={convertAngles}>
                Switch to counterclockwise
              </button>
            </div>
          ) : null}
          <FixedOrVariable label="Angle" variable={angleVariable} onFixed={makeAngleFixed} onVariable={makeAngleVariable} />
          {angleVariable ? (
            <>
              <VariableNameField
                label="Angle variable (degrees)"
                variable={angleVariable}
                usedNames={usedNames}
                reserved={variable}
                suggestions={angleVariables}
                onRename={(to) => onRename(setControlAttrs(element, { "data-angle-variable": to }), angleVariable, to)}
              />
              <SliderField
                label="Preview angle"
                min={ccw ? 0 : -180}
                max={ccw ? 360 : 180}
                step={15}
                text={angleText}
                onChange={(value) => onPreviewValues({ [angleVariable]: value })}
              />
            </>
          ) : (
            <div className="drawing-field-grid">
              <NumberField label="Angle (°)" value={fixedAngle} onCommit={(next) => set({ "data-angle": formatNumber(next) })} />
            </div>
          )}
          <div className="drawing-stack">
            {angleVariable ? "Preview direction" : "Direction"}
            {directionButtons}
          </div>
          <p className="drawing-muted">
            {ccw
              ? "Angles are counterclockwise from the positive x-axis: 0° points right, 90° points up."
              : "Old convention: 0° points right, 90° points down."}
          </p>
        </>
      ) : (
        <div className="drawing-stack">
          Direction
          {directionButtons}
        </div>
      )}
    </>
  );

  return (
    <InspectorLayout
      title={isArrowControl ? "Variable arrow" : "Variable bar"}
      look={look}
      label={label}
      place={place}
      placeTitle={isArrowControl ? "Position, length and angle" : "Position, length and direction"}
      more={<LengthSettings element={element} variable={variable} preview={length} scaleGroups={scaleGroups} set={set} values={previewValues} />}
      moreTitle="Length scaling"
      actions={actions}
      note={
        <p className="drawing-muted">
          Saved as <code>{"{{calc: …}}"}</code> expressions
          {angleVariable ? " and a rotation" : ""}. Each question sets <code>{variable}</code>
          {angleVariable ? (
            <>
              {" "}and <code>{angleVariable}</code>
            </>
          ) : null}{" "}
          in the asset's variables; the values here are only a preview. Labels show the real value; only the drawn length is
          scaled.
        </p>
      }
    />
  );
}

/** Where a scaled size's settings are saved: an arrow's or bar's length, or
 *  a variable arc's radius (whose attribute names predate the shared editor). */
interface ScaledSizeAttrs {
  scale: string;
  expression: string;
  min: string;
  max: string;
  /** Scale groups are for lengths only. */
  group: string | null;
  noun: "length" | "radius";
}

const LENGTH_ATTRS: ScaledSizeAttrs = {
  scale: "data-scale",
  expression: "data-length-expression",
  min: "data-min-length",
  max: "data-max-length",
  group: "data-scale-group",
  noun: "length",
};

const RADIUS_ATTRS: ScaledSizeAttrs = {
  scale: "data-radius-scale",
  expression: "data-radius-expression",
  min: "data-radius-min",
  max: "data-radius-max",
  group: null,
  noun: "radius",
};

/** How a variable becomes a drawn size: a scale factor or a formula,
 *  optional minimum/maximum, a range-fitting helper, and (for lengths) a
 *  shared scale group. */
function LengthSettings({
  element,
  variable,
  preview,
  scaleGroups = [],
  set,
  names = LENGTH_ATTRS,
  readout,
  values = {},
}: {
  element: SceneElement & { kind: "group" };
  variable: string;
  preview: number;
  scaleGroups?: string[];
  set: (next: Record<string, string>, remove?: string[]) => void;
  names?: ScaledSizeAttrs;
  /** What the preview value draws as; worked out from the control when not given. */
  readout?: LengthReadout | null;
  /** All preview values (a question-set scale is one of them). */
  values?: PreviewValues;
}) {
  const attrs = element.attrs;
  const formula = attrs[names.expression];
  const usingFormula = formula !== undefined;
  const [fitOpen, setFitOpen] = useState(false);
  const [fitNote, setFitNote] = useState<string | null>(null);
  const shown = readout === undefined ? lengthReadout(element, preview, values) : readout;
  const scaleVariable = names.noun === "length" ? attrs["data-scale-variable"] ?? null : null;
  const group = names.group ? attrs[names.group] ?? "" : "";
  const Noun = names.noun === "length" ? "Length" : "Radius";
  // Range fits are written for lengths; rename their keys for a radius.
  const renamed = (fit: RangeFit): RangeFit => ({
    ...fit,
    attrs: Object.fromEntries(
      Object.entries(fit.attrs).map(([name, value]) => [
        name === "data-scale" ? names.scale : name === "data-length-expression" ? names.expression : name,
        value,
      ]),
    ),
    remove: fit.remove.map((name) => (name === "data-length-expression" ? names.expression : name)),
  });

  return (
    <div className="drawing-length-settings">
      <div className="drawing-stack">
        Drawn {names.noun}
        <div className="drawing-segmented" role="group" aria-label={`${Noun} mode`}>
          <button type="button" className={usingFormula ? "" : "active"} onClick={() => usingFormula && set({}, [names.expression])}>
            Scale
          </button>
          <button
            type="button"
            className={usingFormula ? "active" : ""}
            onClick={() =>
              !usingFormula &&
              set({ [names.expression]: `${variable} * ${formatCoefficient(literalNumber(attrs[names.scale]) ?? 1)}` })
            }
          >
            Formula
          </button>
        </div>
      </div>

      {usingFormula ? (
        <FormulaField label={`${Noun} formula (px)`} variable={variable} value={formula} onCommit={(next) => set({ [names.expression]: next })} />
      ) : (
        <>
          <ScaleField value={literalNumber(attrs[names.scale]) ?? 1} onCommit={(scale) => set({ [names.scale]: formatCoefficient(scale) })} />
          {names.noun === "length" ? (
            <label className="drawing-check-row">
              <input
                type="checkbox"
                checked={scaleVariable !== null}
                onChange={(event) =>
                  event.target.checked ? set({ "data-scale-variable": `${variable}_scale` }) : set({}, ["data-scale-variable"])
                }
              />
              Let a question set the scale
            </label>
          ) : null}
          {scaleVariable ? (
            <>
              <VariableNameField
                label="Scale variable"
                variable={scaleVariable}
                usedNames={[]}
                reserved={variable}
                onRename={(to) => set({ "data-scale-variable": to })}
              />
              <span className="drawing-muted">
                A question that sets <code>{scaleVariable}</code> draws at that scale; one that leaves it blank uses the scale above.
                This puts a drawing decision in question data, so use it only for unusual values.
              </span>
            </>
          ) : null}
        </>
      )}

      {shown ? (
        <p className="drawing-muted drawing-readout">
          {shown.perUnit !== null ? `1 unit draws as ${formatNumber(shown.perUnit)} px · ` : ""}
          {formatNumber(preview)} draws as {formatNumber(shown.atPreview)} px
          {shown.clamped ? " (held at the limit)" : ""}
        </p>
      ) : null}

      <div className="drawing-field-grid">
        <OptionalNumberField
          label={`Min ${names.noun} (px)`}
          value={literalNumber(attrs[names.min])}
          onCommit={(next) => (next === null ? set({}, [names.min]) : set({ [names.min]: formatNumber(next) }))}
        />
        <OptionalNumberField
          label={`Max ${names.noun} (px)`}
          value={literalNumber(attrs[names.max])}
          onCommit={(next) => (next === null ? set({}, [names.max]) : set({ [names.max]: formatNumber(next) }))}
        />
      </div>

      {names.noun === "length" && (attrs[names.min] !== undefined || attrs[names.max] !== undefined) ? (
        <label className="drawing-check-row">
          <input
            type="checkbox"
            checked={attrs["data-clamp-mark"] !== "none"}
            onChange={(event) => (event.target.checked ? set({}, ["data-clamp-mark"]) : set({ "data-clamp-mark": "none" }))}
          />
          Mark a length held at its limit (//), so it isn't read as true to scale
        </label>
      ) : null}

      {names.group ? (
      <label className="drawing-stack">
        Scale group
        <input
          list="drawing-scale-groups"
          placeholder="e.g. Forces"
          defaultValue={group}
          key={group}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next === group) return;
            if (next) set({ "data-scale-group": next });
            else set({}, ["data-scale-group"]);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
        />
        <datalist id="drawing-scale-groups">
          {scaleGroups.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <span className="drawing-muted">Arrows and bars in one group share their scale, formula and limits, so their lengths compare honestly.</span>
      </label>
      ) : null}

      <button type="button" className="drawing-link-button" aria-expanded={fitOpen} onClick={() => setFitOpen((open) => !open)}>
        {fitOpen ? "▾" : "▸"} Fit to a range…
      </button>
      {fitOpen ? (
        <RangeFitForm
          variable={variable}
          onApply={(fit) => {
            const applied = renamed(fit);
            set(applied.attrs, applied.remove);
            setFitNote(applied.warning);
          }}
        />
      ) : null}
      {fitNote ? <p className="drawing-warning">{fitNote}</p> : null}
    </div>
  );
}

/** Scale as a decimal ("0.1") or a percent ("10%"). */
function ScaleField({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(formatCoefficient(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(formatCoefficient(value)), [value]);
  const commit = () => {
    const trimmed = text.trim();
    const parsed = trimmed.endsWith("%") ? Number(trimmed.slice(0, -1)) / 100 : Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Use a positive number, like 0.1 or 10%.");
      return;
    }
    setError(null);
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <label className="drawing-stack">
      Scale (px per unit, or %)
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {error ? <span className="drawing-error">{error}</span> : null}
    </label>
  );
}

/** A length formula in the control's variable, checked as you type. */
function FormulaField({
  label = "Length formula (px)",
  variable,
  value,
  onCommit,
}: {
  label?: string;
  variable: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const error = expressionError(text, [variable]);
  const commit = () => {
    if (!error && text.trim() !== value) onCommit(text.trim());
  };
  return (
    <label className="drawing-stack">
      {label}
      <input
        className="drawing-formula"
        value={text}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {error ? (
        <span className="drawing-error">{error} The last good formula is still used.</span>
      ) : (
        <span className="drawing-muted">
          Use <code>{variable}</code> with + − * / and parentheses, e.g. <code>{`${variable} / 10`}</code>.
        </span>
      )}
    </label>
  );
}

function RangeFitForm({ variable, onApply }: { variable: string; onApply: (fit: RangeFit) => void }) {
  const [values, setValues] = useState({ min: 10, max: 100 });
  const [lengths, setLengths] = useState({ min: 15, max: 120 });
  const [mode, setMode] = useState<"proportional" | "linear">("proportional");
  const fit = fitToRange(variable, values, lengths, mode);
  return (
    <div className="drawing-fit-form">
      <div className="drawing-field-grid">
        <NumberField label="Smallest value" value={values.min} onCommit={(min) => setValues((current) => ({ ...current, min }))} />
        <NumberField label="Largest value" value={values.max} onCommit={(max) => setValues((current) => ({ ...current, max }))} />
        <NumberField label="Shortest (px)" value={lengths.min} onCommit={(min) => setLengths((current) => ({ ...current, min }))} />
        <NumberField label="Longest (px)" value={lengths.max} onCommit={(max) => setLengths((current) => ({ ...current, max }))} />
      </div>
      <div className="drawing-segmented" role="group" aria-label="Fit">
        <button type="button" className={mode === "proportional" ? "active" : ""} onClick={() => setMode("proportional")}>
          Proportional
        </button>
        <button type="button" className={mode === "linear" ? "active" : ""} onClick={() => setMode("linear")}>
          Linear
        </button>
      </div>
      <p className="drawing-muted">
        {mode === "proportional"
          ? "One scale factor: twice the value draws twice as long. The largest value draws at the longest length."
          : "Maps the range exactly, so small values stay visible — but lengths are no longer proportional."}
      </p>
      <button type="button" disabled={!fit} onClick={() => fit && onApply(fit)}>
        Apply fit
      </button>
    </div>
  );
}

/** A number input that may be left blank (meaning "no limit"). */
function OptionalNumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number | null;
  onCommit: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : formatNumber(value));
  useEffect(() => setText(value === null ? "" : formatNumber(value)), [value]);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed !== value) onCommit(parsed);
    else setText(value === null ? "" : formatNumber(value));
  };
  return (
    <label>
      {label}
      <input
        inputMode="decimal"
        placeholder="none"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </label>
  );
}

/** A variable's name, committed on blur/Enter. Typing a name already in use
 *  links this control to it; `reserved` is this control's other variable. */
function VariableNameField({
  label,
  variable,
  usedNames,
  reserved,
  suggestions = [],
  onRename,
}: {
  label: string;
  variable: string;
  usedNames: string[];
  reserved: string | null;
  /** Existing variables offered in a menu (e.g. the drawing's angles), to link to. */
  suggestions?: string[];
  onRename: (to: string) => void;
}) {
  const listId = useId();
  const offered = suggestions.filter((name) => name !== variable && name !== reserved);
  const [text, setText] = useState(variable);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(variable);
    setError(null);
  }, [variable]);

  const commit = () => {
    const next = text.trim();
    if (next === variable) return;
    if (!isValidVariableName(next)) {
      setError("Use letters, digits and _ only, starting with a letter.");
      return;
    }
    if (next === reserved) {
      setError("Length and angle need different variables.");
      return;
    }
    setError(null);
    onRename(next);
  };

  return (
    <label className="drawing-stack">
      {label}
      <input
        value={text}
        list={offered.length > 0 ? listId : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {offered.length > 0 ? (
        <datalist id={listId}>
          {offered.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      ) : null}
      {error ? (
        <span className="drawing-error">{error}</span>
      ) : text.trim() !== variable && usedNames.includes(text.trim()) ? (
        <span className="drawing-muted">Links this control to the existing {text.trim()} variable.</span>
      ) : null}
    </label>
  );
}

function SliderField({
  label,
  min,
  max,
  step = 1,
  text,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  text: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="drawing-stack">
      {label}
      <div className="drawing-slider-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number(text) || 0}
          onChange={(event) => onChange(event.target.value)}
        />
        <input value={text} onChange={(event) => onChange(event.target.value)} />
      </div>
    </label>
  );
}

/** Settings of a fixed arc: start, sweep, radius, arrowheads, wedge and label. */
/** A fixed arc's settings, regenerated from its data-* attributes. */
function fixedArcEditor(element: SceneElement & { kind: "group" }, onChange: (next: SceneElement) => void) {
  const attrs = element.attrs;
  const set = (patch: Record<string, string>, remove: string[] = []) => {
    const next = { ...attrs, ...patch };
    for (const name of remove) delete next[name];
    onChange(rebuildShape({ ...element, attrs: next }));
  };
  return { arc: readFixedArc(element), attrs, set };
}

function FixedArcLook({ element, onChange }: { element: SceneElement & { kind: "group" }; onChange: (next: SceneElement) => void }) {
  const { arc, set } = fixedArcEditor(element, onChange);
  if (!arc) return null;
  return <ArcShapeOptions heads={arc.heads} wedge={arc.wedge} set={set} />;
}

/** Arrowheads and the wedge option, shared by fixed and variable arcs. */
function ArcShapeOptions({
  heads,
  wedge,
  set,
}: {
  heads: ArcHeads;
  wedge: boolean;
  set: (patch: Record<string, string>, remove?: string[]) => void;
}) {
  return (
    <>
      <label className="drawing-stack">
        Arrowheads
        <select value={heads} onChange={(event) => set({ "data-heads": event.target.value })}>
          <option value="none">None</option>
          <option value="end">At the end</option>
          <option value="start">At the start</option>
          <option value="both">Both ends</option>
        </select>
      </label>
      <label className="drawing-check-row">
        <input
          type="checkbox"
          checked={wedge}
          onChange={(event) => (event.target.checked ? set({ "data-wedge": "true" }) : set({ fill: "none" }, ["data-wedge"]))}
        />
        Close as a wedge (pie slice) so it can be filled
      </label>
    </>
  );
}

function FixedArcLabel({ element, onChange }: { element: SceneElement & { kind: "group" }; onChange: (next: SceneElement) => void }) {
  const { attrs, set } = fixedArcEditor(element, onChange);
  return <ArcLabelOptions attrs={attrs} set={set} />;
}

/** An arc's label: text, inside or outside, upright or along, gap, reset. */
function ArcLabelOptions({
  attrs,
  set,
}: {
  attrs: Record<string, string>;
  set: (patch: Record<string, string>, remove?: string[]) => void;
}) {
  const settings = readLabelSettings(attrs, "data-label");
  const labeled = (attrs["data-label"] ?? "").trim() !== "";
  return (
    <>
      <LabelField value={attrs["data-label"] ?? ""} onCommit={(label) => set({ "data-label": label })} />
      {labeled ? (
        <>
          <div className="drawing-stack">
            Position
            <div className="drawing-segmented" role="group" aria-label="Label side">
              <button type="button" className={attrs["data-label-side"] === "outside" ? "" : "active"} onClick={() => set({}, ["data-label-side"])}>
                Inside
              </button>
              <button type="button" className={attrs["data-label-side"] === "outside" ? "active" : ""} onClick={() => set({ "data-label-side": "outside" })}>
                Outside
              </button>
            </div>
          </div>
          <div className="drawing-stack">
            Text direction
            <div className="drawing-segmented" role="group" aria-label="Text direction">
              <button type="button" className={settings.orient === "horizontal" ? "active" : ""} onClick={() => set({}, ["data-label-orient"])}>
                Upright
              </button>
              <button type="button" className={settings.orient === "along" ? "active" : ""} onClick={() => set({ "data-label-orient": "along" })}>
                Along the arc
              </button>
            </div>
          </div>
          <div className="drawing-field-grid">
            <NumberField
              label="Gap (px)"
              value={settings.gap}
              onCommit={(gap) => (gap === 6 ? set({}, ["data-label-gap"]) : set({ "data-label-gap": formatNumber(gap) }))}
            />
          </div>
          {settings.dx !== 0 || settings.dy !== 0 ? (
            <button type="button" className="drawing-link-button" onClick={() => set({}, ["data-label-dx", "data-label-dy"])}>
              Reset dragged position
            </button>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function FixedArcPlace({
  element,
  lines,
  onChange,
}: {
  element: SceneElement & { kind: "group" };
  lines: LineChoice[];
  onChange: (next: SceneElement) => void;
}) {
  const { arc, set } = fixedArcEditor(element, onChange);
  if (!arc) return null;
  return (
    <>
      <div className="drawing-field-grid">
        <NumberField label="Centre x" value={arc.x} onCommit={(value) => set({ "data-x": formatNumber(value) })} />
        <NumberField label="Centre y" value={arc.y} onCommit={(value) => set({ "data-y": formatNumber(value) })} />
        <NumberField label="Radius" value={arc.radius} onCommit={(value) => value > 0 && set({ "data-radius": formatNumber(value) })} />
        <NumberField label="Start (°)" value={arc.rotation} onCommit={(value) => set({ "data-rotation": formatNumber(value) })} />
        <NumberField
          label="Sweep (°)"
          value={arc.sweep}
          onCommit={(value) => value !== 0 && set({ "data-sweep": formatNumber(Math.max(-359.9, Math.min(359.9, value))) })}
        />
      </div>
      <p className="drawing-muted">Angles count counterclockwise from the positive x-axis; a negative sweep runs clockwise.</p>
      <LineUpField
        lines={lines}
        centre={{ x: arc.x, y: arc.y }}
        onDirection={(degrees) => set({ "data-rotation": formatNumber(degrees) })}
        onAngleVariable={() => undefined}
      />
    </>
  );
}

/** Inspector for a variable arc: its sweep, where it starts (rotation), its
 *  radius, arrowheads and label. Rotation and radius can be fixed or variables. */
function ArcInspector({
  element,
  style,
  previewValues,
  usedNames,
  angleVariables,
  lines,
  onStyle,
  onPreviewValues,
  onChange,
  onRename,
  actions,
}: {
  element: SceneElement;
  style: DrawingStyle;
  previewValues: PreviewValues;
  usedNames: string[];
  angleVariables: string[];
  /** Lines and arrows beside it, to line its start up with. */
  lines: LineChoice[];
  onStyle: (patch: Partial<DrawingStyle>) => void;
  onPreviewValues: (patch: PreviewValues) => void;
  onChange: (next: SceneElement) => void;
  onRename: (next: SceneElement, from: string, to: string) => void;
  actions: ElementActionProps;
}) {
  const arc = readArcSettings(element);
  if (!arc || element.kind !== "group") return null;
  const attrs = element.attrs;
  const set = (next: Record<string, string>, remove: string[] = []) => onChange(setControlAttrs(element, next, remove));
  const reserved = [arc.sweep, arc.rotationVariable, arc.radiusVariable].filter(Boolean) as string[];
  const radiusPreview = arc.radiusVariable ? Number(previewValues[arc.radiusVariable]) || 0 : arc.radius;

  const look = (
    <>
      <StyleControls style={style} kind={arc.wedge ? "shape" : "line"} onStyle={onStyle} />
      <ArcShapeOptions heads={arc.heads} wedge={arc.wedge} set={set} />
    </>
  );

  const place = (
    <>
      <div className="drawing-field-grid">
        <NumberField label="Centre x" value={arc.x} onCommit={(value) => set({ "data-x": formatNumber(value) })} />
        <NumberField label="Centre y" value={arc.y} onCommit={(value) => set({ "data-y": formatNumber(value) })} />
      </div>

      <FixedOrVariable
        label="Radius"
        variable={arc.radiusVariable}
        onFixed={() => {
          if (!arc.radiusVariable) return;
          // Keep the radius it draws at now, formula and limits included.
          const value = radiusReadout(arc, previewValues)?.atPreview ?? Number.NaN;
          set({ "data-radius": formatNumber(Number.isFinite(value) && value > 0 ? value : arc.radius) }, [
            "data-radius-variable",
            "data-radius-scale",
            "data-radius-expression",
            "data-radius-min",
            "data-radius-max",
          ]);
        }}
        onVariable={() => {
          const name = uniqueVariableName("arc_radius", [...usedNames, ...reserved]);
          set({ "data-radius-variable": name });
          onPreviewValues({ [name]: formatNumber(arc.radius) });
        }}
      />
      {arc.radiusVariable ? (
        <>
          <VariableNameField
            label="Radius variable"
            variable={arc.radiusVariable}
            usedNames={usedNames}
            reserved={arc.sweep}
            onRename={(to) => onRename(setControlAttrs(element, { "data-radius-variable": to }), arc.radiusVariable as string, to)}
          />
          <SliderField
            label="Preview radius"
            min={0}
            max={Math.max(100, Math.ceil((radiusPreview * 1.5) / 10) * 10)}
            text={previewValues[arc.radiusVariable] ?? ""}
            onChange={(value) => onPreviewValues({ [arc.radiusVariable as string]: value })}
          />
        </>
      ) : (
        <div className="drawing-field-grid">
          <NumberField label="Radius (px)" value={arc.radius} onCommit={(value) => value > 0 && set({ "data-radius": formatNumber(value) })} />
        </div>
      )}

      <FixedOrVariable
        label="Start (rotation)"
        variable={arc.rotationVariable}
        onFixed={() => {
          if (!arc.rotationVariable) return;
          const value = Number(previewValues[arc.rotationVariable]);
          set({ "data-rotation": formatNumber(Number.isFinite(value) ? value : arc.rotation) }, ["data-rotation-variable"]);
        }}
        onVariable={() => {
          const name = uniqueVariableName("arc_start", [...usedNames, ...reserved]);
          set({ "data-rotation-variable": name });
          onPreviewValues({ [name]: formatNumber(arc.rotation) });
        }}
      />
      {arc.rotationVariable ? (
        <>
          <VariableNameField
            label="Rotation variable (degrees)"
            variable={arc.rotationVariable}
            usedNames={usedNames}
            reserved={arc.sweep}
            suggestions={angleVariables}
            onRename={(to) => onRename(setControlAttrs(element, { "data-rotation-variable": to }), arc.rotationVariable as string, to)}
          />
          <SliderField
            label="Preview rotation"
            min={0}
            max={360}
            step={15}
            text={previewValues[arc.rotationVariable] ?? ""}
            onChange={(value) => onPreviewValues({ [arc.rotationVariable as string]: value })}
          />
        </>
      ) : (
        <div className="drawing-field-grid">
          <NumberField label="Rotation (°)" value={arc.rotation} onCommit={(value) => set({ "data-rotation": formatNumber(value) })} />
        </div>
      )}
      <LineUpField
        lines={lines}
        centre={{ x: arc.x, y: arc.y }}
        onDirection={(degrees) => set({ "data-rotation": formatNumber(degrees) }, ["data-rotation-variable"])}
        onAngleVariable={(name) => set({ "data-rotation-variable": name })}
      />

      <div className="drawing-stack">
        Sweep
        <span className="drawing-muted">Always a variable on this arc. Positive sweeps counterclockwise from the start, negative clockwise.</span>
      </div>
      <VariableNameField
        label="Sweep variable (degrees)"
        variable={arc.sweep}
        usedNames={usedNames}
        reserved={arc.rotationVariable ?? arc.radiusVariable}
        suggestions={angleVariables}
        onRename={(to) => onRename(setControlAttrs(element, { "data-variable": to }), arc.sweep, to)}
      />
      <SliderField
        label="Preview sweep"
        min={-360}
        max={360}
        step={5}
        text={previewValues[arc.sweep] ?? ""}
        onChange={(value) => onPreviewValues({ [arc.sweep]: value })}
      />
    </>
  );

  const radiusRead = radiusReadout(arc, previewValues);
  return (
    <InspectorLayout
      title="Variable arc"
      look={look}
      label={<ArcLabelOptions attrs={attrs} set={set} />}
      place={place}
      placeTitle="Position, size and angle"
      more={
        arc.radiusVariable ? (
          <LengthSettings
            element={element}
            variable={arc.radiusVariable}
            preview={radiusPreview}
            set={set}
            names={RADIUS_ATTRS}
            readout={radiusRead ? { perUnit: arc.radiusExpression ? null : arc.radiusScale, ...radiusRead } : null}
          />
        ) : null
      }
      moreTitle="Radius scaling"
      actions={actions}
      note={
        <p className="drawing-muted">
          Saved as <code>{"{{calc: …}}"}</code> lengths and rotations. Each question sets <code>{arc.sweep}</code>
          {arc.rotationVariable ? <>, <code>{arc.rotationVariable}</code></> : null}
          {arc.radiusVariable ? <>, <code>{arc.radiusVariable}</code></> : null}; the values here are only a preview. Use the same
          variable as a variable-angle arrow to mark its angle.
        </p>
      }
    />
  );
}

/** "Start along…": turns an arc's start to a line or arrow, pointing away
 *  from the arc's centre, so the arc measures the angle from it. A
 *  variable-angle arrow links its angle variable instead of a number. */
function LineUpField({
  lines,
  centre,
  onDirection,
  onAngleVariable,
}: {
  lines: LineChoice[];
  centre: Point;
  onDirection: (degrees: number) => void;
  onAngleVariable: (name: string) => void;
}) {
  if (lines.length === 0) return null;
  const choices: { value: string; label: string; line: LineChoice; degrees: number | null }[] = lines.flatMap((line, index) =>
    line.angleVariable
      ? [{ value: `${index}:var`, label: `${line.label} (links ${line.angleVariable})`, line, degrees: null as number | null }]
      : directionsFrom(line, centre).map((degrees) => ({ value: `${index}:${degrees}`, label: `${line.label} → ${formatNumber(degrees)}°`, line, degrees: degrees as number | null })),
  );
  return (
    <label className="drawing-stack">
      Start along a line
      <select
        value=""
        onChange={(event) => {
          const choice = choices.find((item) => item.value === event.target.value);
          if (!choice) return;
          if (choice.degrees === null && choice.line.angleVariable) onAngleVariable(choice.line.angleVariable);
          else if (choice.degrees !== null) onDirection(choice.degrees);
        }}
      >
        <option value="">Choose a line or arrow…</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      <span className="drawing-muted">Points the start along it, away from the centre, so the arc measures the angle from that line.</span>
    </label>
  );
}

/** "Fixed | Variable" for a setting that can be a number or a variable. */
function FixedOrVariable({
  label,
  variable,
  onFixed,
  onVariable,
}: {
  label: string;
  variable: string | null;
  onFixed: () => void;
  onVariable: () => void;
}) {
  return (
    <div className="drawing-stack">
      {label}
      <div className="drawing-segmented" role="group" aria-label={`${label} mode`}>
        <button type="button" className={variable ? "" : "active"} onClick={() => variable && onFixed()}>
          Fixed
        </button>
        <button type="button" className={variable ? "active" : ""} onClick={() => !variable && onVariable()}>
          Variable
        </button>
      </div>
    </div>
  );
}

/** Where a label sits: which point, upright or along the shape, which side,
 *  how far, and a reset for a dragged offset. `prefix` is "data-label" for
 *  built-in labels and "data-anchor" for attached texts. */
function LabelPlacementEditor({
  attrs,
  prefix,
  points,
  alongWarning,
  onChange,
}: {
  attrs: Record<string, string>;
  prefix: "data-label" | "data-anchor";
  points: { value: string; label: string }[];
  alongWarning?: string;
  onChange: (patch: Record<string, string>, remove: string[]) => void;
}) {
  const pointAttr = prefix === "data-label" ? `${prefix}-at` : `${prefix}-point`;
  const point = attrs[pointAttr] ?? "end";
  const lineLike = points.some((item) => item.value === "mid");
  const settings = readLabelSettings(attrs, prefix);
  const atMiddle = point === "mid";
  const moved = settings.dx !== 0 || settings.dy !== 0;
  const here = point === "here";
  return (
    <div className="drawing-label-placement">
      <div className="drawing-stack">
        Position
        <div className="drawing-segmented" role="group" aria-label="Label position">
          {points.map((item) => (
            <button
              key={item.value}
              type="button"
              className={point === item.value ? "active" : ""}
              onClick={() => onChange({ [pointAttr]: item.value }, [`${prefix}-dx`, `${prefix}-dy`])}
              title={item.value === "here" ? "Keep it where it is, relative to the centre (orbits when the shape turns)" : undefined}
            >
              {item.value === "here" ? "Here" : item.label}
            </button>
          ))}
        </div>
      </div>
      {here ? (
        <p className="drawing-muted">
          Keeps its place relative to the shape's centre: it orbits when the shape rotates and moves out as it grows. Drag the
          text to move it.
        </p>
      ) : null}
      {lineLike && !here ? (
        <div className="drawing-stack">
          Text direction
          <div className="drawing-segmented" role="group" aria-label="Text direction">
            <button type="button" className={settings.orient === "horizontal" ? "active" : ""} onClick={() => onChange({}, [`${prefix}-orient`])}>
              Upright
            </button>
            <button type="button" className={settings.orient === "along" ? "active" : ""} onClick={() => onChange({ [`${prefix}-orient`]: "along" }, [])}>
              Along the shape
            </button>
          </div>
          {settings.orient === "along" && alongWarning ? <span className="drawing-muted">{alongWarning}</span> : null}
        </div>
      ) : null}
      {lineLike && atMiddle ? (
        <div className="drawing-stack">
          Side
          <div className="drawing-segmented" role="group" aria-label="Label side">
            <button type="button" className={settings.side === "above" ? "active" : ""} onClick={() => onChange({}, [`${prefix}-side`])}>
              Above
            </button>
            <button type="button" className={settings.side === "below" ? "active" : ""} onClick={() => onChange({ [`${prefix}-side`]: "below" }, [])}>
              Below
            </button>
          </div>
        </div>
      ) : null}
      {here ? null : (
        <div className="drawing-field-grid">
          <NumberField
            label="Gap (px)"
            value={settings.gap}
            onCommit={(gap) => (gap === 6 ? onChange({}, [`${prefix}-gap`]) : onChange({ [`${prefix}-gap`]: formatNumber(gap) }, []))}
          />
        </div>
      )}
      {here ? null : moved ? (
        <button type="button" className="drawing-link-button" onClick={() => onChange({}, [`${prefix}-dx`, `${prefix}-dy`])}>
          Reset dragged position
        </button>
      ) : (
        <span className="drawing-muted">Drag the small square on the canvas to fine-tune.</span>
      )}
    </div>
  );
}

/** For a text: attach it to a shape so it follows it, or manage that link. */
function AttachSection({
  element,
  siblings,
  onAttach,
  onDetach,
  onChange,
}: {
  element: SceneElement;
  siblings: SceneElement[];
  onAttach: (targetKey: string, point: AnchorPoint) => void;
  onDetach: () => void;
  onChange: (next: SceneElement) => void;
}) {
  const candidates = anchorCandidates(siblings, element);
  const targetId = anchorTargetId(element);
  const target = targetId ? siblings.find((item) => item.kind !== "passthrough" && item.attrs.id === targetId) : undefined;
  const [choice, setChoice] = useState<string>("");
  const chosen = candidates.find((item) => item.key === choice) ?? null;
  const [point, setPoint] = useState<AnchorPoint>("end");
  const chosenPoints = chosen ? anchorPointsFor(chosen) : [];

  if (element.kind !== "text") return null;
  if (target) {
    return (
      <div className="drawing-label-settings">
        <h4>Attached to {describeElement(target)}</h4>
        <LabelPlacementEditor
          attrs={element.attrs}
          prefix="data-anchor"
          points={anchorPointsFor(target)}
          onChange={(patch, remove) => {
            if (patch["data-anchor-point"] === "here") {
              // Keep it exactly where it is now, relative to the shape's centre.
              onChange(attachText({ rootAttrs: {}, elements: siblings }, element, target, "here").text);
              return;
            }
            const attrs = { ...element.attrs, ...patch };
            for (const name of remove) delete attrs[name];
            onChange({ ...element, attrs });
          }}
        />
        <button type="button" onClick={onDetach}>
          Detach (leave it here)
        </button>
      </div>
    );
  }

  if (candidates.length === 0) {
    return <p className="drawing-muted">Draw a line, arrow or shape to attach this text to it.</p>;
  }
  return (
    <div className="drawing-label-settings">
      <h4>Attach to a shape</h4>
      <label className="drawing-stack">
        Shape
        <select
          value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
            const next = candidates.find((item) => item.key === event.target.value);
            setPoint(next ? anchorPointsFor(next).some((item) => item.value === "end") ? "end" : "center" : "end");
          }}
        >
          <option value="">Choose…</option>
          {candidates.map((item) => (
            <option key={item.key} value={item.key}>
              {describeElement(item)}
            </option>
          ))}
        </select>
      </label>
      {chosen ? (
        <>
          <label className="drawing-stack">
            At
            <select value={point} onChange={(event) => setPoint(event.target.value as AnchorPoint)}>
              {chosenPoints.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => onAttach(chosen.key, point)}>
            Attach
          </button>
        </>
      ) : null}
      <span className="drawing-muted">An attached text moves with its shape, including when a variable changes its length. You can also drag the text onto a green point on a shape (hold Alt to drop it loose).</span>
    </div>
  );
}

/** The label that rides at the arrow tip. Commits on blur so typing a
 *  {{variable}} doesn't rebuild the arrow on every keystroke. */
function LabelField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [text, setText] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const placeCaret = useCaretAfterUpdate(inputRef, text);
  useEffect(() => setText(value), [value]);
  const commit = (next = text) => {
    if (next !== value) onCommit(next);
  };
  return (
    <div className="drawing-stack">
      <div className="drawing-field-with-symbols">
        <label className="drawing-stack">
          <input
            ref={inputRef}
            aria-label="Label"
            value={text}
            placeholder="e.g. $F_N$ or {{force_label}}"
            onChange={(event) => setText(event.target.value)}
            onBlur={() => commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
          />
        </label>
        <SymbolPicker
          fieldRef={inputRef}
          onInsert={(insert) => {
            const next = insertAtSelection(text, inputRef.current, insert);
            placeCaret(next.caret);
            setText(next.value);
            commit(next.value);
          }}
        />
      </div>
      <MathHint text={text} />
    </div>
  );
}

type InspectorKind = "line" | "arrow" | "arc" | "shape" | "polyline" | "text" | "group" | "passthrough" | "any";

const KIND_LABELS: Record<InspectorKind, string> = {
  line: "Line",
  arrow: "Arrow",
  arc: "Variable arc",
  shape: "Shape",
  polyline: "Polyline",
  text: "Text",
  group: "Group",
  passthrough: "Unsupported element",
  any: "Style",
};

function inspectorKind(element: SceneElement): InspectorKind {
  if (element.kind === "passthrough") return "passthrough";
  if (isFixedArc(element)) return readFixedArc(element)?.wedge ? "shape" : "line";
  if (isLabeledLine(element)) return "line";
  if (isArrow(element) || controlKind(element) === "variable-arrow") return "arrow";
  if (controlKind(element) === "variable-bar") return "shape";
  if (element.kind === "group") return "group";
  if (element.kind === "line") return "line";
  if (element.kind === "polyline") return "polyline";
  if (element.kind === "text") return "text";
  return "shape";
}

type MixedStyle = Partial<Record<keyof DrawingStyle, boolean>>;

function StyleControls({
  style,
  kind,
  mixed = {},
  onStyle,
}: {
  style: DrawingStyle;
  kind: InspectorKind;
  /** Settings that differ across a multi-selection. */
  mixed?: MixedStyle;
  onStyle: (patch: Partial<DrawingStyle>) => void;
}) {
  const isText = kind === "text";
  const hasFill = kind === "shape" || kind === "any";
  return (
    <div className="drawing-style-controls">
      <SwatchRow
        label={isText ? "Text color" : "Stroke"}
        swatches={isText ? STROKE_SWATCHES.filter((swatch) => swatch.value !== "none") : STROKE_SWATCHES}
        value={(isText ? mixed.fill : mixed.stroke) ? "" : isText ? style.fill : style.stroke}
        mixed={isText ? mixed.fill : mixed.stroke}
        onChange={(value) => onStyle(isText ? { fill: value } : { stroke: value })}
      />
      {hasFill ? (
        <SwatchRow
          label="Fill"
          swatches={FILL_SWATCHES}
          value={mixed.fill ? "" : style.fill}
          mixed={mixed.fill}
          onChange={(fill) => onStyle({ fill })}
        />
      ) : null}
      {!isText ? (
        <div className="drawing-field-grid">
          <label>
            Weight
            <select
              value={mixed.strokeWidth ? "mixed" : style.strokeWidth}
              onChange={(event) => event.target.value !== "mixed" && onStyle({ strokeWidth: Number(event.target.value) })}
            >
              {mixed.strokeWidth ? (
                <option value="mixed" disabled>
                  Mixed
                </option>
              ) : null}
              {withCurrent(STROKE_WEIGHTS, style.strokeWidth).map((weight) => (
                <option key={weight} value={weight}>
                  {weight} px
                </option>
              ))}
            </select>
          </label>
          {kind !== "arc" ? (
          <label>
            Line
            <select
              value={mixed.lineType ? "mixed" : style.lineType}
              onChange={(event) => event.target.value !== "mixed" && onStyle({ lineType: event.target.value as LineType })}
            >
              {mixed.lineType ? (
                <option value="mixed" disabled>
                  Mixed
                </option>
              ) : null}
              {LINE_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          ) : null}
        </div>
      ) : null}
      {isText || kind === "any" ? (
        <label className="drawing-stack">
          Text size
          <select
            value={mixed.fontSize ? "mixed" : style.fontSize}
            onChange={(event) => event.target.value !== "mixed" && onStyle({ fontSize: Number(event.target.value) })}
          >
            {mixed.fontSize ? (
              <option value="mixed" disabled>
                Mixed
              </option>
            ) : null}
            {withCurrent(FONT_SIZES, style.fontSize).map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function SwatchRow({
  label,
  swatches,
  value,
  mixed = false,
  onChange,
}: {
  label: string;
  swatches: Swatch[];
  value: string;
  mixed?: boolean;
  onChange: (value: string) => void;
}) {
  const isCustom = !mixed && !swatches.some((swatch) => swatch.value.toLowerCase() === value.toLowerCase());
  return (
    <div className="drawing-swatch-row">
      <span>{mixed ? `${label}: mixed` : label}</span>
      <div className="drawing-swatches">
        {swatches.map((swatch) => (
          <button
            key={swatch.value}
            type="button"
            title={swatch.label}
            aria-label={swatch.label}
            aria-pressed={swatch.value.toLowerCase() === value.toLowerCase()}
            className={`drawing-swatch ${swatch.value === "none" ? "none" : ""}`}
            style={swatch.value === "none" ? undefined : { background: swatch.value }}
            onClick={() => onChange(swatch.value)}
          />
        ))}
        <label className={`drawing-swatch drawing-swatch-custom ${isCustom ? "selected" : ""}`} title="More colors…">
          <input
            type="color"
            aria-label={`${label}: more colors`}
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      </div>
    </div>
  );
}

/** A number input that only reports a value when it parses, on blur or Enter. */
function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(formatNumber(value));
  useEffect(() => setText(formatNumber(value)), [value]);
  const commitText = () => {
    const parsed = Number(text);
    if (text.trim() !== "" && Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
    else setText(formatNumber(value));
  };
  return (
    <label>
      {label}
      <input
        inputMode="decimal"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commitText}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitText();
        }}
      />
    </label>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function loadDocument(source: string | null): { document: SceneDocument; notice: string | null } {
  if (source === null) {
    const preset = CANVAS_PRESETS[0];
    return { document: createDocument(preset.width, preset.height), notice: null };
  }
  try {
    const parsed = parseSvg(source);
    const { passthroughTags } = parsed;
    // A control saved without its shapes (e.g. hand-written) is drawn from its
    // settings; ones that have shapes are left exactly as saved.
    const document = {
      ...parsed.document,
      elements: mapDeep(parsed.document.elements, (element) =>
        isControl(element) && element.kind === "group" && element.children.length === 0 ? rebuildControl(element) : element,
      ),
    };
    const notice =
      passthroughTags.length > 0
        ? `Some parts of this drawing (${passthroughTags.map((tag) => `<${tag}>`).join(", ")}) can't be edited yet. They are kept exactly as they were.`
        : null;
    return { document, notice };
  } catch (error) {
    const preset = CANVAS_PRESETS[0];
    return {
      document: createDocument(preset.width, preset.height),
      notice: `${error instanceof Error ? error.message : "Could not read this file."} Starting a blank drawing instead; saving will replace the file.`,
    };
  }
}

/** Variables used in {{calc: ...}} geometry start at 40 so arrows and bars are
 *  visible right away; text variables stay as {{name}} until a value is typed. */
function defaultPreviewValues(document: SceneDocument): PreviewValues {
  const values: PreviewValues = {};
  const source = serializeSvg(document);
  for (const match of source.matchAll(/\{\{\s*calc:([^}]+)\}\}/g)) {
    for (const name of match[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      if (!CALC_FUNCTIONS.includes(name)) values[name] = "40";
    }
  }
  for (const element of document.elements) {
    if (isControl(element)) Object.assign(values, controlPreviewDefaults(element));
  }
  // What the drawing was last saved showing.
  for (const part of (document.rootAttrs["data-nexam-preview"] ?? "").split(";")) {
    const [name, ...rest] = part.split("=");
    if (name?.trim() && rest.length > 0) values[name.trim()] = rest.join("=").trim();
  }
  return values;
}

function canvasSize(document: SceneDocument): { width: number; height: number } {
  const box = (document.rootAttrs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  const hasBox = box.length === 4 && box.every(Number.isFinite);
  return {
    width: literalNumber(document.rootAttrs.width) ?? (hasBox ? box[2] : 320),
    height: literalNumber(document.rootAttrs.height) ?? (hasBox ? box[3] : 180),
  };
}

function viewBoxOrigin(viewBox: string): Point {
  const [x, y] = viewBox.trim().split(/[\s,]+/).map(Number);
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

function resizeDocument(document: SceneDocument, width: number, height: number): SceneDocument {
  const origin = viewBoxOrigin(document.rootAttrs.viewBox ?? "0 0");
  return {
    ...document,
    rootAttrs: {
      ...document.rootAttrs,
      width: formatNumber(width),
      height: formatNumber(height),
      viewBox: `${formatNumber(origin.x)} ${formatNumber(origin.y)} ${formatNumber(width)} ${formatNumber(height)}`,
    },
  };
}

interface SidebarPrefs {
  variablesOpen: boolean;
  layersOpen: boolean;
  layersHeight: number;
}

const SIDEBAR_KEY = "nexam:drawing-sidebar";

/** Which sidebar sections are open, per viewer. Storage may be unavailable. */
function readSidebarPrefs(): SidebarPrefs {
  const fallback: SidebarPrefs = { variablesOpen: true, layersOpen: false, layersHeight: 240 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIDEBAR_KEY) ?? "{}") as Partial<SidebarPrefs>;
    return {
      variablesOpen: typeof parsed.variablesOpen === "boolean" ? parsed.variablesOpen : fallback.variablesOpen,
      layersOpen: typeof parsed.layersOpen === "boolean" ? parsed.layersOpen : fallback.layersOpen,
      layersHeight: typeof parsed.layersHeight === "number" ? parsed.layersHeight : fallback.layersHeight,
    };
  } catch {
    return fallback;
  }
}

function writeSidebarPrefs(prefs: SidebarPrefs) {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, JSON.stringify(prefs));
  } catch {
    // Only a convenience.
  }
}

function SidebarSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="drawing-panel drawing-collapsible">
      <button type="button" className="drawing-section-header" aria-expanded={open} onClick={onToggle}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> {title}
      </button>
      {open ? children : null}
    </section>
  );
}

/** Canvas size and grid: rarely changed, so tucked into a toolbar popover. */
function CanvasMenu({
  width,
  height,
  gridSize,
  activePresetId,
  onPreset,
  onResize,
  onGridSize,
  onClose,
}: {
  width: number;
  height: number;
  gridSize: number;
  activePresetId: string | null;
  onPreset: (preset: CanvasPreset) => void;
  onResize: (width: number, height: number) => void;
  onGridSize: (size: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="drawing-popover" role="dialog" aria-label="Canvas">
      <div className="drawing-preset-list">
        {CANVAS_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={preset.id === activePresetId ? "active" : ""}
            onClick={() => onPreset(preset)}
          >
            <strong>{preset.label}</strong>
            <span>
              {preset.width}×{preset.height} · {preset.hint}
            </span>
          </button>
        ))}
      </div>
      <div className="drawing-field-grid">
        <NumberField label="Width" value={width} onCommit={(value) => value > 0 && onResize(value, height)} />
        <NumberField label="Height" value={height} onCommit={(value) => value > 0 && onResize(width, value)} />
        <label>
          Grid
          <select value={gridSize} onChange={(event) => onGridSize(Number(event.target.value))}>
            {[5, 10, 20].map((value) => (
              <option key={value} value={value}>
                {value} px
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="drawing-muted">Width sets the printed size: 96 px is one inch. Height can be anything.</p>
    </div>
  );
}


/** The scale settings a scale group shares (formulas stay per control). */

/** Variables the drawing uses as angles (arrow directions, arc sweeps and
 *  starts), offered when naming another angle so they can be linked. */
function collectAngleVariables(document: SceneDocument): string[] {
  const names = new Set<string>();
  for (const element of allElements(document.elements)) {
    const angle = controlAngleVariable(element);
    if (angle) names.add(angle);
    const arc = readArcSettings(element);
    if (arc) {
      names.add(arc.sweep);
      if (arc.rotationVariable) names.add(arc.rotationVariable);
    }
  }
  return [...names].sort();
}

/** A line or arrow an arc's start can be lined up with. */
interface LineChoice extends Segment {
  label: string;
  /** Set for a variable-angle arrow: the arc then links to that variable. */
  angleVariable: string | null;
}

function collectScaleGroups(document: SceneDocument): { name: string; scale: string; count: number }[] {
  const groups = new Map<string, { name: string; scale: string; count: number }>();
  for (const element of allElements(document.elements)) {
    const name = isControl(element) ? controlScaleGroup(element) : null;
    if (!name || element.kind !== "group") continue;
    const entry = groups.get(name) ?? { name, scale: `${element.attrs["data-scale"] ?? "1"} px per unit`, count: 0 };
    entry.count += 1;
    groups.set(name, entry);
  }
  return [...groups.values()];
}

function idsOf(elements: SceneElement[]): Set<string> {
  return new Set(elements.flatMap((element) => (element.kind !== "passthrough" && element.attrs.id ? [element.attrs.id] : [])));
}

/** The key of the generated label text inside an arrow, line or control, if it has one. */
function builtInLabelKey(element: SceneElement): string | null {
  if (element.kind !== "group" || !(isArrow(element) || isControl(element) || isFixedArc(element))) return null;
  if (!(element.attrs["data-label"] ?? "").trim()) return null;
  const find = (children: SceneElement[]): string | null => {
    for (const child of children) {
      if (child.kind === "text") return child.key;
      if (child.kind === "group") {
        const found = find(child.children);
        if (found) return found;
      }
    }
    return null;
  };
  return find(element.children);
}

/** "Forces; Newton's Laws" -> ["Forces", "Newton's Laws"] (root data-nexam-topics/-tags). */
function listAttr(value: string | undefined): string[] {
  return (value ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function withListAttr(attrs: Record<string, string>, name: string, values: string[]): Record<string, string> {
  const next = { ...attrs };
  if (values.length > 0) next[name] = values.join("; ");
  else delete next[name];
  return next;
}

/** The preview values written into the saved file (data-nexam-preview), so
 *  the bank's asset thumbnails show a drawing rather than {{placeholders}}. */
function withSavedPreview(document: SceneDocument, values: PreviewValues): SceneDocument {
  const used = new Set(listVariables(document));
  const entries = Object.entries(values)
    .filter(([name, value]) => used.has(name) && value.trim() !== "")
    .map(([name, value]) => `${name}=${value.replace(/[;=]/g, " ").trim()}`);
  const rootAttrs = { ...document.rootAttrs };
  if (entries.length > 0) rootAttrs["data-nexam-preview"] = entries.join("; ");
  else delete rootAttrs["data-nexam-preview"];
  return { ...document, rootAttrs };
}

function stampCategoriesIn(document: SceneDocument): string[] {
  const categories = new Set<string>();
  for (const element of allElements(document.elements)) {
    const category = element.kind === "group" ? element.attrs["data-nexam-stamp-category"] : undefined;
    if (category) categories.add(category);
  }
  return [...categories];
}

/** Topics and tags for the whole drawing, saved on its root so the bank's
 *  asset search and topic filter can find it. */
function TopicsMenu({
  topics,
  tags,
  suggestions,
  stampCategories,
  onChange,
  onClose,
}: {
  topics: string[];
  tags: string[];
  suggestions?: { bank: string[]; fromQuestions: string[] };
  stampCategories: string[];
  onChange: (name: "data-nexam-topics" | "data-nexam-tags", values: string[]) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const has = (list: string[], value: string) => list.some((item) => item.toLowerCase() === value.toLowerCase());
  // The bank's spelling wins, so "mechanics" becomes "Mechanics".
  const canonical = (value: string) => suggestions?.bank.find((item) => item.toLowerCase() === value.toLowerCase()) ?? value;
  const quick = [...(suggestions?.fromQuestions ?? []), ...stampCategories].filter(
    (item, index, list) => !has(topics, item) && list.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index,
  );

  return (
    <div ref={ref} className="drawing-popover drawing-topics-menu" role="dialog" aria-label="Topics and tags">
      <ChipListField
        label="Topics"
        values={topics}
        listId="drawing-topic-suggestions"
        suggestions={suggestions?.bank ?? []}
        onChange={(values) => onChange("data-nexam-topics", values.map(canonical))}
      />
      {quick.length > 0 ? (
        <div className="drawing-quick-topics">
          <span className="drawing-muted">Suggested:</span>
          {quick.map((item) => (
            <button key={item} type="button" onClick={() => onChange("data-nexam-topics", [...topics, canonical(item)])}>
              + {item}
            </button>
          ))}
        </div>
      ) : null}
      <ChipListField label="Tags" values={tags} onChange={(values) => onChange("data-nexam-tags", values)} />
      <p className="drawing-muted">Saved in the drawing file. The bank's asset search and topic filter use them.</p>
    </div>
  );
}

/** Values shown as removable chips, with an input to add more (Enter or comma). */
function ChipListField({
  label,
  values,
  suggestions = [],
  listId,
  onChange,
}: {
  label: string;
  values: string[];
  suggestions?: string[];
  listId?: string;
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const additions = text
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter((item) => item && !values.some((value) => value.toLowerCase() === item.toLowerCase()));
    if (additions.length > 0) onChange([...values, ...additions]);
    setText("");
  };
  return (
    <div className="drawing-stack">
      {label}
      <div className="drawing-chips">
        {values.map((value) => (
          <span key={value} className="drawing-chip">
            {value}
            <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((item) => item !== value))}>
              ×
            </button>
          </span>
        ))}
        <input
          list={listId}
          value={text}
          placeholder={values.length === 0 ? `Add ${label.toLowerCase()}…` : "Add…"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            } else if (event.key === "Backspace" && text === "" && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={add}
        />
      </div>
      {listId ? (
        <datalist id={listId}>
          {suggestions.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/** The drawing without elements hidden in the Layers panel (editor-only). */
function withoutHidden(elements: SceneElement[], hidden: Set<string>): SceneElement[] {
  if (hidden.size === 0) return elements;
  return elements
    .filter((element) => !hidden.has(element.key))
    .map((element) =>
      element.kind === "group" && canEnterGroup(element) ? { ...element, children: withoutHidden(element.children, hidden) } : element,
    );
}

function toggleInSet(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function applyStylePatch(element: SceneElement, patch: Partial<DrawingStyle>, fallback: DrawingStyle): SceneElement {
  if (element.kind === "passthrough") return element;
  if (element.kind === "text") {
    const attrs = { ...element.attrs };
    if (patch.fill !== undefined) attrs.fill = patch.fill;
    if (patch.fontSize !== undefined) attrs["font-size"] = String(patch.fontSize);
    return { ...element, attrs };
  }
  let attrs = { ...element.attrs };
  if (patch.stroke !== undefined || patch.strokeWidth !== undefined || patch.lineType !== undefined) {
    attrs = applyStrokeAttrs(attrs, { ...readStyle(element, fallback), ...patch });
  }
  const takesFill = !isArrow(element) && controlKind(element) !== "variable-arrow";
  if (patch.fill !== undefined && takesFill) attrs.fill = patch.fill;
  return rebuildShape({ ...element, attrs } as SceneElement);
}

function rememberPreviewAngle(element: SceneElement, values: PreviewValues): SceneElement {
  const angleVariable = controlAngleVariable(element);
  if (!angleVariable || element.kind !== "group") return element;
  const angle = Number(values[angleVariable]);
  if (!Number.isFinite(angle) || formatNumber(angle) === element.attrs["data-angle"]) return element;
  return setControlAttrs(element, { "data-angle": formatNumber(angle) });
}

/** Handles for the selection: controls get an anchor and a tip (whose position
 *  depends on the preview value); everything else uses getHandles. */
function selectionHandles(element: SceneElement, values: PreviewValues): { id: string; x: number; y: number }[] {
  if (isControl(element)) {
    const anchor = controlAnchor(element);
    const end = controlEnd(element, values);
    const arc = readArcSettings(element);
    const start = arc ? [{ id: "start", ...arcStartPoint(arc, values) }] : [];
    return anchor && end ? [{ id: "anchor", ...anchor }, ...start, { id: "end", ...end }] : [];
  }
  return getHandles(previewElement(element, values));
}

function withArrowHeads(element: SceneElement, heads: ArrowHeads): SceneElement {
  if (element.kind !== "group") return element;
  return rebuildArrow({ ...element, attrs: { ...element.attrs, "data-heads": heads } });
}

function geometryFields(element: SceneElement): { name: string; label: string; text?: boolean }[] {
  if (isFixedArc(element)) return [];
  if (isArrow(element)) {
    return [
      { name: "data-x1", label: "Tail x" },
      { name: "data-y1", label: "Tail y" },
      { name: "data-x2", label: "Tip x" },
      { name: "data-y2", label: "Tip y" },
    ];
  }
  switch (element.kind) {
    case "line":
      return ["x1", "y1", "x2", "y2"].map((name) => ({ name, label: name }));
    case "rect":
      return [
        { name: "x", label: "x" },
        { name: "y", label: "y" },
        { name: "width", label: "Width" },
        { name: "height", label: "Height" },
        { name: "rx", label: "Corner radius" },
      ];
    case "circle":
      return [
        { name: "cx", label: "Center x" },
        { name: "cy", label: "Center y" },
        { name: "r", label: "Radius" },
      ];
    case "ellipse":
      return [
        { name: "cx", label: "Center x" },
        { name: "cy", label: "Center y" },
        { name: "rx", label: "Radius x" },
        { name: "ry", label: "Radius y" },
      ];
    case "text":
      // An attached text is placed by its shape (drag it to fine-tune).
      return isAnchoredText(element)
        ? []
        : [
            { name: "x", label: "x" },
            { name: "y", label: "y" },
          ];
    case "polygon":
    case "polyline":
      return [{ name: "points", label: "Points", text: true }];
    case "group":
      // Stamps and groups are placed with Size and Rotation (and dragging);
      // editing the raw transform would fight the stored settings.
      return canEnterGroup(element) ? [] : [{ name: "transform", label: "Transform", text: true }];
    default:
      return [];
  }
}

/** Shift-constrained end point: 15° steps for lines, equal sides for boxes. */
function constrain(tool: DrawingTool, start: Point, end: Point, shift: boolean): Point {
  if (!shift) return end;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (tool === "line" || tool === "arrow") {
    const length = Math.hypot(dx, dy);
    const step = Math.PI / 12;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: round2(start.x + Math.cos(angle) * length), y: round2(start.y + Math.sin(angle) * length) };
  }
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + Math.sign(dx || 1) * size, y: start.y + Math.sign(dy || 1) * size };
}

/** The centre of a fixed or variable arc, or null for anything else. */
function arcCentre(element: SceneElement): Point | null {
  const arc = readArcSettings(element) ?? readFixedArc(element);
  return arc ? { x: arc.x, y: arc.y } : null;
}

function withCurrent(options: number[], current: number): number[] {
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
