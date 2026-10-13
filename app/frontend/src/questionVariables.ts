// How an attached drawing gets its values, mirroring
// BankWorkspaceService.resolve_asset_variables in app/backend/service.py: the
// question's variables by name, then the attachment's own values, which win
// and may refer to the question's ("{{force}}", "{{calc: 2 * force}}"). A
// blank attachment value means "use the question's".

import { assetUsesIn } from "./assetSwap";
import { fillPlaceholders } from "./drawing/preview";
import { listVariables, type SceneDocument } from "./drawing/scene";
import { derivedNames } from "./drawing/variables";
import type { QuestionModel } from "./types";

export function resolveAssetVariables(
  questionVariables: Record<string, string> | undefined,
  svgVariables: Record<string, string>,
): Record<string, string> {
  const question = questionVariables ?? {};
  const values: Record<string, string> = { ...question };
  for (const [name, value] of Object.entries(svgVariables)) {
    if (value.trim() === "") continue;
    values[name] = value.includes("{{") ? fillPlaceholders(value, question, false) : value;
  }
  return values;
}

/** The values a drawing needs from its question, with sample values: its
 *  placeholders and declared inputs (not derived variables), sampled from the
 *  declared sample, else what the drawing was saved showing. */
export function drawingInputSamples(document: SceneDocument): Record<string, string> {
  const derived = new Set(derivedNames(document));
  const declared = (document.variables ?? []).filter((variable) => !derived.has(variable.name));
  const names = [...new Set([...declared.map((variable) => variable.name), ...listVariables(document)])].filter((name) => !derived.has(name));
  const preview: Record<string, string> = {};
  for (const part of (document.rootAttrs["data-nexam-preview"] ?? "").split(";")) {
    const [name, ...rest] = part.split("=");
    if (name?.trim() && rest.length > 0) preview[name.trim()] = rest.join("=").trim();
  }
  return Object.fromEntries(
    names.map((name) => [name, declared.find((variable) => variable.name === name)?.sample ?? preview[name] ?? ""]),
  );
}

/** `question` with the drawing's inputs it doesn't set yet added to its
 *  variables (with their samples), or null when nothing is missing. An input
 *  counts as set when the question has it or an attachment of `assetPath`
 *  gives it a value of its own. */
export function withSeededVariables(
  question: QuestionModel,
  assetPath: string,
  samples: Record<string, string>,
): QuestionModel | null {
  const uses = assetUsesIn(question, assetPath);
  if (uses.length === 0) return null;
  const variables = { ...(question.variables ?? {}) };
  let added = false;
  for (const [name, sample] of Object.entries(samples)) {
    if (variables[name] !== undefined) continue;
    if (uses.some((use) => (use.svg_variables[name] ?? "").trim() !== "")) continue;
    variables[name] = sample;
    added = true;
  }
  return added ? { ...question, variables } : null;
}
