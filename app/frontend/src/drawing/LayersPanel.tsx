// The Layers tab of the drawing editor's left rail: every element, top of the
// stack first, with groups expandable. Click to select (Shift/⌘/Ctrl to add),
// drag a row onto another row to restack it, and hide or lock rows while
// editing. Hiding and locking are editor-only and never saved.

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
  /** Drop `key` just in front of `targetKey`; both live in `scope`. */
  onMove: (scope: Scope, key: string, targetKey: string) => void;
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
      // Restacking stays within one group; moving into or out of groups is Group/Ungroup's job.
      setDropTarget(row && row.dataset.layerParent === drag.parent && row.dataset.layerKey !== drag.key ? row.dataset.layerKey ?? null : null);
    }
    function onPointerUp(event: PointerEvent) {
      const drag = dragRef.current;
      dragRef.current = null;
      setDropTarget(null);
      if (!drag?.moved) return;
      const row = rowUnder(event);
      const targetKey = row?.dataset.layerKey;
      if (row && targetKey && row.dataset.layerParent === drag.parent && targetKey !== drag.key) {
        props.onMove(drag.parent ? drag.parent.split("/") : [], drag.key, targetKey);
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
              title={locked ? "Unlock" : "Lock so it can't be clicked or moved"}
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
      <p className="drawing-muted">Top of the list is drawn on top. Drag a row to restack it.</p>
    </div>
  );
}
