import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";

import {
  createStandardPlaceholders,
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

interface QuestionImportWorkspaceProps {
  open: boolean;
  hasBank: boolean;
  selectedTestLabel?: string | null;
  onClose: () => void;
  onWorkspaceChanged: (message: string, promotedQuestionIds?: string[]) => void;
  onCreateTestFromQuestions?: (questionIds: string[]) => void;
  onAddQuestionsToCurrentTest?: (questionIds: string[]) => void;
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

function getIssueTone(row: QuestionImportRowModel) {
  if (row.status === "promoted") return "adopted";
  if (row.issues.some((issue) => issue.severity !== "warning")) return "invalid";
  if (row.issues.length > 0) return "warning";
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

export default function QuestionImportWorkspace({
  open,
  hasBank,
  selectedTestLabel,
  onClose,
  onWorkspaceChanged,
  onCreateTestFromQuestions,
  onAddQuestionsToCurrentTest,
}: QuestionImportWorkspaceProps) {
  const [imports, setImports] = useState<QuestionImportStageModel[]>([]);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [pasteFormat, setPasteFormat] = useState<ImportFormat>("json");
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
    if (pendingFilter === "needs_attention" && row.issues.length === 0) return false;
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
    if (!open || !hasBank) return;
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
  }, [open, hasBank]);

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
      onWorkspaceChanged(message);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStageFile() {
    if (!importFile) {
      setErrorMessage("Choose, drop, or paste questions first.");
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

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
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
      onWorkspaceChanged(message, promotedIds);
      if (postAction === "new_test" && promotedIds.length > 0) {
        onCreateTestFromQuestions?.(promotedIds);
      }
      if (postAction === "current_test" && promotedIds.length > 0) {
        onAddQuestionsToCurrentTest?.(promotedIds);
      }
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
      onWorkspaceChanged(message);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const selectedUnknownStandardIds = selectedPending ? getUnknownStandardIds(selectedPending.row) : [];
  const selectedTone = selectedPending ? getIssueTone(selectedPending.row) : "ready";

  return (
    <section
      className="question-import-workspace pending-import-workspace"
      onDragOver={(event) => event.preventDefault()}
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
        </div>
        <div className="question-import-actions">
          <button type="button" onClick={() => void refreshImports()} disabled={busy || !hasBank}>
            Refresh
          </button>
          <button type="button" onClick={onClose}>
            Return to Editor
          </button>
        </div>
      </header>

      <div className="question-import-stage-panel pending-import-intake">
        <label className="pending-paste-box">
          Paste Questions
          <textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder="Paste JSON or CSV question content here."
            disabled={busy || !hasBank}
          />
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

      {statusMessage ? <div className="question-import-status">{statusMessage}</div> : null}
      {errorMessage ? <div className="json-error-banner">{errorMessage}</div> : null}

      <div className="pending-import-actions">
        <label>
          ID Handling
          <select
            value={idPolicy}
            onChange={(event) => setIdPolicy(event.target.value as "auto" | "keep_imported")}
          >
            <option value="auto">Use automatic Nexam IDs</option>
            <option value="keep_imported">Keep imported IDs</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(selectedPending ? [selectedPending] : [])}
          disabled={busy || !selectedPending || selectedPending.row.status !== "valid"}
        >
          Adopt This
        </button>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(selectedReadyPending)}
          disabled={busy || selectedReadyPending.length === 0}
        >
          Adopt Selected
        </button>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(allReadyPending)}
          disabled={busy || allReadyPending.length === 0}
        >
          Adopt All Ready
        </button>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(selectedReadyPending, "new_test")}
          disabled={busy || selectedReadyPending.length === 0}
        >
          Adopt + New Test
        </button>
        <button
          type="button"
          onClick={() => void adoptPendingQuestions(selectedReadyPending, "current_test")}
          disabled={busy || selectedReadyPending.length === 0 || !onAddQuestionsToCurrentTest}
        >
          Adopt + {selectedTestLabel ? selectedTestLabel : "Current Test"}
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
              const tone = getIssueTone(item.row);
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
                  </div>
                  <strong>{item.row.proposed_id ?? item.row.imported_id ?? item.row.row_id}</strong>
                  <span>{String(item.row.question.type ?? "unknown")} / {title}</span>
                  <p>{getPromptPreview(item.row.question)}</p>
                  {item.row.issues.length > 0 ? (
                    <span className="pending-issue-count">{item.row.issues.length} issue(s)</span>
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
                </div>
              </div>

              {selectedPending.row.issues.length > 0 ? (
                <div className="question-import-issues">
                  {selectedPending.row.issues.map((issue, index) => (
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
                  Time Seconds
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
