// The Layers section of the drawing editor's sidebar: every element, top of
// the stack first, with groups expandable. Click to select (Shift/⌘/Ctrl to
// add); drag a row onto another row to put it just above that one, in that
// row's group, so rows move into and out of groups as well as restack.
// Hiding is editor-only; locking is saved (data-nexam-locked).

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { SceneElement } from "./scene";
import { canEnterGroup, describeElement, type Scope } from "./tree";

export interface LayersPanelProps {
  elements: SceneElement[];
  scope: Scope;
  selection: string[];
  hidden: Set<string>;
  locked: Set<string>;
  onSelect: (scope: Scope, key: string, additive: boolean) => void;
  onToggleHidden: (key: string) => void;
  onToggleLocked: (key: string) => void;
  /** Drop `key` (in the group at `from`) just in front of `targetKey`, in the group at `to`. */
  onMove: (from: Scope, key: string, to: Scope, targetKey: string) => void;
}

export default function LayersPanel(props: LayersPanelProps) {
  const { elements, scope } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(scope));
  const dragRef = useRef<{ key: string; parent: string; x: number; y: number; moved: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Groups on the way to the current scope open so the selection is visible.
  useEffect(() => {
    setExpanded((current) => (scope.every((key) => current.has(key)) ? current : new Set([...current, ...scope])));
  }, [scope]);

  useEffect(() => {
    function rowUnder(event: PointerEvent): HTMLElement | null {
      return (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest("[data-layer-key]") ?? null;
    }
    function onPointerMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) drag.moved = true;
      if (!drag.moved) return;
      const row = rowUnder(event);
      setDropTarget(row && canDrop(drag.key, row) ? row.dataset.layerKey ?? null : null);
    }
    /** Any other row, as long as it isn't inside the row being dragged. */
    function canDrop(key: string, row: HTMLElement): boolean {
      const parent = row.dataset.layerParent ? row.dataset.layerParent.split("/") : [];
      return row.dataset.layerKey !== key && !parent.includes(key);
    }
    function onPointerUp(event: PointerEvent) {
      const drag = dragRef.current;
      dragRef.current = null;
      setDropTarget(null);
      if (!drag?.moved) return;
      const row = rowUnder(event);
      const targetKey = row?.dataset.layerKey;
      if (row && targetKey && canDrop(drag.key, row)) {
        const path = (id: string | undefined) => (id ? id.split("/") : []);
        props.onMove(path(drag.parent), drag.key, path(row.dataset.layerParent), targetKey);
      }
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  });

  const renderList = (list: SceneElement[], parent: Scope, depth: number) =>
    // Top of the stack first, the way drawing apps list layers.
    [...list].reverse().map((element) => {
      const enterable = canEnterGroup(element) && element.kind === "group";
      const open = enterable && expanded.has(element.key);
      const inScope = parent.length === scope.length && parent.every((key, index) => key === scope[index]);
      const selected = inScope && props.selection.includes(element.key);
      const hidden = props.hidden.has(element.key);
      const locked = props.locked.has(element.key);
      const parentId = parent.join("/");
      return (
        <li key={element.key}>
          <div
            className={`drawing-layer-row ${selected ? "selected" : ""} ${dropTarget === element.key ? "drop-target" : ""} ${hidden ? "is-hidden" : ""}`}
            style={{ paddingLeft: `${0.3 + depth * 0.8}rem` }}
            data-layer-key={element.key}
            data-layer-parent={parentId}
            onPointerDown={(event: ReactPointerEvent) => {
              if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
              dragRef.current = { key: element.key, parent: parentId, x: event.clientX, y: event.clientY, moved: false };
            }}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button")) return;
              props.onSelect(parent, element.key, event.shiftKey || event.metaKey || event.ctrlKey);
            }}
          >
            {enterable ? (
              <button
                type="button"
                className="drawing-layer-toggle"
                aria-label={open ? "Collapse" : "Expand"}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(element.key)) next.delete(element.key);
                    else next.add(element.key);
                    return next;
                  })
                }
              >
                {open ? "▾" : "▸"}
              </button>
            ) : (
              <span className="drawing-layer-toggle" aria-hidden="true" />
            )}
            <span className="drawing-layer-name" title={describeElement(element)}>
              {describeElement(element)}
            </span>
            <button
              type="button"
              className={`drawing-layer-flag ${hidden ? "on" : ""}`}
              title={hidden ? "Show while editing" : "Hide while editing (still saved)"}
              aria-pressed={hidden}
              onClick={() => props.onToggleHidden(element.key)}
            >
              {hidden ? "◌" : "●"}
            </button>
            <button
              type="button"
              className={`drawing-layer-flag ${locked ? "on" : ""}`}
              title={locked ? "Unlock" : "Lock so it can't be clicked or moved (saved with the drawing)"}
              aria-pressed={locked}
              onClick={() => props.onToggleLocked(element.key)}
            >
              {locked ? "🔒" : "🔓"}
            </button>
          </div>
          {open && element.kind === "group" ? (
            <ul className="drawing-layer-list">{renderList(element.children, [...parent, element.key], depth + 1)}</ul>
          ) : null}
        </li>
      );
    });

  return (
    <div className="drawing-layers-panel">
      {elements.length === 0 ? (
        <p className="drawing-muted">Nothing drawn yet.</p>
      ) : (
        <ul className="drawing-layer-list">{renderList(elements, [], 0)}</ul>
      )}
      <p className="drawing-muted">
        Top of the list is drawn on top. Drag a row onto another to put it just above it; open a group and drop onto one of its
        rows to move something into the group, or onto an outer row to move it out.
      </p>
    </div>
  );
}
