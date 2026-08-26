import { useEffect, useRef, useState } from "react";

import {
  getScanBatch,
  getSheetImageUrl,
  ingestScanBatch,
  listScanBatches,
  listStudents,
  overrideRowResult,
  resolveSheetIdentity,
} from "./api";
import type { DetectedRowResultModel, GradingBatchModel, ScannedSheetModel, StudentModel } from "./types";

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
  }, [selectedSheet?.id]);

  async function handleUpload(files: FileList | null) {
    if (!selectedBatchId || !files || files.length === 0) return;
    setBusy(true);
    try {
      await ingestScanBatch(selectedBatchId, Array.from(files));
      await refreshSelectedBatch(selectedBatchId);
      setStatusMessage("Scans ingested.");
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
            disabled={!selectedBatchId || busy}
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
            {visibleSheets.map((sheet) => (
              <button
                key={sheet.id}
                type="button"
                className={`standards-list-row ${selectedSheetId === sheet.id ? "selected" : ""}`}
                onClick={() => setSelectedSheetId(sheet.id)}
              >
                <strong>{sheet.free_text_name || sheet.student_id || sheet.sheet_id || sheet.id}</strong>
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
              <img
                className="scan-review-image"
                src={getSheetImageUrl(selectedBatchId ?? "", selectedSheet.id)}
                alt="Scanned response sheet"
              />

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
                        <button type="button" disabled={busy} onClick={() => void handleResolveIdentity(null)}>
                          Save
                        </button>
                      </div>
                    </label>
                  </div>
                ) : null}
              </div>

              <div className="scan-review-rows">
                {selectedSheet.row_results.map((row) => (
                  <div key={row.question_id} className="standards-panel scan-review-row">
                    <p>
                      <strong>Question {row.sheet_item_number}</strong> ({row.kind})
                    </p>
                    {row.kind === "manual_capture" ? (
                      <div className="gradebook-manual-open">
                        <input
                          type="number"
                          placeholder="Score"
                          value={rowDrafts[row.question_id] ?? row.manual_score ?? ""}
                          onChange={(event) =>
                            setRowDrafts((current) => ({ ...current, [row.question_id]: event.target.value }))
                          }
                        />
                        <button type="button" disabled={busy} onClick={() => void handleManualScore(row)}>
                          Save Score
                        </button>
                      </div>
                    ) : (
                      <div>
                        <p>
                          Detected: {describeDetectedAnswer(row)} - flag: {row.flag}
                          {row.confidence != null ? ` (${Math.round(row.confidence * 100)}% confidence)` : ""}
                        </p>
                        {row.flag !== "none" && row.kind === "multiple_choice" ? (
                          <div className="gradebook-manual-open">
                            <input
                              type="text"
                              maxLength={1}
                              placeholder="Correct letter (A, B, C...)"
                              value={rowDrafts[row.question_id] ?? ""}
                              onChange={(event) =>
                                setRowDrafts((current) => ({ ...current, [row.question_id]: event.target.value }))
                              }
                            />
                            <button
                              type="button"
                              disabled={busy || !rowDrafts[row.question_id]}
                              onClick={() => {
                                const letter = (rowDrafts[row.question_id] ?? "").trim().toUpperCase();
                                const choiceIndex = letter.charCodeAt(0) - 65;
                                if (letter.length === 1 && choiceIndex >= 0) {
                                  void handleOverrideChoice(row, choiceIndex);
                                }
                              }}
                            >
                              Apply
                            </button>
                          </div>
                        ) : null}
                        {row.flag !== "none" && row.kind === "numeric_response" ? (
                          <div className="gradebook-manual-open">
                            <input
                              type="number"
                              placeholder="Correct value"
                              value={rowDrafts[row.question_id] ?? ""}
                              onChange={(event) =>
                                setRowDrafts((current) => ({ ...current, [row.question_id]: event.target.value }))
                              }
                            />
                            <button
                              type="button"
                              disabled={busy || !rowDrafts[row.question_id]}
                              onClick={() => void handleOverrideValue(row)}
                            >
                              Apply
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
