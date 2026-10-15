import { describe, expect, it } from "vitest";

import type { VersionItemModel } from "./types";
import { buildReworkPrompt, itemKey, leaveOut, mergeRework, prepareRework, restoreAiVersion, withOriginal } from "./versionRework";

const original = { id: "q_mc_0001", type: "multiple_choice", prompt: "Old?" };
const aiChanged = { id: "q_mc_0001", type: "multiple_choice", prompt: "New?" };
const aiNew = { type: "multiple_choice", prompt: "Brand new?" };
const payload = {
  test: { items: [{ question_id: "q_mc_0001" }, { question_id: "q_mc_0002" }] },
  questions: [aiChanged, { id: "q_mc_0002", type: "short_answer", prompt: "Same" }, aiNew],
};

function item(fields: Partial<VersionItemModel>): VersionItemModel {
  return { position: 1, kind: "question", status: "kept", issues: [], ...fields } as VersionItemModel;
}

const changedRow = item({ status: "changed", original_id: "q_mc_0001", payload_index: 0, original: original as never });
const newRow = item({ status: "new", payload_index: 2, position: 3 });

describe("version rework", () => {
  it("keys rows by original id, or by pasted position for new questions", () => {
    expect(itemKey(changedRow)).toBe("q_mc_0001");
    expect(itemKey(newRow)).toBe("new:2");
  });

  it("puts the original back under its id, and can undo that", () => {
    const reverted = withOriginal(payload, changedRow);
    expect((reverted.questions as unknown[])[0]).toEqual(original);
    expect((restoreAiVersion(reverted, "q_mc_0001", aiChanged).questions as unknown[])[0]).toEqual(aiChanged);
  });

  it("leaves out a new question and any item naming it", () => {
    const named = { ...payload, questions: [...payload.questions.slice(0, 2), { ...aiNew, id: "x1" }], test: { items: [...payload.test.items, { question_id: "x1" }] } };
    const result = leaveOut(named, newRow);
    expect(result.questions).toHaveLength(2);
    expect((result.test as { items: unknown[] }).items).toHaveLength(2);
  });

  it("gives new questions a temporary id and asks for exactly those ids", () => {
    const { payload: stamped, requests } = prepareRework(payload, [changedRow, newRow], { "q_mc_0001": "Harder distractors", "new:2": "" });
    expect(requests.map((request) => request.id)).toEqual(["q_mc_0001", "new_1"]);
    expect(((stamped.questions as { id?: string }[])[2]).id).toBe("new_1");
    const prompt = buildReworkPrompt(requests);
    expect(prompt).toContain("- q_mc_0001: Harder distractors");
    expect(prompt).toContain("- new_1: Rework this question.");
    expect(prompt).toContain("exactly these 2 questions (q_mc_0001, new_1)");
  });

  it("swaps reworked questions in by id and leaves the rest alone", () => {
    const { payload: stamped, requests } = prepareRework(payload, [changedRow, newRow], { "q_mc_0001": "", "new:2": "" });
    const reply = { questions: [{ id: "new_1", type: "multiple_choice", prompt: "Better new?" }, { id: "q_mc_0001", type: "multiple_choice", prompt: "Better?" }] };
    const merged = mergeRework(stamped, requests, reply);
    if ("error" in merged) throw new Error(merged.error);
    const prompts = (merged.payload.questions as { prompt: string }[]).map((question) => question.prompt);
    expect(prompts).toEqual(["Better?", "Same", "Better new?"]);
  });

  it("refuses a reply with the wrong ids instead of guessing", () => {
    const { payload: stamped, requests } = prepareRework(payload, [changedRow], { "q_mc_0001": "" });
    const merged = mergeRework(stamped, requests, { questions: [{ id: "q_mc_0099", prompt: "?" }] });
    expect(merged).toEqual({ error: expect.stringContaining("Expected q_mc_0001; the reply has q_mc_0099") });
  });

  it("accepts a single question object as the reply", () => {
    const { payload: stamped, requests } = prepareRework(payload, [changedRow], { "q_mc_0001": "" });
    const merged = mergeRework(stamped, requests, { id: "q_mc_0001", type: "multiple_choice", prompt: "Solo" });
    expect("error" in merged).toBe(false);
  });
});
