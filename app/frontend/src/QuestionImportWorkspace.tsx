import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";

import {
  createStandardPlaceholders,
  deleteQuestionImport,
  deleteQuestionImportRow,
  getCurrentBank,
  listQuestionImports,
  promoteQuestionImport,
  stageQuestionImport,
  updateQuestionImportRow,
} from "./api";
import { MathTextPreview } from "./MathPreview";
import type { QuestionImportRowModel, QuestionImportStageModel } from "./types";

type PendingFilter = "all" | "pending" | "needs_attention" | "selected" | "adopted";
type ImportFormat = "json" | "csv";
type PostAdoptAction = "none" | "new_test" | "current_test";

// Shared with App.tsx/GradebookApp.tsx's own copies of the same name/value --
// this workspace runs in its own pop-out window (see openPaneWindow in
// desktop.ts), so it talks back to the main window over this channel instead
// of through props: it has no parent to call back into directly.
const PANE_SYNC_CHANNEL = "nexam-pane-sync";

const QUESTION_IMPORT_JSON_TEMPLATE = JSON.stringify(
  [
    {
      id: "q_mc_example_001",
      type: "multiple_choice",
      topic: "Algebra",
      difficulty: 1,
      prompt: "Which expression is equivalent to $2(x + 3)$?",
      tags: ["algebra", "expressions"],
      standards: [{ standard_id: "STANDARD-ID-1" }],
      estimated_time_sec: 45,
      points: 1,
      status: "draft",
      answer: {
        choices: ["2x + 3", "2x + 6", "x + 6", "2x - 6"],
        correct_choice_index: 1,
      },
      explanation: "Distribute 2 to both terms inside the parentheses.",
      rubric: [],
      assets: [],
    },
  ],
  null,
  2,
);

const QUESTION_IMPORT_CSV_TEMPLATE = [
  "id,type,topic,difficulty,prompt,tags,standards,estimated_time_sec,points,status,teacher_notes,explanation,sample_solution,answer_json,rubric_json,assets_json",
  'q_mc_example_001,multiple_choice,Algebra,1,"Which expression is equivalent to $2(x + 3)$?","algebra;expressions",STANDARD-ID-1,45,1,draft,,"Distribute 2 to both terms.",,"{""choices"":[""2x + 3"",""2x + 6"",""x + 6"",""2x - 6""],""correct_choice_index"":1}",[],[]',
].join("\n");

interface TestContext {
  hasCurrentTest: boolean;
  label: string | null;
}

interface PendingQuestion {
  key: string;
  stage: QuestionImportStageModel;
  row: QuestionImportRowModel;
}

function countPending(stages: QuestionImportStageModel[], status: QuestionImportRowModel["status"]) {
  return stages.reduce((total, stage) => total + stage.rows.filter((row) => row.status === status).length, 0);
}

function makePendingKey(importId: string, rowId: string) {
  return `${importId}::${rowId}`;
}

function parsePendingKey(key: string) {
  const [importId, rowId] = key.split("::");
  return { importId, rowId };
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getString(question: Record<string, unknown>, key: string) {
  const value = question[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function getNumberText(question: Record<string, unknown>, key: string) {
  const value = question[key];
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

function parseListText(value: string) {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalNumber(value: string) {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : "";
}

function formatTags(question: Record<string, unknown>) {
  return Array.isArray(question.tags) ? question.tags.map(String).join(", ") : "";
}

function formatStandards(question: Record<string, unknown>) {
  const standards = question.standards;
  if (!Array.isArray(standards)) return "";
  return standards
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "standard_id" in item) {
        return String((item as { standard_id?: unknown }).standard_id ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join(", ");
}

function updateQuestionField(
  question: Record<string, unknown>,
  key: string,
  value: unknown,
) {
  const next = { ...question };
  if (value === "" || value === null) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

function getPromptPreview(question: Record<string, unknown>) {
  const prompt = getString(question, "prompt").trim();
  return prompt || "No prompt yet.";
}

// With "Use automatic Nexam IDs" (the default), adoption never looks at the
// imported/duplicate id at all -- it always assigns a fresh one (see
// _resolve_promoted_question_id in service.py). These two issue codes are
// the only ones that flag id conflicts, so they're pure noise in that mode:
// nothing needs fixing, but every row that happened to arrive with a
// colliding id still got flagged "Fix" and invited a click that did nothing.
const ID_CONFLICT_ISSUE_CODES = new Set(["duplicate_existing_id", "duplicate_import_id"]);

function visibleIssues(row: QuestionImportRowModel, idPolicy: "auto" | "keep_imported") {
  return idPolicy === "auto"
    ? row.issues.filter((issue) => !ID_CONFLICT_ISSUE_CODES.has(issue.code))
    : row.issues;
}

function getIssueTone(row: QuestionImportRowModel, idPolicy: "auto" | "keep_imported") {
  if (row.status === "promoted") return "adopted";
  const issues = visibleIssues(row, idPolicy);
  if (issues.some((issue) => issue.severity !== "warning")) return "invalid";
  if (issues.length > 0) return "warning";
  return "ready";
}

function getUnknownStandardIds(row: QuestionImportRowModel) {
  return row.issues
    .filter((issue) => issue.code === "unknown_standard")
    .map((issue) => {
      const match = issue.message.match(/Unknown standard reference: (.+)$/);
      return match?.[1]?.trim() ?? "";
    })
    .filter(Boolean);
}

/** A quick client-side preview of how many questions a paste looks like,
 *  before the user even clicks Import Paste -- the backend's own parser
 *  (service.py's _parse_json_question_import) is the real source of truth,
 *  this is just an early hint. CSV is a rough line count, not a real parse
 *  (a quoted field containing a newline would throw it off). */
function describePasteCount(text: string, format: ImportFormat): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (format === "json") {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      let count = 1;
      if (Array.isArray(parsed)) {
        count = parsed.length;
      } else if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record.questions)) count = record.questions.length;
        else if (Array.isArray(record.items)) count = record.items.length;
      }
      return `Looks like ${count} question${count === 1 ? "" : "s"}.`;
    } catch {
      return "Doesn't parse as JSON yet.";
    }
  }

  const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
  const count = Math.max(lines.length - 1, 0);
  return `Looks like about ${count} question${count === 1 ? "" : "s"} (header row + one per line).`;
}

function downloadTemplateFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function QuestionImportWorkspace() {
  const [hasBank, setHasBank] = useState(false);
  const [testContext, setTestContext] = useState<TestContext>({
    hasCurrentTest: false,
    label: null,
  });
  const [imports, setImports] = useState<QuestionImportStageModel[]>([]);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [pasteFormat, setPasteFormat] = useState<ImportFormat>("json");
  const [dragActive, setDragActive] = useState(false);
  // Collapses the paste/upload card once there's something to vet, so the
  // review list + editor (the actual task at that point) get the space
  // instead. Re-expand manually to import more.
  const [intakeCollapsed, setIntakeCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [selectedPendingKey, setSelectedPendingKey] = useState<string | null>(null);
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>("pending");
  const [pendingSearch, setPendingSearch] = useState("");
  const [idPolicy, setIdPolicy] = useState<"auto" | "keep_imported">("auto");
  const [draftQuestion, setDraftQuestion] = useState<Record<string, unknown> | null>(null);
  const [answerJson, setAnswerJson] = useState("");
  const [rubricJson, setRubricJson] = useState("");
  const [assetsJson, setAssetsJson] = useState("");
  const [jsonFieldError, setJsonFieldError] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // This workspace is only ever a standalone pop-out window now (see
  // openPaneWindow("import", ...) in App.tsx) -- it has no parent passing
  // down whether a bank is open, so it asks the shared backend directly,
  // the same way GradebookApp independently discovers its own document.
  useEffect(() => {
    let cancelled = false;
    void getCurrentBank().then(
      () => {
        if (!cancelled) setHasBank(true);
      },
      () => {
        if (!cancelled) setHasBank(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Receives a pasted question batch handed off from the single-question
   *  editor's Text View (see detectQuestionBatch/handleSendPasteToImport in
   *  App.tsx) and stages it immediately -- the teacher lands on a window
   *  that's already showing review rows, not an empty paste box they have
   *  to resubmit. `stageFile` is declared further down; function
   *  declarations hoist, so this is safe to call from the effects below. */
  function stageHandoffText(text: string, format: ImportFormat) {
    setPasteText(text);
    setPasteFormat(format);
    const filename = format === "json" ? "pasted-questions.json" : "pasted-questions.csv";
    const type = format === "json" ? "application/json" : "text/csv";
    void stageFile(new File([text], filename, { type }));
  }

  // A freshly-created window gets the handoff text on its own URL. Staging
  // is a one-shot side effect (not a subscription), so React.StrictMode's
  // deliberate mount -> cleanup -> mount-again in development would otherwise
  // run this twice and stage the same pasted batch as two separate imports --
  // each batch assigning its own "unique" auto ids against the same
  // not-yet-promoted on-disk snapshot, so neither copy looks like a
  // duplicate to the conflict check, and "Adopt All Ready" would happily
  // promote both. The ref makes the second StrictMode pass a no-op.
  const handledUrlPasteRef = useRef(false);
  useEffect(() => {
    if (handledUrlPasteRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const text = params.get("pasteText");
    if (!text) return;
    handledUrlPasteRef.current = true;
    stageHandoffText(text, (params.get("pasteFormat") as ImportFormat) ?? "json");
    // Acting once on load is the point; re-running would fight the teacher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A reused/focused existing window instead gets it over the broadcast
  // channel (openPaneWindow can't tell "focus me" from "focus me AND here's
  // a new paste" via the URL alone, since reusing a window never reloads
  // it -- same reasoning as openGradebookWindow's intent broadcast). This
  // channel doubles as how the "Adopt + Current Test" button learns whether
  // the main window has a test selected, since this workspace has no parent
  // passing that down directly anymore.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(PANE_SYNC_CHANNEL);
    } catch {
      return;
    }
    channel.onmessage = (event) => {
      if (event.data?.type === "question-import-context") {
        setTestContext({
          hasCurrentTest: !!event.data.hasCurrentTest,
          label: event.data.currentTestLabel ?? null,
        });
      } else if (event.data?.type === "question-import-paste") {
        stageHandoffText(
          event.data.pasteText ?? "",
          (event.data.pasteFormat as ImportFormat) ?? "json",
        );
      }
    };
    channel.postMessage({ type: "question-import-context-request" });
    return () => {
      channel.onmessage = null;
      channel.close();
    };
  }, []);

  const pendingQuestions = useMemo<PendingQuestion[]>(
    () =>
      imports.flatMap((stage) =>
        stage.rows.map((row) => ({
          key: makePendingKey(stage.id, row.row_id),
          stage,
          row,
        })),
      ),
    [imports],
  );

  const selectedPending =
    pendingQuestions.find((item) => item.key === selectedPendingKey) ?? pendingQuestions[0] ?? null;

  const visiblePendingQuestions = pendingQuestions.filter((item) => {
    const { row } = item;
    if (pendingFilter === "pending" && row.status === "promoted") return false;
    if (pendingFilter === "needs_attention" && visibleIssues(row, idPolicy).length === 0) return false;
    if (pendingFilter === "selected" && !row.selected) return false;
    if (pendingFilter === "adopted" && row.status !== "promoted") return false;
    const needle = pendingSearch.trim().toLowerCase();
    if (!needle) return true;
    return [
      row.row_id,
      row.proposed_id ?? "",
      row.imported_id ?? "",
      row.promoted_question_id ?? "",
      getString(row.question, "type"),
      getString(row.question, "topic"),
      getString(row.question, "prompt"),
      formatStandards(row.question),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

  const selectedReadyPending = pendingQuestions.filter(
    (item) => item.row.status === "valid" && item.row.selected,
  );
  const allReadyPending = pendingQuestions.filter((item) => item.row.status === "valid");
  const unknownStandardIds = Array.from(
    new Set(pendingQuestions.flatMap((item) => getUnknownStandardIds(item.row))),
  );

  async function refreshImports() {
    if (!hasBank) return;
    setBusy(true);
    try {
      const response = await listQuestionImports();
      setImports(response.items);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refreshImports();
  }, [hasBank]);

  useEffect(() => {
    if (!selectedPending) {
      setSelectedPendingKey(null);
      setDraftQuestion(null);
      return;
    }

    if (!selectedPendingKey || !pendingQuestions.some((item) => item.key === selectedPendingKey)) {
      setSelectedPendingKey(selectedPending.key);
    }
  }, [pendingQuestions, selectedPending, selectedPendingKey]);

  useEffect(() => {
    if (!selectedPending) return;
    const question = selectedPending.row.question;
    setDraftQuestion(question);
    setAnswerJson(JSON.stringify(question.answer ?? {}, null, 2));
    setRubricJson(JSON.stringify(question.rubric ?? [], null, 2));
    setAssetsJson(JSON.stringify(question.assets ?? [], null, 2));
    setJsonFieldError("");
    setDraftDirty(false);
  }, [selectedPending?.key]);

  useEffect(() => {
    if (!draftDirty || !selectedPending || !draftQuestion || selectedPending.row.status === "promoted") {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveDraftQuestion(draftQuestion, undefined, "Saved pending question edits.");
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draftDirty, draftQuestion, selectedPending?.key]);

  /** Tells the main window's bank/question state to catch up -- this window
   *  has no parent to call back into directly, so it broadcasts instead of
   *  invoking a prop (mirrors GradebookApp's status broadcasts). */
  function notifyMainWindow(
    message: string,
    promotedQuestionIds: string[] = [],
    postAction: PostAdoptAction = "none",
  ) {
    try {
      const channel = new BroadcastChannel(PANE_SYNC_CHANNEL);
      channel.postMessage({
        type: "question-import-adopted",
        message,
        promotedQuestionIds,
        postAction,
      });
      channel.close();
    } catch {
      // Best effort only.
    }
  }

  async function stageFile(file: File) {
    setBusy(true);
    try {
      const stage = await stageQuestionImport(file);
      setImports((current) => [stage, ...current.filter((item) => item.id !== stage.id)]);
      setSelectedPendingKey(stage.rows[0] ? makePendingKey(stage.id, stage.rows[0].row_id) : null);
      setPendingFilter("pending");
      setImportFile(null);
      setPasteText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      const validCount = countPending([stage], "valid");
      const invalidCount = countPending([stage], "invalid");
      const message = `Imported ${stage.rows.length} pending questions from ${stage.source_filename}. ${validCount} ready, ${invalidCount} need attention.`;
      setStatusMessage(message);
      setErrorMessage("");
      notifyMainWindow(message);
      setIntakeCollapsed(true);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStageFile() {
    if (!importFile) {
      setErrorMessage("Choose a file first.");
      return;
    }
    await stageFile(importFile);
  }

  async function handleStagePaste() {
    const content = pasteText.trim();
    if (!content) {
      setErrorMessage("Paste JSON or CSV question content first.");
      return;
    }
    const filename = pasteFormat === "json" ? "pasted-questions.json" : "pasted-questions.csv";
    const type = pasteFormat === "json" ? "application/json" : "text/csv";
    await stageFile(new File([content], filename, { type }));
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    // Children re-fire dragenter/dragleave as the pointer crosses them --
    // only clear the highlight once the pointer actually leaves the section.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      void stageFile(file);
    }
  }

  async function saveDraftQuestion(
    question: Record<string, unknown>,
    selected: boolean | undefined,
    message: string,
  ) {
    if (!selectedPending) return;
    const { importId, rowId } = parsePendingKey(selectedPending.key);
    try {
      const updatedStage = await updateQuestionImportRow({
        importId,
        rowId,
        question,
        selected,
      });
      setImports((current) =>
        current.map((stage) => (stage.id === updatedStage.id ? updatedStage : stage)),
      );
      setDraftDirty(false);
      setStatusMessage(message);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  function updateDraft(patch: Record<string, unknown>) {
    setDraftQuestion((current) => {
      const next = { ...(current ?? {}), ...patch };
      setDraftDirty(true);
      return next;
    });
  }

  function updateDraftField(key: string, value: unknown) {
    setDraftQuestion((current) => {
      const next = updateQuestionField(current ?? {}, key, value);
      setDraftDirty(true);
      return next;
    });
  }

  function updateJsonField(field: "answer" | "rubric" | "assets", value: string) {
    if (field === "answer") setAnswerJson(value);
    if (field === "rubric") setRubricJson(value);
    if (field === "assets") setAssetsJson(value);
    try {
      const parsed = JSON.parse(value);
      updateDraftField(field, parsed);
      setJsonFieldError("");
    } catch (error) {
      setJsonFieldError((error as Error).message);
    }
  }

  async function togglePendingSelected(item: PendingQuestion) {
    if (item.row.status === "promoted") return;
    const { importId, rowId } = parsePendingKey(item.key);
    setBusy(true);
    try {
      const updatedStage = await updateQuestionImportRow({
        importId,
        rowId,
        question: item.row.question,
        selected: !item.row.selected,
      });
      setImports((current) =>
        current.map((stage) => (stage.id === updatedStage.id ? updatedStage : stage)),
      );
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function adoptPendingQuestions(items: PendingQuestion[], postAction: PostAdoptAction = "none") {
    const readyItems = items.filter((item) => item.row.status === "valid");
    if (readyItems.length === 0) {
      setErrorMessage("Choose at least one ready pending question.");
      return;
    }

    const promotedIds: string[] = [];
    setBusy(true);
    try {
      const grouped = new Map<string, string[]>();
      for (const item of readyItems) {
        const { importId, rowId } = parsePendingKey(item.key);
        grouped.set(importId, [...(grouped.get(importId) ?? []), rowId]);
      }

      for (const [importId, rowIds] of grouped) {
        const response = await promoteQuestionImport({
          importId,
          row_ids: rowIds,
          id_policy: idPolicy,
        });
        promotedIds.push(...response.promoted_question_ids);
        setImports((current) =>
          current.map((stage) => (stage.id === response.stage.id ? response.stage : stage)),
        );
      }

      const message = `Adopted ${promotedIds.length} pending questions into the bank.`;
      setStatusMessage(message);
      setErrorMessage("");
      notifyMainWindow(message, promotedIds, postAction);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function useAutoIdForSelected() {
    if (!selectedPending || !draftQuestion) return;
    const next = { ...draftQuestion };
    delete next.id;
    setDraftQuestion(next);
    await saveDraftQuestion(next, selectedPending.row.selected, "Using an automatic Nexam id.");
  }

  /** A bad paste or an unwanted row used to just sit in the pending list
   *  forever -- there was no way to remove it. */
  async function discardPendingRow(item: PendingQuestion) {
    const { importId, rowId } = parsePendingKey(item.key);
    setBusy(true);
    try {
      const updatedStage = await deleteQuestionImportRow({ importId, rowId });
      setImports((current) =>
        current.map((stage) => (stage.id === updatedStage.id ? updatedStage : stage)),
      );
      setStatusMessage("Discarded the pending question.");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function discardImportBatch(stage: QuestionImportStageModel) {
    if (
      !window.confirm(
        `Discard all ${stage.rows.length} question(s) from ${stage.source_filename}? This can't be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await deleteQuestionImport(stage.id);
      setImports((current) => current.filter((item) => item.id !== stage.id));
      setStatusMessage(`Discarded the ${stage.source_filename} import.`);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addMissingStandards(ids: string[]) {
    const standardIds = Array.from(new Set(ids)).filter(Boolean);
    if (standardIds.length === 0) return;
    setBusy(true);
    try {
      await createStandardPlaceholders(standardIds);
      const stagesToRefresh = new Set(
        pendingQuestions
          .filter((item) => getUnknownStandardIds(item.row).some((id) => standardIds.includes(id)))
          .map((item) => item.stage.id),
      );
      for (const stageId of stagesToRefresh) {
        const stage = imports.find((item) => item.id === stageId);
        if (!stage) continue;
        for (const row of stage.rows) {
          if (row.status === "promoted") continue;
          const updatedStage = await updateQuestionImportRow({
            importId: stage.id,
            rowId: row.row_id,
            question: row.question,
            selected: row.selected,
          });
          setImports((current) =>
            current.map((item) => (item.id === updatedStage.id ? updatedStage : item)),
          );
        }
      }
      const message = `Added ${standardIds.length} placeholder standards for pending questions.`;
      setStatusMessage(message);
      setErrorMessage("");
      notifyMainWindow(message);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selectedUnknownStandardIds = selectedPending ? getUnknownStandardIds(selectedPending.row) : [];
  const selectedTone = selectedPending ? getIssueTone(selectedPending.row, idPolicy) : "ready";

  return (
    <section
      className={`question-import-workspace pending-import-workspace ${dragActive ? "drag-active" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="question-import-header">
        <div>
          <h2>Import Pending Questions</h2>
          <div className="question-import-summary">
            <span className="status-pill">{pendingQuestions.length} pending/adopted</span>
            <span className="status-pill saved">{countPending(imports, "valid")} ready</span>
            <span className="status-pill error">{countPending(imports, "invalid")} need fixes</span>
            <span className="status-pill">{countPending(imports, "promoted")} adopted</span>
          </div>
          <p className="question-import-close-hint">
            Close this window when finished -- the question editor keeps working separately.
          </p>
        </div>
        <div className="question-import-actions">
          <button type="button" onClick={() => void refreshImports()} disabled={busy || !hasBank}>
            Refresh
          </button>
        </div>
      </header>

      {intakeCollapsed ? (
        <button
          type="button"
          className="pending-import-intake-collapsed"
          onClick={() => setIntakeCollapsed(false)}
        >
          + Import more questions
        </button>
      ) : (
      <div className="question-import-stage-panel pending-import-intake">
        <div className="pending-import-intake-header">
          <h3>Paste Questions</h3>
          {pendingQuestions.length > 0 ? (
            <button type="button" onClick={() => setIntakeCollapsed(true)}>
              Minimize
            </button>
          ) : null}
        </div>
        <label className="pending-paste-box">
          <textarea
            aria-label="Paste Questions"
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder={
              pasteFormat === "json"
                ? "Paste a JSON array of questions here, e.g. from an AI chat response."
                : "Paste CSV question rows here, including the header row."
            }
            disabled={busy || !hasBank}
          />
          {pasteText.trim() ? (
            <span className="pending-paste-count">{describePasteCount(pasteText, pasteFormat)}</span>
          ) : null}
        </label>
        <div className="pending-import-controls">
          <label>
            Paste Format
            <select
              value={pasteFormat}
              onChange={(event) => setPasteFormat(event.target.value as ImportFormat)}
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <label>
            File or Drop
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.csv,application/json,text/csv"
              disabled={busy || !hasBank}
              onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button type="button" onClick={() => void handleStagePaste()} disabled={busy || !hasBank}>
            Import Paste
          </button>
          <button type="button" onClick={() => void handleStageFile()} disabled={busy || !hasBank}>
            {importFile ? `Import ${importFile.name}` : "Import File"}
          </button>
          <div className="question-import-template-actions">
            <button
              type="button"
              onClick={() =>
                downloadTemplateFile(
                  "nexam-question-import-template.json",
                  `${QUESTION_IMPORT_JSON_TEMPLATE}\n`,
                  "application/json",
                )
              }
            >
              JSON Template
            </button>
            <button
              type="button"
              onClick={() =>
                downloadTemplateFile(
                  "nexam-question-import-template.csv",
                  `${QUESTION_IMPORT_CSV_TEMPLATE}\n`,
                  "text/csv",
                )
              }
            >
              CSV Template
            </button>
          </div>
        </div>
      </div>
      )}

      {statusMessage ? <div className="question-import-status">{statusMessage}</div> : null}
      {errorMessage ? <div className="json-error-banner">{errorMessage}</div> : null}

      <div className="pending-import-actions">
        <label>
          ID Handling
          <select
            value={idPolicy}
            onChange={(event) => setIdPolicy(event.target.value as "auto" | "keep_imported")}
            title="Applies to every Adopt action below."
          >
            <option value="auto">Use automatic Nexam IDs</option>
            <option value="keep_imported">Keep imported IDs</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(selectedPending ? [selectedPending] : [])}
          disabled={busy || !selectedPending || selectedPending.row.status !== "valid"}
          title="Adopts only the question open in the editor panel on the right."
        >
          Adopt This
        </button>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(selectedReadyPending)}
          disabled={busy || selectedReadyPending.length === 0}
          title="Adopts every ready question with its checkbox marked Included, across all pastes/files staged so far."
        >
          Adopt Selected
        </button>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(allReadyPending)}
          disabled={busy || allReadyPending.length === 0}
          title="Adopts every ready question, whether or not it's marked Included -- across all pastes/files staged so far."
        >
          Adopt All Ready
        </button>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(selectedReadyPending, "new_test")}
          disabled={busy || selectedReadyPending.length === 0}
          title="Adopts the Included questions, then creates a brand-new test containing them."
        >
          Adopt + New Test
        </button>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(selectedReadyPending, "current_test")}
          disabled={busy || selectedReadyPending.length === 0 || !testContext.hasCurrentTest}
          title="Adopts the Included questions, then adds them to the test currently selected in the main window."
        >
          Adopt + {testContext.label ? testContext.label : "Current Test"}
        </button>
        {unknownStandardIds.length > 0 ? (
          <button type="button" onClick={() => void addMissingStandards(unknownStandardIds)} disabled={busy}>
            Add Missing Standards
          </button>
        ) : null}
      </div>

      <div className="question-import-review pending-import-review">
        <section className="question-import-table-panel pending-card-panel">
          <div className="question-import-review-header">
            <div>
              <h3>Pending Questions</h3>
              <span>{visiblePendingQuestions.length} shown</span>
            </div>
            <div className="question-import-filter-row">
              <select
                value={pendingFilter}
                onChange={(event) => setPendingFilter(event.target.value as PendingFilter)}
              >
                <option value="pending">Pending</option>
                <option value="all">All</option>
                <option value="needs_attention">Needs attention</option>
                <option value="selected">Selected</option>
                <option value="adopted">Adopted</option>
              </select>
              <input
                value={pendingSearch}
                onChange={(event) => setPendingSearch(event.target.value)}
                placeholder="Search pending questions"
              />
            </div>
          </div>

          <div className="pending-question-card-list">
            {visiblePendingQuestions.map((item) => {
              const tone = getIssueTone(item.row, idPolicy);
              const visibleIssueCount = visibleIssues(item.row, idPolicy).length;
              const title = getString(item.row.question, "topic") || "Missing topic";
              return (
                <article
                  key={item.key}
                  className={`pending-question-card ${tone} ${
                    selectedPending?.key === item.key ? "selected" : ""
                  }`}
                  onClick={() => setSelectedPendingKey(item.key)}
                >
                  <div className="pending-question-card-top">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void togglePendingSelected(item);
                      }}
                      disabled={busy || item.row.status !== "valid"}
                    >
                      {item.row.selected ? "Included" : "Include"}
                    </button>
                    <span>{item.row.status === "promoted" ? "Adopted" : tone === "ready" ? "Ready" : "Fix"}</span>
                    <button
                      type="button"
                      className="pending-question-card-discard"
                      onClick={(event) => {
                        event.stopPropagation();
                        void discardPendingRow(item);
                      }}
                      disabled={busy || item.row.status === "promoted"}
                      title="Discard this pending question"
                      aria-label="Discard this pending question"
                    >
                      &times;
                    </button>
                  </div>
                  <strong>{item.row.proposed_id ?? item.row.imported_id ?? item.row.row_id}</strong>
                  <span>{String(item.row.question.type ?? "unknown")} / {title}</span>
                  <p>{getPromptPreview(item.row.question)}</p>
                  {visibleIssueCount > 0 ? (
                    <span className="pending-issue-count">{visibleIssueCount} issue(s)</span>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>

        <section className={`question-import-detail-panel pending-editor-panel ${selectedTone}`}>
          {selectedPending && draftQuestion ? (
            <>
              <div className="question-import-review-header">
                <div>
                  <h3>{selectedPending.row.proposed_id ?? selectedPending.row.imported_id ?? "Pending Question"}</h3>
                  <span>
                    {selectedPending.row.status} from {selectedPending.stage.source_filename} / {formatDate(selectedPending.stage.created_at)}
                  </span>
                </div>
                <div className="question-import-actions">
                  <button
                    type="button"
                    onClick={() => void useAutoIdForSelected()}
                    disabled={busy || selectedPending.row.status === "promoted"}
                  >
                    Auto Fix ID
                  </button>
                  {selectedUnknownStandardIds.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => void addMissingStandards(selectedUnknownStandardIds)}
                      disabled={busy}
                    >
                      Add Standard
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void discardPendingRow(selectedPending)}
                    disabled={busy || selectedPending.row.status === "promoted"}
                    title="Removes just this one pending question."
                  >
                    Discard This
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void discardImportBatch(selectedPending.stage)}
                    disabled={busy}
                    title={`Removes all ${selectedPending.stage.rows.length} question(s) pasted/uploaded together as ${selectedPending.stage.source_filename}.`}
                  >
                    Discard Import
                  </button>
                </div>
              </div>

              {visibleIssues(selectedPending.row, idPolicy).length > 0 ? (
                <div className="question-import-issues">
                  {visibleIssues(selectedPending.row, idPolicy).map((issue, index) => (
                    <div
                      key={`${issue.code}-${index}`}
                      className={issue.severity === "warning" ? "warning" : ""}
                    >
                      <strong>{issue.severity === "warning" ? "Check" : "Fix"}: {issue.code}</strong>
                      <span>{issue.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="pending-question-editor-grid">
                <label>
                  Imported ID
                  <input
                    value={getString(draftQuestion, "id")}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateDraftField("id", event.target.value)}
                  />
                </label>
                <label>
                  Type
                  <select
                    value={getString(draftQuestion, "type")}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateDraftField("type", event.target.value)}
                  >
                    <option value="">Choose type</option>
                    <option value="multiple_choice">Multiple Choice</option>
                    <option value="numeric_response">Numeric Response</option>
                    <option value="short_answer">Short Answer</option>
                    <option value="free_response">Free Response</option>
                  </select>
                </label>
                <label>
                  Topic
                  <input
                    value={getString(draftQuestion, "topic")}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateDraftField("topic", event.target.value)}
                  />
                </label>
                <label className="metadata-span-full">
                  Subtopic
                  <input
                    value={getString(draftQuestion, "subtopic")}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateDraftField("subtopic", event.target.value)}
                  />
                </label>
              </div>

              <div className="pending-question-editor-numbers">
                <label>
                  Difficulty
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={getNumberText(draftQuestion, "difficulty")}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) =>
                      updateDraftField("difficulty", parseOptionalNumber(event.target.value))
                    }
                  />
                </label>
                <label>
                  Points
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={getNumberText(draftQuestion, "points")}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) =>
                      updateDraftField("points", parseOptionalNumber(event.target.value))
                    }
                  />
                </label>
                <label>
                  Time (sec)
                  <input
                    type="number"
                    min={0}
                    value={getNumberText(draftQuestion, "estimated_time_sec")}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) =>
                      updateDraftField("estimated_time_sec", parseOptionalNumber(event.target.value))
                    }
                  />
                </label>
              </div>

              <div className="pending-question-editor-grid">
                <label className="metadata-span-full">
                  Tags
                  <input
                    value={formatTags(draftQuestion)}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateDraftField("tags", parseListText(event.target.value))}
                  />
                </label>
                <label className="metadata-span-full">
                  Standards
                  <input
                    value={formatStandards(draftQuestion)}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) =>
                      updateDraftField(
                        "standards",
                        parseListText(event.target.value).map((standardId) => ({
                          standard_id: standardId,
                        })),
                      )
                    }
                  />
                </label>
                <label className="metadata-span-full pending-prompt-editor">
                  Prompt
                  <textarea
                    value={getString(draftQuestion, "prompt")}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateDraftField("prompt", event.target.value)}
                  />
                </label>
              </div>

              <div className="pending-render-preview">
                <MathTextPreview text={getString(draftQuestion, "prompt")} />
              </div>

              <details className="test-template-editor">
                <summary>Answer, Rubric, Assets</summary>
                {jsonFieldError ? <div className="json-error-banner">{jsonFieldError}</div> : null}
                <label>
                  Answer JSON
                  <textarea
                    value={answerJson}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateJsonField("answer", event.target.value)}
                  />
                </label>
                <label>
                  Explanation
                  <textarea
                    value={getString(draftQuestion, "explanation")}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateDraftField("explanation", event.target.value)}
                  />
                </label>
                <label>
                  Rubric JSON
                  <textarea
                    value={rubricJson}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateJsonField("rubric", event.target.value)}
                  />
                </label>
                <label>
                  Assets JSON
                  <textarea
                    value={assetsJson}
                    disabled={selectedPending.row.status === "promoted"}
                    onChange={(event) => updateJsonField("assets", event.target.value)}
                  />
                </label>
              </details>
            </>
          ) : (
            <div className="question-import-empty">Import or select a pending question.</div>
          )}
        </section>
      </div>
    </section>
  );
}
