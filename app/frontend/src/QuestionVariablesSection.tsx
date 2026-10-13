// The question's variables: the values its drawings take by name (see
// "Question-driven variables" in docs/svg-editor-plan.md). Changing one here,
// by hand or by pasting AI-edited JSON, changes every attached drawing that
// uses it. Lists what the drawings need, with their units, and flags inputs
// nothing sets.

import { useState } from "react";

import type { AssetInspectionResponseModel, AssetModel, SvgInputModel } from "./types";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Row {
  name: string;
  value: string | undefined;
  info: SvgInputModel | null;
  /** File names of the drawings that use it. */
  usedBy: string[];
  /** Drawings that use it but get no value: neither the question nor the attachment sets it. */
  unsetIn: string[];
  /** Drawings that set it themselves (the older, per-attachment way), with their values. */
  setIn: { file: string; value: string }[];
}

function fileName(path: string): string {
  return path.split("/").slice(-1)[0] ?? path;
}

/** Names a piece of question text uses: {{name}} and names inside {{calc: …}}. */
export function namesInText(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*calc:\s*([^{}]+?)\s*\}\}/g)) {
    for (const name of match[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) names.add(name);
  }
  for (const match of text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) names.add(match[1]);
  return [...names];
}

export function questionVariableRows(
  variables: Record<string, string>,
  assets: AssetModel[],
  inspections: AssetInspectionResponseModel[],
  /** The question's text by where it is ("prompt", "choice B"), for "used in". */
  texts: Record<string, string> = {},
): Row[] {
  const rows = new Map<string, Row>();
  const row = (name: string): Row => {
    let entry = rows.get(name);
    if (!entry) {
      entry = { name, value: variables[name], info: null, usedBy: [], unsetIn: [], setIn: [] };
      rows.set(name, entry);
    }
    return entry;
  };
  Object.keys(variables).forEach(row);
  for (const [where, text] of Object.entries(texts)) {
    for (const name of namesInText(text)) {
      // Only names the question has: unknown ones may be LaTeX braces.
      if (variables[name] !== undefined) row(name).usedBy.push(where);
    }
  }
  assets.forEach((asset, index) => {
    if (asset.kind !== "svg") return;
    for (const input of inspections[index]?.svg_inputs ?? []) {
      const entry = row(input.name);
      if (!entry.info) entry.info = input;
      entry.usedBy.push(fileName(asset.path));
      const own = (asset.svg_variables[input.name] ?? "").trim();
      if (own !== "") entry.setIn.push({ file: fileName(asset.path), value: own });
      else if (variables[input.name] === undefined) entry.unsetIn.push(fileName(asset.path));
    }
  });
  return [...rows.values()];
}

export default function QuestionVariablesSection({
  variables,
  assets,
  inspections,
  texts,
  editing,
  onChange,
  onPromote,
}: {
  variables: Record<string, string>;
  assets: AssetModel[];
  inspections: AssetInspectionResponseModel[];
  texts: Record<string, string>;
  editing: boolean;
  onChange: (next: Record<string, string>) => void;
  /** Makes a value a drawing sets itself into the question's, clearing it from those drawings. */
  onPromote: (name: string, value: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rows = questionVariableRows(variables, assets, inspections, texts);
  if (rows.length === 0 && !editing) return null;
  if (rows.length === 0 && !assets.some((asset) => asset.kind === "svg")) return null;

  const set = (name: string, value: string) => onChange({ ...variables, [name]: value });
  const remove = (name: string) => {
    const { [name]: _removed, ...rest } = variables;
    onChange(rest);
  };

  return (
    <section className="question-variables">
      <div className="question-section-header">
        <div>
          <h2>Variables</h2>
          <p>
            Values this question's drawings take by name. Use them in the text too: <code>{"{{force}}"}</code>, or{" "}
            <code>{"{{calc: round(force * cos(angle), 1)}}"}</code> for an answer worked out from them. Change them here (or in the
            JSON) and the drawings, text and answers follow.
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="asset-empty">The attached drawings don't use any variables yet.</p>
      ) : (
        <ul className="question-variable-list">
          {rows.map((entry) => (
            <li key={entry.name} className={entry.unsetIn.length > 0 ? "has-issue" : ""}>
              <label>
                <span className="question-variable-name">
                  <code>{entry.name}</code>
                  {entry.info?.label ? <span>{entry.info.label}</span> : null}
                </span>
                <span className="question-variable-value">
                  {entry.value === undefined && entry.setIn.length > 0 ? (
                    <span className="question-variable-set-in">Set in the drawing: {entry.setIn.map((item) => item.value).join(", ")}</span>
                  ) : editing ? (
                    <input
                      value={entry.value ?? ""}
                      placeholder={entry.info?.sample ? `e.g. ${entry.info.sample}` : "value"}
                      onChange={(event) => set(entry.name, event.target.value)}
                    />
                  ) : (
                    <strong>{entry.value ?? "—"}</strong>
                  )}
                  {entry.info?.units ? <span className="question-variable-units">{entry.info.units}</span> : null}
                </span>
              </label>
              <span className="question-variable-use">
                {entry.value === undefined && entry.setIn.length > 0
                  ? `${entry.setIn.map((item) => item.file).join(", ")} sets it for itself.`
                  : entry.unsetIn.length > 0
                  ? `Not set: ${entry.unsetIn.join(", ")} would show it blank.`
                  : entry.usedBy.length > 0
                    ? `Used in ${[...new Set(entry.usedBy)].join(", ")}`
                    : "Not used yet."}
              </span>
              {editing && entry.value === undefined && entry.setIn.length > 0 ? (
                <button
                  type="button"
                  className="link-button"
                  title="Make this a question variable, so every drawing (and a JSON or AI edit) changes it in one place"
                  onClick={() => onPromote(entry.name, entry.setIn[0].value)}
                >
                  Use for every drawing
                </button>
              ) : null}
              {editing && entry.value !== undefined ? (
                <button type="button" className="link-button" title={`Remove ${entry.name}`} onClick={() => remove(entry.name)}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <form
          className="question-variable-add"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newName.trim();
            if (!NAME.test(name)) {
              setError("Use letters, digits and _ only, starting with a letter.");
              return;
            }
            if (variables[name] !== undefined) {
              setError(`${name} is already a variable.`);
              return;
            }
            setError(null);
            set(name, "");
            setNewName("");
          }}
        >
          <input aria-label="New variable name" value={newName} placeholder="Add a variable, e.g. mass" onChange={(event) => setNewName(event.target.value)} />
          <button type="submit" disabled={!newName.trim()}>
            Add
          </button>
          {error ? <span className="question-variable-error">{error}</span> : null}
        </form>
      ) : null}
    </section>
  );
}

/** One attached drawing's own values (e.g. a choice image used as a
 *  distractor): blank uses the question's variable of the same name; a value
 *  wins for this drawing only and may refer to the question's variables, as
 *  in "{{calc: 2 * slope}}". */
export function AttachmentValuesEditor({
  inputs,
  values,
  questionVariables,
  label = "Values for this image",
  onChange,
}: {
  inputs: SvgInputModel[];
  values: Record<string, string>;
  questionVariables: Record<string, string>;
  label?: string;
  onChange: (next: Record<string, string>) => void;
}) {
  if (inputs.length === 0) return null;
  const own = inputs.filter((input) => (values[input.name] ?? "").trim() !== "").length;
  return (
    <details className="attachment-values">
      <summary>
        {label}
        {own > 0 ? ` · ${own} changed` : " · from the question"}
      </summary>
      <p className="attachment-values-hint">
        Leave blank to use the question's value. A value here changes this image only, e.g. <code>{"{{calc: 2 * slope}}"}</code> for a
        distractor.
      </p>
      {inputs.map((input) => (
        <label key={input.name}>
          <code>{input.name}</code>
          <input
            value={values[input.name] ?? ""}
            placeholder={questionVariables[input.name] !== undefined ? `from question: ${questionVariables[input.name] || "(blank)"}` : "not set"}
            onChange={(event) => {
              const next = { ...values, [input.name]: event.target.value };
              if (event.target.value === "") delete next[input.name];
              onChange(next);
            }}
          />
          {input.units ? <span>{input.units}</span> : null}
        </label>
      ))}
    </details>
  );
}
