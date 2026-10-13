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

export function questionVariableRows(
  variables: Record<string, string>,
  assets: AssetModel[],
  inspections: AssetInspectionResponseModel[],
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
  editing,
  onChange,
  onPromote,
}: {
  variables: Record<string, string>;
  assets: AssetModel[];
  inspections: AssetInspectionResponseModel[];
  editing: boolean;
  onChange: (next: Record<string, string>) => void;
  /** Makes a value a drawing sets itself into the question's, clearing it from those drawings. */
  onPromote: (name: string, value: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rows = questionVariableRows(variables, assets, inspections);
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
          <p>Values this question's drawings take by name. Change them here (or in the JSON) and every attached drawing follows.</p>
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
                    ? `Used by ${entry.usedBy.join(", ")}`
                    : "Not used by an attached drawing."}
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
