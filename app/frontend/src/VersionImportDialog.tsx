// Import a new version of a test from AI-edited JSON: paste what the AI
// returned, review each slot (kept, changed beside its original, new, or kept
// because the AI left it out), decide on each one, optionally ask the AI to
// rework the ones that need it, then create the version as a new test draft.
// See app/backend/test_versions.py and versionRework.ts.

import { useState } from "react";

import { AiSteps } from "./AiPromptDialog";
import { parseAiJson } from "./aiJson";
import { createTestVersion, previewTestVersion } from "./api";
import {
  buildReworkPrompt,
  itemKey,
  leaveOut,
  mergeRework,
  prepareRework,
  restoreAiVersion,
  reworkJson,
  withOriginal,
  type Payload,
  type ReworkRequest,
} from "./versionRework";
import { MathTextPreview } from "./MathPreview";
import { QuestionValuesContext } from "./questionValuesContext";
import type { QuestionModel, TestDraftDetailModel, VersionItemModel, VersionPreviewModel } from "./types";

const STATUS_LABEL: Record<VersionItemModel["status"], string> = {
  kept: "Kept",
  changed: "Changed",
  new: "New",
  restored: "Kept (the AI left it out)",
  section: "Section",
};

function QuestionSummary({ question }: { question: QuestionModel }) {
  const answer = (question.answer ?? {}) as { choices?: unknown[]; correct_choice_index?: number; value?: unknown; unit?: unknown };
  return (
    <QuestionValuesContext.Provider value={question.variables ?? null}>
      <div className="version-question">
        <MathTextPreview text={question.prompt} />
        {Array.isArray(answer.choices) ? (
          <ol className="version-choices">
            {answer.choices.map((choice, index) => (
              <li key={index} className={index === answer.correct_choice_index ? "correct" : ""}>
                <MathTextPreview text={String(choice)} inline preferWholeExpression />
              </li>
            ))}
          </ol>
        ) : null}
        {answer.value !== undefined ? (
          <p className="version-answer">
            Answer: <MathTextPreview text={`${String(answer.value)} ${String(answer.unit ?? "")}`} inline />
          </p>
        ) : null}
        <p className="version-meta">
          {question.type.replace("_", " ")} · difficulty {question.difficulty}
          {question.standards.length > 0 ? ` · ${question.standards.map((item) => item.standard_id).join(", ")}` : ""}
        </p>
      </div>
    </QuestionValuesContext.Provider>
  );
}

export default function VersionImportDialog({
  testId,
  testLabel,
  text,
  onTextChange,
  onBack,
  onClose,
  onCreated,
}: {
  testId: string;
  /** e.g. "Unit Test, version A" */
  testLabel: string;
  /** The pasted reply, kept by the caller so it survives going back a step. */
  text: string;
  onTextChange: (text: string) => void;
  /** Back from the paste step to the AI prompt. */
  onBack?: () => void;
  onClose: () => void;
  onCreated: (detail: TestDraftDetailModel) => void;
}) {
  const [mode, setMode] = useState<"paste" | "review" | "rework">("paste");
  const [keepMissing, setKeepMissing] = useState(true);
  const [preview, setPreview] = useState<VersionPreviewModel | null>(null);
  const [payload, setPayload] = useState<Payload | null>(null);
  // The pasted text the review was made from, so Back then Next keeps the decisions.
  const [reviewedText, setReviewedText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Needs work: a note per row (an empty note still counts).
  const [notes, setNotes] = useState<Record<string, string>>({});
  // The AI's question, kept when the teacher chose the original instead.
  const [aiVersions, setAiVersions] = useState<Record<string, Record<string, unknown>>>({});
  const [reworked, setReworked] = useState<string[]>([]);
  const [rework, setRework] = useState<{ requests: ReworkRequest[]; keys: string[] } | null>(null);
  const [reworkReply, setReworkReply] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  async function check(next: Payload): Promise<boolean> {
    setBusy(true);
    try {
      setPreview(await previewTestVersion(testId, next, keepMissing));
      setPayload(next);
      setError(null);
      return true;
    } catch (problem) {
      setError((problem as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function review() {
    if (preview && text === reviewedText) {
      setMode("review");
      return;
    }
    const parsed = parseAiJson(text);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (await check(parsed.value)) {
      setReviewedText(text);
      setNotes({});
      setAiVersions({});
      setReworked([]);
      setMode("review");
    }
  }

  async function create() {
    if (!payload) return;
    setBusy(true);
    try {
      onCreated(await createTestVersion(testId, payload, keepMissing));
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function setNote(key: string, note: string | undefined) {
    setNotes((current) => {
      const next = { ...current };
      if (note === undefined) delete next[key];
      else next[key] = note;
      return next;
    });
  }

  async function chooseOriginal(item: VersionItemModel) {
    if (!payload || item.payload_index == null || !item.original_id) return;
    const aiQuestion = (payload.questions as Record<string, unknown>[])[item.payload_index];
    if (await check(withOriginal(payload, item))) {
      setAiVersions((current) => ({ ...current, [item.original_id as string]: aiQuestion }));
      setNote(itemKey(item), undefined);
    }
  }

  async function undoOriginal(originalId: string) {
    if (!payload || !aiVersions[originalId]) return;
    if (await check(restoreAiVersion(payload, originalId, aiVersions[originalId]))) {
      setAiVersions(({ [originalId]: _, ...rest }) => rest);
    }
  }

  async function chooseLeaveOut(item: VersionItemModel) {
    if (!payload || item.payload_index == null) return;
    const removed = item.payload_index;
    if (await check(leaveOut(payload, item))) {
      // Later pasted questions move up one, so their keys do too.
      const shift = (key: string) => {
        const match = key.match(/^new:(\d+)$/);
        if (!match) return key;
        const index = Number(match[1]);
        return index > removed ? `new:${index - 1}` : key;
      };
      setNotes((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== `new:${removed}`).map(([key, note]) => [shift(key), note])),
      );
      setReworked((current) => current.filter((key) => key !== `new:${removed}`).map(shift));
    }
  }

  function startRework() {
    if (!payload || !preview) return;
    const rows = preview.items.filter((item) => item.kind === "question" && notes[itemKey(item)] !== undefined);
    const prepared = prepareRework(payload, rows, notes);
    setPayload(prepared.payload);
    setRework({ requests: prepared.requests, keys: rows.map(itemKey) });
    setReworkReply("");
    setCopied(null);
    setError(null);
    setMode("rework");
  }

  async function applyRework() {
    if (!payload || !rework) return;
    const parsed = parseAiJson(reworkReply);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    const merged = mergeRework(payload, rework.requests, parsed.value);
    if ("error" in merged) {
      setError(merged.error);
      return;
    }
    if (await check(merged.payload)) {
      setNotes((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !rework.keys.includes(key))));
      setReworked((current) => [...new Set([...current, ...rework.keys])]);
      setRework(null);
      setMode("review");
    }
  }

  function copy(label: string, value: string) {
    void navigator.clipboard.writeText(value).then(
      () => setCopied(label),
      () => setCopied(null),
    );
  }

  const questions = preview?.items.filter((item) => item.kind === "question") ?? [];
  const count = (status: VersionItemModel["status"]) => questions.filter((item) => item.status === status).length;
  const needsWork = questions.filter((item) => notes[itemKey(item)] !== undefined).length;
  const reworkPrompt = rework ? buildReworkPrompt(rework.requests) : "";
  const reworkQuestions = rework ? reworkJson(rework.requests) : "";
  const plural = (n: number) => (n === 1 ? "question" : "questions");

  function decisions(item: VersionItemModel) {
    const key = itemKey(item);
    if (item.status === "kept" && item.original_id && aiVersions[item.original_id]) {
      const originalId = item.original_id;
      return (
        <div className="version-decision">
          <span className="version-decision-note">Using the original question.</span>
          <button type="button" className="link-button" onClick={() => void undoOriginal(originalId)} disabled={busy}>
            Use the AI&rsquo;s version instead
          </button>
        </div>
      );
    }
    const working = notes[key] !== undefined;
    const unchanged = item.status === "kept" || item.status === "restored";
    if (unchanged && !working) {
      return (
        <div className="version-decision">
          <button
            type="button"
            className="version-decision-link"
            onClick={() => setNote(key, "")}
            disabled={busy}
            title="Ask the AI to change this question too, with your note"
          >
            Needs work…
          </button>
        </div>
      );
    }
    const choice = (label: string, active: boolean, onClick: () => void, title?: string) => (
      <button type="button" className={active ? "active" : ""} aria-pressed={active} onClick={onClick} disabled={busy} title={title}>
        {label}
      </button>
    );
    return (
      <div className="version-decision" role="group" aria-label={`Decision for ${item.original_id ?? "new question"}`}>
        {choice("Keep", !working, () => setNote(key, undefined))}
        {choice("Needs work", working, () => setNote(key, notes[key] ?? ""), "Ask the AI to rework it, with your note")}
        {item.status === "changed"
          ? choice("Use original", false, () => void chooseOriginal(item), "Put the original question back in this spot")
          : null}
        {item.status === "new" ? choice("Leave out", false, () => void chooseLeaveOut(item), "Drop this question from the version") : null}
      </div>
    );
  }

  const heading =
    mode === "rework" && rework
      ? `Ask AI to fix ${rework.requests.length} ${plural(rework.requests.length)}`
      : mode === "review" && preview
        ? `Review version ${preview.version}`
        : "Paste the AI’s reply";

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal version-import-modal ai-wizard-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import a new version"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>{heading}</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="settings-body">
          <AiSteps current={mode === "paste" ? "paste" : "review"} />
          {mode === "paste" ? (
            <>
              <p className="ai-prompt-intro">
                Paste the JSON the AI returned for <strong>{testLabel}</strong>. Nexam matches each question to the one it
                replaces, shows you what changed, and creates the new version as a separate test. This test stays as it is.
              </p>
              <textarea
                className="ai-prompt-textarea version-import-paste"
                rows={12}
                value={text}
                placeholder={'{"test": {...}, "questions": [...]}'}
                spellCheck={false}
                onChange={(event) => onTextChange(event.target.value)}
              />
              <label className="ai-prompt-option">
                <input
                  type="checkbox"
                  checked={keepMissing}
                  onChange={(event) => {
                    setKeepMissing(event.target.checked);
                    setReviewedText(null);
                  }}
                />
                Keep any question the AI left out (from this version, where it was)
              </label>
            </>
          ) : mode === "rework" && rework ? (
            <>
              <p className="ai-prompt-intro">
                Copy the prompt and the {plural(rework.requests.length)} into the same AI chat, then paste its reply below.
                Only {rework.requests.length === 1 ? "this question is" : "these questions are"} replaced; the rest of your
                review stays as it is.
              </p>
              <section className="ai-prompt-section">
                <div className="ai-prompt-section-header">
                  <h3>Prompt</h3>
                  <div className="ai-prompt-section-actions">
                    <button type="button" onClick={() => copy("prompt", reworkPrompt)}>
                      {copied === "prompt" ? "Copied" : "Copy"}
                    </button>
                    <button type="button" onClick={() => copy("both", `${reworkPrompt}\n\n${reworkQuestions}`)}>
                      {copied === "both" ? "Copied Both" : "Copy Prompt + Questions"}
                    </button>
                  </div>
                </div>
                <textarea className="ai-prompt-textarea" value={reworkPrompt} readOnly rows={7} />
              </section>
              <section className="ai-prompt-section">
                <div className="ai-prompt-section-header">
                  <h3>Questions to rework</h3>
                  <button type="button" onClick={() => copy("questions", reworkQuestions)}>
                    {copied === "questions" ? "Copied" : "Copy"}
                  </button>
                </div>
                <textarea className="ai-prompt-textarea" value={reworkQuestions} readOnly rows={6} />
              </section>
              <section className="ai-prompt-section">
                <h3>The AI&rsquo;s reply</h3>
                <textarea
                  className="ai-prompt-textarea version-import-paste"
                  rows={8}
                  value={reworkReply}
                  placeholder={'{"questions": [...]}'}
                  spellCheck={false}
                  onChange={(event) => setReworkReply(event.target.value)}
                />
              </section>
            </>
          ) : preview ? (
            <>
              <p className="version-summary">
                <strong>
                  {preview.title}, version {preview.version}
                </strong>
                : {questions.length} questions · {count("changed")} changed · {count("kept")} kept · {count("new")} new
                {count("restored") > 0 ? ` · ${count("restored")} kept because the AI left them out` : ""}
                {needsWork > 0 ? ` · ${needsWork} need${needsWork === 1 ? "s" : ""} work` : ""}
              </p>
              {preview.errors.length > 0 ? (
                <div className="version-errors" role="alert">
                  <strong>Can&rsquo;t create this version yet:</strong>
                  <ul>
                    {preview.errors.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.warnings.length > 0 ? (
                <ul className="version-warnings">
                  {preview.warnings.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
              <ol className="version-items">
                {preview.items.map((item) => {
                  if (item.kind === "section") {
                    return (
                      <li key={item.position} className="version-section">
                        {item.title}
                      </li>
                    );
                  }
                  const key = itemKey(item);
                  const working = notes[key] !== undefined;
                  return (
                    <li key={item.position} className={`version-item status-${item.status} ${working ? "needs-work" : ""}`}>
                      <div className="version-item-header">
                        <span className="version-badge">{STATUS_LABEL[item.status]}</span>
                        {reworked.includes(key) ? <span className="version-badge version-badge-reworked">Reworked</span> : null}
                        <span className="version-ids">
                          {item.status === "changed" ? `${item.original_id} → ${item.question?.id}` : item.question?.id}
                        </span>
                      </div>
                      {item.status === "changed" && item.original && item.question ? (
                        <div className="version-compare">
                          <div>
                            <h4>Before</h4>
                            <QuestionSummary question={item.original} />
                          </div>
                          <div>
                            <h4>This version</h4>
                            <QuestionSummary question={item.question} />
                          </div>
                        </div>
                      ) : item.status === "new" && item.question ? (
                        <QuestionSummary question={item.question} />
                      ) : item.question ? (
                        <QuestionValuesContext.Provider value={item.question.variables ?? null}>
                          <MathTextPreview text={item.question.prompt} className="version-kept-prompt" />
                        </QuestionValuesContext.Provider>
                      ) : null}
                      {item.issues.length > 0 ? (
                        <ul className="version-issues">
                          {item.issues.map((issue, index) => (
                            <li key={index}>{issue.message}</li>
                          ))}
                        </ul>
                      ) : null}
                      {decisions(item)}
                      {working ? (
                        <label className="version-work-note">
                          What should change?
                          <textarea
                            rows={2}
                            value={notes[key]}
                            placeholder="e.g. The wrong answers are too easy to rule out; make them common mistakes."
                            onChange={(event) => setNote(key, event.target.value)}
                          />
                        </label>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </>
          ) : null}
          {error ? <p className="version-error">{error}</p> : null}
        </div>

        <div className="bank-properties-actions">
          {mode === "rework" ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setRework(null);
                  setError(null);
                  setMode("review");
                }}
                disabled={busy}
              >
                Back to review
              </button>
              <button type="button" className="primary" onClick={() => void applyRework()} disabled={busy || reworkReply.trim() === ""}>
                {busy ? "Reading…" : "Next"}
              </button>
            </>
          ) : mode === "review" && preview ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMode("paste");
                }}
                disabled={busy}
              >
                Back
              </button>
              {needsWork > 0 ? (
                <button type="button" className="primary" onClick={startRework} disabled={busy}>
                  Ask AI to fix {needsWork} {plural(needsWork)} →
                </button>
              ) : (
                <button type="button" className="primary" onClick={() => void create()} disabled={busy || preview.errors.length > 0}>
                  {busy ? "Working…" : `Create version ${preview.version}`}
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" onClick={onBack ?? onClose}>
                {onBack ? "Back" : "Cancel"}
              </button>
              <button type="button" className="primary" onClick={() => void review()} disabled={busy || text.trim() === ""}>
                {busy ? "Reading…" : "Next"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
