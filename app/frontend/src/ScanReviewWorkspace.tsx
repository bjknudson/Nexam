import { useEffect, useRef, useState } from "react";

import {
  getAdministeredTest,
  getScanBatch,
  getSheetImageUrl,
  ingestScans,
  listScanBatches,
  listStudents,
  overrideRowResult,
  resolveSheetIdentity,
} from "./api";
import type {
  AdministeredTestSnapshotModel,
  DetectedRowResultModel,
  GradingBatchModel,
  ScannedSheetModel,
  StudentModel,
} from "./types";

type SheetFilter = "all" | "needs_review";

function describeDetectedAnswer(row: DetectedRowResultModel): string {
  if (row.override_choice_indices && row.override_choice_indices.length > 0) {
    return `${row.override_choice_indices.map((index) => String.fromCharCode(65 + index)).join(", ")} (corrected)`;
  }
  if (row.override_value != null) {
    return `${row.override_value} (corrected)`;
  }
  if (row.detected_digits) {
    return row.detected_digits;
  }
  if (row.detected_choice_indices.length > 0) {
    return row.detected_choice_indices.map((index) => String.fromCharCode(65 + index)).join(", ");
  }
  return "(none)";
}

/** Just the answer, for the collapsed row: "A", "12.5", "-". */
function shortAnswer(row: DetectedRowResultModel): string {
  if (row.override_choice_indices && row.override_choice_indices.length > 0) {
    return row.override_choice_indices.map((index) => String.fromCharCode(65 + index)).join("");
  }
  if (row.override_value != null) return String(row.override_value);
  if (row.detected_digits) return row.detected_digits;
  if (row.detected_choice_indices.length > 0) {
    return row.detected_choice_indices.map((index) => String.fromCharCode(65 + index)).join("");
  }
  // A student who answered nothing is a real, valid reading -- not an error.
  return "-";
}

const ROW_KIND_LABEL: Record<string, string> = {
  multiple_choice: "Multiple Choice",
  numeric_response: "Numeric Response",
  manual_capture: "Written Response",
};

/** Consecutive rows of one kind, so the type is said once per section rather
 *  than repeated on every row. */
function groupRowsByKind(rows: DetectedRowResultModel[]) {
  const sections: { kind: string; rows: DetectedRowResultModel[] }[] = [];
  for (const row of rows) {
    const last = sections[sections.length - 1];
    if (last && last.kind === row.kind) last.rows.push(row);
    else sections.push({ kind: row.kind, rows: [row] });
  }
  return sections;
}

/** A row only needs a human when the detector flagged it and nobody has
 *  resolved it yet, or when it is a written response nobody has scored.
 *
 *  Mirrors `row_is_resolved` in grading/review_state.py -- the two must agree,
 *  or a row the backend considers settled keeps showing as outstanding here. */
function rowNeedsReview(row: DetectedRowResultModel): boolean {
  if (row.kind === "manual_capture") return row.manual_score == null;
  if (row.override_blank) return false;
  if (row.override_choice_indices != null || row.override_value != null) return false;
  return row.flag !== "none";
}

/** Who this sheet belongs to, in words. Falls back to a position rather than a
 *  raw id -- "8637401eaf23..." tells a teacher nothing and does not fit. */
function sheetLabel(
  sheet: ScannedSheetModel,
  index: number,
  students: StudentModel[],
): string {
  const student = students.find((candidate) => candidate.id === sheet.student_id);
  if (student) return `${student.first_name} ${student.last_name}`;
  if (sheet.free_text_name) return sheet.free_text_name;
  return `Sheet ${index + 1}`;
}

function identityLabel(sheet: ScannedSheetModel): string {
  switch (sheet.identity_status) {
    case "pre_identified":
      return "Pre-identified";
    case "manually_resolved":
      return "Resolved";
    case "unresolved":
      return "Unresolved";
    case "qr_unreadable":
      return "QR unreadable";
    case "wrong_snapshot":
      return "Wrong test/version";
    default:
      return sheet.identity_status;
  }
}

export default function ScanReviewWorkspace() {
  const [batches, setBatches] = useState<GradingBatchModel[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
  const [students, setStudents] = useState<StudentModel[]>([]);
  const [filter, setFilter] = useState<SheetFilter>("needs_review");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [snapshot, setSnapshot] = useState<AdministeredTestSnapshotModel | null>(null);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [openRubrics, setOpenRubrics] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [freeTextName, setFreeTextName] = useState("");
  const [rowDrafts, setRowDrafts] = useState<Record<string, string>>({});

  async function refreshBatches() {
    setLoading(true);
    try {
      const response = await listScanBatches();
      setBatches(response.items);
      setErrorMessage("");
      if (!selectedBatchId && response.items[0]) setSelectedBatchId(response.items[0].id);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshSelectedBatch(batchId: string) {
    try {
      const batch = await getScanBatch(batchId);
      setBatches((current) => current.map((item) => (item.id === batchId ? batch : item)));
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  useEffect(() => {
    void refreshBatches();
    void listStudents()
      .then((response) => setStudents(response.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 3200);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  const selectedBatch = batches.find((batch) => batch.id === selectedBatchId) ?? null;
  const visibleSheets =
    selectedBatch?.sheets.filter((sheet) => filter === "all" || sheet.needs_review) ?? [];
  const selectedSheet = selectedBatch?.sheets.find((sheet) => sheet.id === selectedSheetId) ?? null;

  useEffect(() => {
    setFreeTextName(selectedSheet?.free_text_name ?? "");
    setRowDrafts({});
    setExpandedRows({});
    setOpenRubrics({});
  }, [selectedSheet?.id]);

  // The printed questions come from the snapshot, not the bank: scoring a
  // written response needs the prompt and rubric as they were handed out, and
  // the bank may have moved on or not be open.
  useEffect(() => {
    const snapshotId = selectedBatch?.snapshot_id;
    if (!snapshotId) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    void getAdministeredTest(snapshotId)
      .then((loaded) => {
        if (!cancelled) setSnapshot(loaded);
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBatch?.snapshot_id]);

  const questionsById = Object.fromEntries(
    (snapshot?.questions ?? []).map((question) => [question.id, question]),
  );

  /** No batch has to be chosen first -- each sheet's QR says which test it is,
   *  so the scans sort themselves and the batch picker becomes a filter rather
   *  than a thing to set up in advance. */
  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const response = await ingestScans(Array.from(files));
      await refreshBatches();
      const landed = response.items;
      if (landed.length > 0) {
        setSelectedBatchId(landed[0].id);
        await refreshSelectedBatch(landed[0].id);
      }
      setStatusMessage(
        landed.length <= 1
          ? "Scans sorted into their test."
          : `Scans sorted into ${landed.length} tests.`,
      );
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleResolveIdentity(studentId: string | null) {
    if (!selectedBatchId || !selectedSheet) return;
    setBusy(true);
    try {
      await resolveSheetIdentity(selectedBatchId, selectedSheet.id, {
        studentId,
        freeTextName: studentId ? null : freeTextName.trim() || null,
      });
      await refreshSelectedBatch(selectedBatchId);
      setStatusMessage("Identity resolved.");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleOverrideChoice(row: DetectedRowResultModel, choiceIndex: number) {
    if (!selectedBatchId || !selectedSheet) return;
    setBusy(true);
    try {
      await overrideRowResult(selectedBatchId, selectedSheet.id, row.question_id, {
        overrideChoiceIndices: [choiceIndex],
      });
      await refreshSelectedBatch(selectedBatchId);
      setStatusMessage("Answer corrected.");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleOverrideValue(row: DetectedRowResultModel) {
    if (!selectedBatchId || !selectedSheet) return;
    const draft = rowDrafts[row.question_id];
    const value = Number(draft);
    if (draft === undefined || Number.isNaN(value)) return;
    setBusy(true);
    try {
      await overrideRowResult(selectedBatchId, selectedSheet.id, row.question_id, {
        overrideValue: value,
      });
      await refreshSelectedBatch(selectedBatchId);
      setStatusMessage("Answer corrected.");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Students skip questions. Recording that as an answer -- rather than
   *  leaving it flagged forever -- is what lets the sheet finish review. */
  async function handleMarkBlank(row: DetectedRowResultModel) {
    if (!selectedBatchId || !selectedSheet) return;
    setBusy(true);
    try {
      await overrideRowResult(selectedBatchId, selectedSheet.id, row.question_id, {
        overrideBlank: true,
        overrideChoiceIndices: row.kind === "multiple_choice" ? [] : null,
      });
      await refreshSelectedBatch(selectedBatchId);
      setStatusMessage(`Question ${row.sheet_item_number} recorded as no response.`);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleManualScore(row: DetectedRowResultModel) {
    if (!selectedBatchId || !selectedSheet) return;
    const draft = rowDrafts[row.question_id];
    const score = Number(draft);
    if (draft === undefined || Number.isNaN(score)) return;
    setBusy(true);
    try {
      await overrideRowResult(selectedBatchId, selectedSheet.id, row.question_id, {
        manualScore: score,
      });
      await refreshSelectedBatch(selectedBatchId);
      setStatusMessage("Score recorded.");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scan-review-workspace">
      <header className="standards-panel-header">
        <div>
          <h2>Scan & Review</h2>
          <p>Resolve identity, correct flagged marks, and score manual-response rows.</p>
        </div>
        {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
      </header>

      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

      <div className="standards-import-grid">
        <label>
          Batch
          <select
            value={selectedBatchId ?? ""}
            onChange={(event) => {
              setSelectedBatchId(event.target.value || null);
              setSelectedSheetId(null);
            }}
          >
            <option value="" disabled>
              {loading ? "Loading..." : "Select a batch"}
            </option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.source_description || batch.id} ({batch.sheets.length} sheet
                {batch.sheets.length === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        </label>
        <label>
          Upload scans
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf"
            disabled={busy}
            onChange={(event) => void handleUpload(event.target.files)}
          />
        </label>
        <label>
          Show
          <select value={filter} onChange={(event) => setFilter(event.target.value as SheetFilter)}>
            <option value="needs_review">Needs review</option>
            <option value="all">All sheets</option>
          </select>
        </label>
      </div>

      <div className="question-import-review scan-review-layout">
        <section className="question-import-table-panel">
          {visibleSheets.length === 0 ? <p>Nothing to review here.</p> : null}
          <div className="standards-record-list compact">
            {visibleSheets.map((sheet, index) => (
              <button
                key={sheet.id}
                type="button"
                className={`standards-list-row ${selectedSheetId === sheet.id ? "selected" : ""}`}
                onClick={() => setSelectedSheetId(sheet.id)}
              >
                <strong>{sheetLabel(sheet, index, students)}</strong>
                <span>
                  {identityLabel(sheet)}
                  {sheet.needs_review ? " - needs review" : ""}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="question-import-detail-panel scan-review-detail">
          {!selectedSheet ? (
            <p>Select a sheet to review.</p>
          ) : (
            <>
              <div className="scan-review-split">
                <div className="scan-review-sheet-column">
                  <img
                    className="scan-review-image"
                    src={getSheetImageUrl(selectedBatchId ?? "", selectedSheet.id)}
                    alt="Scanned response sheet"
                  />
                </div>

                <div className="scan-review-review-column">
                  <div className="standards-panel scan-review-identity">
                    <h3>Identity: {identityLabel(selectedSheet)}</h3>
                    {selectedSheet.identity_status !== "pre_identified" ? (
                      <div className="standards-import-grid">
                        <label>
                          Match to roster
                          <select
                            value=""
                            disabled={busy}
                            onChange={(event) => {
                              if (event.target.value) void handleResolveIdentity(event.target.value);
                            }}
                          >
                            <option value="">Choose a student...</option>
                            {students.map((student) => (
                              <option key={student.id} value={student.id}>
                                {student.first_name} {student.last_name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Or free-text name
                          <div className="gradebook-manual-open">
                            <input
                              type="text"
                              value={freeTextName}
                              onChange={(event) => setFreeTextName(event.target.value)}
                            />
                            <button
                              type="button"
                              disabled={busy || !freeTextName.trim()}
                              onClick={() => void handleResolveIdentity(null)}
                            >
                              Save
                            </button>
                          </div>
                        </label>
                      </div>
                    ) : null}
                  </div>

                  {groupRowsByKind(selectedSheet.row_results).map((section, sectionIndex) => (
                    <section className="scan-review-section" key={`${section.kind}-${sectionIndex}`}>
                      <h4>{ROW_KIND_LABEL[section.kind] ?? section.kind}</h4>
                      <div className="scan-review-row-list">
                        {section.rows.map((row) => {
                          const needsReview = rowNeedsReview(row);
                          const expanded = expandedRows[row.question_id] ?? needsReview;
                          const question = questionsById[row.question_id];
                          return (
                            <div
                              key={row.question_id}
                              className={`scan-review-row ${needsReview ? "needs-review" : "confident"} ${
                                expanded ? "expanded" : ""
                              }`}
                            >
                              <button
                                type="button"
                                className="scan-review-row-summary"
                                aria-expanded={expanded}
                                onClick={() =>
                                  setExpandedRows((current) => ({
                                    ...current,
                                    [row.question_id]: !expanded,
                                  }))
                                }
                              >
                                <span className="scan-review-row-number">
                                  {row.sheet_item_number}.
                                </span>
                                <span className="scan-review-row-answer">
                                  {row.kind === "manual_capture"
                                    ? row.manual_score != null
                                      ? `${row.manual_score} pts`
                                      : "unscored"
                                    : shortAnswer(row)}
                                </span>
                                {needsReview ? <span className="scan-review-row-flag" /> : null}
                              </button>

                              {expanded ? (
                                <div className="scan-review-row-body">
                                  {row.kind !== "manual_capture" ? (
                                    <p className="scan-review-row-detail">
                                      {row.flag === "none" ? "Clear read" : row.flag.replace(/_/g, " ")}
                                      {row.confidence != null
                                        ? ` - ${Math.round(row.confidence * 100)}%`
                                        : ""}
                                    </p>
                                  ) : null}

                                  {row.kind === "manual_capture" ? (
                                    <>
                                      <div className="gradebook-manual-open">
                                        <input
                                          type="number"
                                          placeholder="Score"
                                          value={rowDrafts[row.question_id] ?? row.manual_score ?? ""}
                                          onChange={(event) =>
                                            setRowDrafts((current) => ({
                                              ...current,
                                              [row.question_id]: event.target.value,
                                            }))
                                          }
                                        />
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() => void handleManualScore(row)}
                                        >
                                          Save Score
                                        </button>
                                      </div>
                                      {question ? (
                                        <>
                                          <button
                                            type="button"
                                            className="scan-review-rubric-toggle"
                                            onClick={() =>
                                              setOpenRubrics((current) => ({
                                                ...current,
                                                [row.question_id]: !current[row.question_id],
                                              }))
                                            }
                                          >
                                            {openRubrics[row.question_id]
                                              ? "Hide question and rubric"
                                              : "Show question and rubric"}
                                          </button>
                                          {openRubrics[row.question_id] ? (
                                            <div className="scan-review-rubric">
                                              <p className="scan-review-rubric-prompt">
                                                {question.prompt}
                                              </p>
                                              {question.rubric.length > 0 ? (
                                                <ul>
                                                  {question.rubric.map((criterion, index) => (
                                                    <li key={`${criterion.criterion}-${index}`}>
                                                      <strong>{criterion.points}</strong>{" "}
                                                      {criterion.criterion}
                                                    </li>
                                                  ))}
                                                </ul>
                                              ) : (
                                                <p className="scan-review-rubric-empty">
                                                  No rubric on this question.
                                                </p>
                                              )}
                                              {question.sample_solution ? (
                                                <p className="scan-review-rubric-solution">
                                                  <strong>Sample solution:</strong>{" "}
                                                  {question.sample_solution}
                                                </p>
                                              ) : null}
                                            </div>
                                          ) : null}
                                        </>
                                      ) : null}
                                    </>
                                  ) : null}

                                  {row.kind === "multiple_choice" ? (
                                    <div className="gradebook-manual-open">
                                      <input
                                        type="text"
                                        maxLength={1}
                                        placeholder="A, B, C..."
                                        value={rowDrafts[row.question_id] ?? ""}
                                        onChange={(event) =>
                                          setRowDrafts((current) => ({
                                            ...current,
                                            [row.question_id]: event.target.value,
                                          }))
                                        }
                                      />
                                      <button
                                        type="button"
                                        disabled={busy || !rowDrafts[row.question_id]}
                                        onClick={() => {
                                          const letter = (rowDrafts[row.question_id] ?? "")
                                            .trim()
                                            .toUpperCase();
                                          const choiceIndex = letter.charCodeAt(0) - 65;
                                          if (letter.length === 1 && choiceIndex >= 0) {
                                            void handleOverrideChoice(row, choiceIndex);
                                          }
                                        }}
                                      >
                                        Apply
                                      </button>
                                      <button
                                        type="button"
                                        className="scan-review-blank-button"
                                        disabled={busy}
                                        onClick={() => void handleMarkBlank(row)}
                                        title="The student left this one blank -- record it and clear the flag"
                                      >
                                        No response
                                      </button>
                                    </div>
                                  ) : null}

                                  {row.kind === "numeric_response" ? (
                                    <div className="gradebook-manual-open">
                                      <input
                                        type="number"
                                        placeholder="Value"
                                        value={rowDrafts[row.question_id] ?? ""}
                                        onChange={(event) =>
                                          setRowDrafts((current) => ({
                                            ...current,
                                            [row.question_id]: event.target.value,
                                          }))
                                        }
                                      />
                                      <button
                                        type="button"
                                        disabled={busy || !rowDrafts[row.question_id]}
                                        onClick={() => void handleOverrideValue(row)}
                                      >
                                        Apply
                                      </button>
                                      <button
                                        type="button"
                                        className="scan-review-blank-button"
                                        disabled={busy}
                                        onClick={() => void handleMarkBlank(row)}
                                        title="The student left this one blank -- record it and clear the flag"
                                      >
                                        No response
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
