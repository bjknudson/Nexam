// Reworking an AI-made test version before it is created (VersionImportDialog).
// Every change edits the pasted JSON, which is then checked again, so the
// review always shows exactly what Create would make:
// - use the original: put the original question back under its id;
// - leave out: drop a question the AI added;
// - needs work: ask the AI to redo just those questions, then swap its answers
//   in by id. The follow-up reply must hold exactly the ids asked for.

import { MATH_RULES, VARIABLE_RULES } from "./AiPromptDialog";
import type { VersionItemModel } from "./types";

export type Payload = Record<string, unknown>;
type QuestionJson = Record<string, unknown>;

function questionsOf(payload: Payload): QuestionJson[] {
  return Array.isArray(payload.questions) ? (payload.questions as QuestionJson[]) : [];
}

function withQuestions(payload: Payload, questions: QuestionJson[]): Payload {
  return { ...payload, questions };
}

/** Stable key for a review row's decision: the original id, or the pasted position. */
export function itemKey(item: VersionItemModel): string {
  return item.original_id ? item.original_id : `new:${item.payload_index ?? item.position}`;
}

/** The changed question's pasted entry, replaced with the original. */
export function withOriginal(payload: Payload, item: VersionItemModel): Payload {
  if (item.payload_index == null || !item.original) return payload;
  const questions = [...questionsOf(payload)];
  questions[item.payload_index] = item.original as unknown as QuestionJson;
  return withQuestions(payload, questions);
}

/** Put back a question the AI wrote, after `withOriginal`. */
export function restoreAiVersion(payload: Payload, originalId: string, aiQuestion: QuestionJson): Payload {
  const questions = [...questionsOf(payload)];
  const index = questions.findIndex((question) => question.id === originalId);
  if (index >= 0) questions[index] = aiQuestion;
  else questions.push(aiQuestion);
  return withQuestions(payload, questions);
}

/** Drop a question the AI added, and any test item that names it. */
export function leaveOut(payload: Payload, item: VersionItemModel): Payload {
  if (item.payload_index == null) return payload;
  const questions = [...questionsOf(payload)];
  const [removed] = questions.splice(item.payload_index, 1);
  const next = withQuestions(payload, questions);
  const id = typeof removed?.id === "string" ? removed.id : "";
  const test = payload.test as Payload | undefined;
  if (id && test && Array.isArray(test.items)) {
    next.test = { ...test, items: (test.items as Payload[]).filter((entry) => entry.question_id !== id) };
  }
  return next;
}

export interface ReworkRequest {
  /** The id the AI must keep: the original's, or one given to a new question. */
  id: string;
  note: string;
  question: QuestionJson;
}

/** The questions to send back, each with an id to match the reply by. A new
 *  question without one is given `new_1`, `new_2`...; Nexam replaces those
 *  with real ids when the version is created. */
export function prepareRework(
  payload: Payload,
  items: VersionItemModel[],
  notes: Record<string, string>,
): { payload: Payload; requests: ReworkRequest[] } {
  const questions = [...questionsOf(payload)];
  const taken = new Set(questions.map((question) => String(question.id ?? "")));
  let counter = 1;
  const requests: ReworkRequest[] = [];
  for (const item of items) {
    const note = notes[itemKey(item)];
    if (note === undefined) continue;
    let question: QuestionJson;
    if (item.payload_index != null) {
      question = questions[item.payload_index];
    } else if (item.original) {
      // Left out of the reply, so not pasted: send the original.
      question = item.original as unknown as QuestionJson;
    } else {
      continue;
    }
    let id = typeof question.id === "string" && question.id.trim() ? question.id : "";
    if (!id) {
      while (taken.has(`new_${counter}`)) counter += 1;
      id = `new_${counter}`;
      taken.add(id);
      question = { ...question, id };
      if (item.payload_index != null) questions[item.payload_index] = question;
    }
    requests.push({ id, note: note.trim(), question });
  }
  return { payload: withQuestions(payload, questions), requests };
}

export function buildReworkPrompt(requests: ReworkRequest[]): string {
  const ids = requests.map((request) => request.id);
  const usesVariables = requests.some((request) => {
    const variables = request.question.variables;
    return variables && typeof variables === "object" && Object.keys(variables).length > 0;
  });
  const sections = [
    `You made a new version of a test for Nexam, a question bank app teachers use to build printed tests. Most of it is good. Please rework only the ${requests.length === 1 ? "question" : `${requests.length} questions`} below, following my note on each.`,
    `Notes:\n${requests.map((request) => `- ${request.id}: ${request.note || "Rework this question."}`).join("\n")}`,
    `Return only this JSON: {"questions": [...]} with exactly ${requests.length === 1 ? "this question" : `these ${requests.length} questions`} (${ids.join(", ")}). Keep each question's "id" exactly as given, so Nexam can put it back in its place. Keep each question's type, difficulty and standards unless my note says otherwise. Do not return any other questions, and do not add commentary or code fences.`,
    MATH_RULES,
  ];
  if (usesVariables) sections.push(VARIABLE_RULES);
  return sections.join("\n\n");
}

export function reworkJson(requests: ReworkRequest[]): string {
  return JSON.stringify({ questions: requests.map((request) => request.question) }, null, 2);
}

/** Swap the AI's reworked questions in by id. Strict: the reply must hold
 *  exactly the ids asked for, since a wrong one can't be placed safely. */
export function mergeRework(
  payload: Payload,
  requests: ReworkRequest[],
  reply: Payload,
): { payload: Payload; ids: string[] } | { error: string } {
  let returned: unknown[] = [];
  if (Array.isArray(reply.questions)) returned = reply.questions;
  else if (typeof reply.id === "string") returned = [reply];
  const expected = requests.map((request) => request.id);
  const got = returned.map((question) =>
    question && typeof question === "object" ? String((question as QuestionJson).id ?? "").trim() || "(no id)" : "(not a question)",
  );
  const sameSet = got.length === expected.length && expected.every((id) => got.includes(id)) && new Set(got).size === got.length;
  if (!sameSet) {
    return {
      error: `Expected ${expected.join(", ")}; the reply has ${got.length > 0 ? got.join(", ") : "no questions"}. Fix the ids in the reply, or ask the AI to return exactly those questions with the same ids.`,
    };
  }
  const questions = [...questionsOf(payload)];
  for (const question of returned as QuestionJson[]) {
    const index = questions.findIndex((entry) => entry.id === question.id);
    if (index >= 0) questions[index] = question;
    else questions.push(question);
  }
  return { payload: withQuestions(payload, questions), ids: expected };
}
