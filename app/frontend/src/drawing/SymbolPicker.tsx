// The Ω button next to text and label fields: inserts symbols at the cursor,
// plus a few LaTeX snippets for the $…$ math subset (see mathText.ts), and a
// preview of what the math means (KaTeX) next to what the drawing will show.

import katex from "katex";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { mathToSvg, splitSegments } from "./mathText";

interface SymbolGroup {
  name: string;
  items: { insert: string; label?: string; title?: string }[];
}

const chars = (text: string) => [...text].map((insert) => ({ insert }));

// "|" in a snippet marks where the cursor goes after inserting it.
const GROUPS: SymbolGroup[] = [
  { name: "Greek", items: chars("θφαβγδλμωπρστεηΔΣΩΦΘΛΠΨ") },
  { name: "Math", items: chars("×·÷±≈≠≤≥∝√∞∑∫∂′″") },
  { name: "Arrows", items: chars("→←↑↓↔⇒⊥∥∠△") },
  { name: "Units", items: chars("°ΩμÅℓℏ%") },
  { name: "Sub / super", items: chars("₀₁₂₃₄₅₆₇₈₉⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻") },
  {
    name: "LaTeX",
    items: [
      { insert: "$x_{|}$", label: "x₁", title: "Subscript: $x_{…}$" },
      { insert: "$x^{|}$", label: "x²", title: "Superscript: $x^{…}$" },
      { insert: "$\\vec{|}$", label: "F⃗", title: "Vector: $\\vec{F}$" },
      { insert: "$\\frac{|}{}$", label: "a/b", title: "Fraction (inline in drawings): $\\frac{a}{b}$" },
      { insert: "$\\sqrt{|}$", label: "√x", title: "Square root: $\\sqrt{x}$" },
      { insert: "$\\theta$", label: "\\θ", title: "Greek letter by name: $\\theta$" },
      { insert: "$\\Delta |$", label: "Δx", title: "Change in: $\\Delta x$" },
      { insert: "$|^\\circ$", label: "x°", title: "Degrees: $30^\\circ$" },
    ],
  },
];

const RECENT_KEY = "nexam:drawing-recent-symbols";

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

function remember(insert: string) {
  try {
    const next = [insert, ...readRecent().filter((item) => item !== insert)].slice(0, 12);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Recently used symbols are a convenience; storage may be unavailable.
  }
}

/** Inserts `insert` at the field's selection; returns the new value and caret position. */
export function insertAtSelection(
  value: string,
  field: HTMLInputElement | HTMLTextAreaElement | null,
  insert: string,
): { value: string; caret: number } {
  const start = field?.selectionStart ?? value.length;
  const end = field?.selectionEnd ?? value.length;
  const marker = insert.indexOf("|");
  const text = insert.replace("|", "");
  return {
    value: value.slice(0, start) + text + value.slice(end),
    caret: start + (marker >= 0 ? marker : text.length),
  };
}

/** Puts the caret at a position once a controlled field has re-rendered with
 *  its new value (setting it earlier is undone when React updates the value). */
export function useCaretAfterUpdate(
  fieldRef: RefObject<HTMLInputElement | HTMLTextAreaElement>,
  value: string,
): (caret: number) => void {
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pending.current === null) return;
    const field = fieldRef.current;
    if (field && field.value === value) {
      field.focus();
      field.setSelectionRange(pending.current, pending.current);
      pending.current = null;
    }
  }, [fieldRef, value]);
  return (caret) => {
    pending.current = caret;
  };
}

export default function SymbolPicker({
  fieldRef,
  onInsert,
}: {
  fieldRef: RefObject<HTMLInputElement | HTMLTextAreaElement>;
  /** Called with the text to insert ("|" marks the caret). */
  onInsert: (insert: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState(() => (readRecent().length > 0 ? "Recent" : "Greek"));
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const recent = readRecent();
  const groups: SymbolGroup[] = recent.length > 0 ? [{ name: "Recent", items: recent.map((insert) => ({ insert })) }, ...GROUPS] : GROUPS;
  const shown = groups.find((item) => item.name === group) ?? groups[0];

  return (
    <div className="drawing-symbols" ref={ref}>
      <button
        type="button"
        className="drawing-symbols-button"
        aria-expanded={open}
        title="Insert a symbol or math"
        // Keep the field's selection: don't take focus from it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
      >
        Ω
      </button>
      {open ? (
        <div className="drawing-symbols-panel" role="dialog" aria-label="Symbols">
          <div className="drawing-symbols-tabs" role="tablist">
            {groups.map((item) => (
              <button
                key={item.name}
                type="button"
                role="tab"
                aria-selected={item.name === shown.name}
                className={item.name === shown.name ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setGroup(item.name)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <div className={`drawing-symbols-grid ${shown.name === "LaTeX" ? "wide" : ""}`}>
            {shown.items.map((item) => (
              <button
                key={item.insert}
                type="button"
                title={item.title ?? item.insert}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  remember(item.insert);
                  onInsert(item.insert);
                  fieldRef.current?.focus();
                }}
              >
                {item.label ?? item.insert}
              </button>
            ))}
          </div>
          <p className="drawing-muted">
            Math goes between <code>$…$</code>, e.g. <code>{"$F_{net}$ = {{force}} N"}</code>.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Under a field with $…$ math: what the author meant (KaTeX), and any
 *  commands the drawing can't show. The canvas shows the actual result. */
export function MathHint({ text }: { text: string }) {
  const segments = splitSegments(text).filter((segment) => segment.math);
  if (segments.length === 0) return null;
  const { unsupported } = mathToSvg(text);
  return (
    <div className="drawing-math-hint">
      <span className="drawing-muted">Means:</span>{" "}
      {segments.map((segment, index) => (
        <span
          key={index}
          className="drawing-math-katex"
          // KaTeX output from the author's own text; throwOnError: false keeps bad input visible, not thrown.
          dangerouslySetInnerHTML={{ __html: katex.renderToString(segment.value.replace(/\{\{([^{}]+)\}\}/g, "\\text{$1}"), { throwOnError: false }) }}
        />
      ))}
      {unsupported.length > 0 ? (
        <span className="drawing-error"> Not supported in drawings: {unsupported.join(", ")} (shown as typed).</span>
      ) : null}
    </div>
  );
}
