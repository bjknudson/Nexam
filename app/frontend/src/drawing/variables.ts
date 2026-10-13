// A drawing's declared variables: the inputs a question supplies (with an
// optional label, units and sample value) and derived variables worked out
// from them (Fx = force * cos(angle)), with an optional "show as" rounding.
// Saved in the SVG as <metadata id="nexam-variables">{"variables": [...]}
// </metadata>, read by app/backend/svg_variables.py the same way.
// See "Question-driven variables" in docs/svg-editor-plan.md.

import { evaluateToText, expressionError, type PreviewValues, type RoundShow } from "./preview";
import { CALC_FUNCTIONS, type SceneDocument } from "./scene";

export interface DeclaredVariable {
  name: string;
  label?: string;
  units?: string;
  /** Inputs: the value shown while editing, offered to a question that attaches the drawing. */
  sample?: string;
  /** Derived variables: the formula, in inputs and earlier derived variables. */
  formula?: string;
  show?: RoundShow;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isDerived(variable: DeclaredVariable): boolean {
  return typeof variable.formula === "string" && variable.formula.trim() !== "";
}

/** The declarations in the metadata block's JSON, keeping only readable entries. */
export function parseDeclarations(json: string): DeclaredVariable[] {
  try {
    const data = JSON.parse(json) as { variables?: unknown };
    if (!Array.isArray(data.variables)) return [];
    return data.variables.flatMap((item): DeclaredVariable[] => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const name = typeof entry.name === "string" ? entry.name : "";
      if (!NAME.test(name)) return [];
      const text = (key: string) => (typeof entry[key] === "string" && (entry[key] as string).trim() !== "" ? (entry[key] as string) : undefined);
      const show = entry.show as { kind?: unknown; places?: unknown } | undefined;
      const kind = show?.kind === "decimals" || show?.kind === "sig" ? show.kind : null;
      return [
        {
          name,
          label: text("label"),
          units: text("units"),
          sample: text("sample"),
          formula: text("formula"),
          show: kind ? { kind, places: Math.max(kind === "sig" ? 1 : 0, Math.min(10, Math.trunc(Number(show?.places) || 0))) } : undefined,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** The metadata block's JSON: one variable per line, so the file stays readable. */
export function declarationsJson(variables: DeclaredVariable[]): string {
  const rows = variables.map((variable) => {
    const entry: Record<string, unknown> = { name: variable.name };
    for (const key of ["label", "units", "sample", "formula"] as const) {
      if (variable[key]) entry[key] = variable[key];
    }
    if (variable.show) entry.show = variable.show;
    return `  ${JSON.stringify(entry)}`;
  });
  return `{"variables": [\n${rows.join(",\n")}\n]}`;
}

/** Preview values plus every derived variable, worked out in order. */
export function withDerived(document: SceneDocument, values: PreviewValues): PreviewValues {
  const derived = (document.variables ?? []).filter(isDerived);
  if (derived.length === 0) return values;
  const result = { ...values };
  for (const variable of derived) result[variable.name] = evaluateToText(variable.formula ?? "", result, variable.show);
  return result;
}

export function derivedNames(document: SceneDocument): string[] {
  return (document.variables ?? []).filter(isDerived).map((variable) => variable.name);
}

/** Why a derived formula can't be used, given the names before it. */
export function derivedFormulaError(formula: string, earlierNames: string[]): string | null {
  return expressionError(formula, earlierNames);
}

/** Names a new variable mustn't take. */
export function isReservedName(name: string): boolean {
  return name === "calc" || CALC_FUNCTIONS.includes(name);
}

/** The declared entry for `name`, or a bare one (an undeclared placeholder). */
export function declarationOf(document: SceneDocument, name: string): DeclaredVariable {
  return (document.variables ?? []).find((variable) => variable.name === name) ?? { name };
}

/** Adds, replaces or removes (`next` null) the declaration of `name`, keeping order. */
export function setDeclaration(document: SceneDocument, name: string, next: DeclaredVariable | null): SceneDocument {
  const list = document.variables ?? [];
  const index = list.findIndex((variable) => variable.name === name);
  let variables: DeclaredVariable[];
  if (next === null) variables = list.filter((variable) => variable.name !== name);
  else if (index >= 0) variables = list.map((variable, position) => (position === index ? next : variable));
  else variables = [...list, next];
  return { ...document, variables };
}
