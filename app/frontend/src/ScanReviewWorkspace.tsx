import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import {
  getAdministeredTest,
  getScanBatch,
  getSheetImageUrl,
  ingestScans,
  listScanBatches,
  listAdministeredTests,
  listStudents,
  overrideRowResult,
  reassignSheetToPrinting,
  resolveSheetIdentity,
} from "./api";
import type {
  AdministeredTestSnapshotModel,
  AdministeredTestSnapshotSummaryModel,
  DetectedRowResultModel,
  GradingBatchModel,
  ScannedSheetModel,
  StudentModel,
} from "./types";

type SheetFilter = "all" | "needs_review";

interface ScanReviewWorkspaceProps {
  /** Called after any mutation so the gradebook shell can mark itself dirty --
   *  none of scan review's edits save on their own, unlike a roster edit. */
  onChanged?: () => void;
  /** The printings of the one test this is scoped to. Review lives inside a
   *  test's drill-down now, so the batch picker filters within that test rather
   *  than across the whole gradebook.
   *
   *  A scan whose QR names a *different* test still lands in its own batch --
   *  ingestion sorts by what the paper says, not by what page you were on --
   *  so uploads are reported by test rather than silently vanishing from view. */
  snapshotIds: string[];
  testTitle: string;
}

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

/** Click-to-zoom factor. Enough to read a smudged bubble, small enough that the
 *  surrounding rows stay visible for context. */
const CLICK_ZOOM = 3;

const LOUPE_SIZE_PX = 220;

/** How much of the sheet the loupe shows across its width, in inches.
 *
 *  Sized by the paper rather than by a zoom factor: a question row is about
 *  1.6in wide (the number plus five choices), and two inches holds one with
 *  room plus three or four rows above and below. A fixed magnification would
 *  show less of the sheet as the review panel got wider, which is exactly when
 *  the numbers and bubbles would start falling outside the window.
 */
const LOUPE_SPAN_IN = 2.0;

/** Hide the loupe this close to the sheet's edge, where it would mostly show
 *  the blank beyond the paper. */
const LOUPE_EDGE_GUARD_PX = 10;

/** Fallback magnification for when the printed sheet's size is not known yet. */
const LOUPE_ZOOM = 3;

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

/** Scale about the top-left, then shift so the clicked point sits in the middle
 *  of the frame -- clamped so the crop never runs off the sheet into blank space. */
function sheetZoomStyle(point: { x: number; y: number }): CSSProperties {
  const shift = (fraction: number) => {
    const centred = 0.5 - fraction * CLICK_ZOOM;
    // Percentages are of the image's own width/height, which is what the
    // transform translates by.
    const min = (1 - CLICK_ZOOM) * 100;
    return Math.min(0, Math.max(min, centred * 100));
  };
  return {
    transformOrigin: "0 0",
    transform: `translate(${shift(point.x)}%, ${shift(point.y)}%) scale(${CLICK_ZOOM})`,
  };
}

/** Why this sheet cannot be scored, in the same terms the report uses.
 *
 *  Derived from the sheet's own fields, not from `identity_status`: resolving an
 *  identity by hand overwrites that status, which would erase the reason the
 *  page was unusable and leave it looking fixed. Mirrors `exclusion_reasons`
 *  in grading/scoring.py.
 */
function sheetProblems(sheet: ScannedSheetModel, batchSnapshotId: string | null): string[] {
  const problems: string[] = [];

  if (!sheet.snapshot_id) {
    problems.push(
      "The QR code could not be read, so this page was never matched to a printed test.",
    );
  } else if (batchSnapshotId && sheet.snapshot_id !== batchSnapshotId) {
    problems.push(
      "This page is from a different printing of the test, so it cannot be scored in this batch.",
    );
  }

  if (sheet.fiducial_confidence == null) {
    problems.push(
      "The corner markers could not be found, so the page could not be lined up to read answers. Rescan it flat and fully in frame.",
    );
  } else if (!sheet.row_results.length) {
    problems.push("No answer rows were read from this page.");
  }

  return problems;
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

export default function ScanReviewWorkspace({
  onChanged,
  snapshotIds,
  testTitle,
}: ScanReviewWorkspaceProps) {
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
  const [printings, setPrintings] = useState<AdministeredTestSnapshotSummaryModel[]>([]);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [openRubrics, setOpenRubrics] = useState<Record<string, boolean>>({});
  // Click-to-zoom: the point to centre on, as a fraction of the sheet, or null
  // for the whole page. The frame never resizes -- it crops.
  const [zoomPoint, setZoomPoint] = useState<{ x: number; y: number } | null>(null);
  // Loupe: where the cursor is over the sheet, and the sheet's rendered size.
  const [loupe, setLoupe] = useState<
    { cursorX: number; cursorY: number; x: number; y: number; width: number; height: number } | null
  >(null);
  const sheetImageRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [freeTextName, setFreeTextName] = useState("");
  const [rowDrafts, setRowDrafts] = useState<Record<string, string>>({});

  async function refreshBatches() {
    setLoading(true);
    try {
      const response = await listScanBatches();
      const mine = response.items.filter((batch) => snapshotIds.includes(batch.snapshot_id));
      setBatches(mine);
      setErrorMessage("");
      setSelectedBatchId((current) =>
        current && mine.some((batch) => batch.id === current) ? current : mine[0]?.id ?? null,
      );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotIds.join(",")]);

  useEffect(() => {
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

  // Stepping moves through the sheets the filter is showing, so "needs review"
  // walks only the ones still outstanding.
  const sheetPosition = visibleSheets.findIndex((sheet) => sheet.id === selectedSheetId);
  const stepSheet = (direction: -1 | 1) => {
    if (visibleSheets.length === 0) return;
    const next = sheetPosition < 0 ? 0 : sheetPosition + direction;
    const target = visibleSheets[Math.min(visibleSheets.length - 1, Math.max(0, next))];
    if (target) setSelectedSheetId(target.id);
  };

  useEffect(() => {
    setFreeTextName(selectedSheet?.free_text_name ?? "");
    setRowDrafts({});
    setExpandedRows({});
    setOpenRubrics({});
    setZoomPoint(null);
    setLoupe(null);
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

  useEffect(() => {
    let cancelled = false;
    void listAdministeredTests()
      .then((response) => {
        if (!cancelled) setPrintings(response.items);
      })
      .catch(() => {
        if (!cancelled) setPrintings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBatchId]);

  async function handleReassign(snapshotId: string) {
    if (!selectedBatchId || !selectedSheet) return;
    setBusy(true);
    try {
      await reassignSheetToPrinting(selectedBatchId, selectedSheet.id, snapshotId);
      await refreshSelectedBatch(selectedBatchId);
      setStatusMessage("Matched to that printing and read again.");
      onChanged?.();
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const questionsById = Object.fromEntries(
    (snapshot?.questions ?? []).map((question) => [question.id, question]),
  );

  /** Each sheet's QR says which test it is, so the scans sort themselves rather
   *  than needing a batch chosen up front.
   *
   *  That also means a page from another test can come out of the same stack of
   *  paper. It still lands correctly -- under that test, not this one -- so the
   *  status message says where the scans went instead of leaving a teacher
   *  looking at a page that seems to have swallowed them. */
  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      // Unreadable pages file themselves under this test rather than under
      // whichever test was printed most recently -- the teacher is looking at
      // this one, so this is where they will go looking for a lost page.
      const landed = (await ingestScans(Array.from(files), snapshotIds[0] ?? null)).items;
      await refreshBatches();

      const here = landed.filter((batch) => snapshotIds.includes(batch.snapshot_id));
      const elsewhere = landed.length - here.length;
      if (here[0]) {
        setSelectedBatchId(here[0].id);
        await refreshSelectedBatch(here[0].id);
      }

      const sheetsHere = here.reduce((total, batch) => total + batch.sheets.length, 0);
      const elsewhereNames = landed
        .filter((batch) => !snapshotIds.includes(batch.snapshot_id))
        .map((batch) => batch.source_description || "another test");
      setStatusMessage(
        elsewhere === 0
          ? `${sheetsHere} sheet${sheetsHere === 1 ? "" : "s"} added to ${testTitle}.`
          : `${sheetsHere} sheet${sheetsHere === 1 ? "" : "s"} added to ${testTitle}. ` +
            `Pages belonging to ${elsewhereNames.join(", ")} were filed under ` +
            `${elsewhere === 1 ? "that test" : "those tests"} instead.`,
      );
      onChanged?.();
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
      onChanged?.();
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
      onChanged?.();
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
      onChanged?.();
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Accept what the detector read. A low-confidence mark is usually simply
   *  correct, and confirming it is faster than retyping the same letter. */
  async function handleConfirmDetected(row: DetectedRowResultModel) {
    if (!selectedBatchId || !selectedSheet) return;
    setBusy(true);
    try {
      if (row.kind === "numeric_response") {
        await overrideRowResult(selectedBatchId, selectedSheet.id, row.question_id, {
          overrideValue: row.detected_value ?? null,
        });
      } else {
        await overrideRowResult(selectedBatchId, selectedSheet.id, row.question_id, {
          overrideChoiceIndices: row.detected_choice_indices,
        });
      }
      await refreshSelectedBatch(selectedBatchId);
      setStatusMessage(`Question ${row.sheet_item_number} confirmed.`);
      onChanged?.();
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Several letters at once: a question may be multiple-select, and even when
   *  it is not, two marks is what the student actually did and should be
   *  recorded as such rather than quietly reduced to one. */
  async function handleApplyChoices(row: DetectedRowResultModel, letters: string) {
    if (!selectedBatchId || !selectedSheet) return;
    const indices = [
      ...new Set(
        letters
          .toUpperCase()
          .split(/[^A-Z]+/)
          .join("")
          .split("")
          .map((letter) => letter.charCodeAt(0) - 65)
          .filter((index) => index >= 0 && index < 26),
      ),
    ].sort((left, right) => left - right);

    if (indices.length === 0) return;
    setBusy(true);
    try {
      await overrideRowResult(selectedBatchId, selectedSheet.id, row.question_id, {
        overrideChoiceIndices: indices,
      });
      await refreshSelectedBatch(selectedBatchId);
      setStatusMessage(`Question ${row.sheet_item_number} set to ${letters.toUpperCase()}.`);
      onChanged?.();
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
      onChanged?.();
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
      onChanged?.();
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scan-review-workspace">
      {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

      <div className="standards-import-grid">
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
        {batches.length > 1 ? (
          <label>
            Scan batch
            <select
              value={selectedBatchId ?? ""}
              onChange={(event) => {
                setSelectedBatchId(event.target.value || null);
                setSelectedSheetId(null);
              }}
            >
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.source_description ||
                    `Scanned ${new Date(batch.created_at).toLocaleDateString()}`}{" "}
                  ({batch.sheets.length} sheet{batch.sheets.length === 1 ? "" : "s"})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Show
          <select value={filter} onChange={(event) => setFilter(event.target.value as SheetFilter)}>
            <option value="needs_review">Needs review</option>
            <option value="all">All sheets</option>
          </select>
        </label>
      </div>

      {loading ? <p>Loading...</p> : null}
      {!loading && batches.length === 0 ? (
        <p>
          No sheets have been scanned for {testTitle} yet. Upload the scanned pages above -- each
          page's QR code says which test and which student it is, so they sort themselves.
        </p>
      ) : null}

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
                  <div
                    className={`scan-review-image-frame ${zoomPoint ? "zoomed" : ""}`}
                    onClick={(event) => {
                      // Click toggles a 3x crop centred where you clicked. The
                      // frame keeps its size, so the layout never shifts under
                      // the cards beside it.
                      if (zoomPoint) {
                        setZoomPoint(null);
                        return;
                      }
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setZoomPoint({
                        x: (event.clientX - bounds.left) / bounds.width,
                        y: (event.clientY - bounds.top) / bounds.height,
                      });
                    }}
                    onMouseMove={(event) => {
                      const image = sheetImageRef.current;
                      if (!image) return;
                      // Two frames of reference: the loupe is positioned inside
                      // the frame, but what it magnifies is found in the image,
                      // whose box the zoom transform has moved.
                      const column = event.currentTarget.parentElement;
                      if (!column) return;
                      const columnBounds = column.getBoundingClientRect();
                      const bounds = image.getBoundingClientRect();
                      const x = (event.clientX - bounds.left) / bounds.width;
                      const y = (event.clientY - bounds.top) / bounds.height;
                      // Stop just short of the paper's edge: right on the border
                      // the loupe would be showing mostly nothing.
                      const edgeX = LOUPE_EDGE_GUARD_PX / bounds.width;
                      const edgeY = LOUPE_EDGE_GUARD_PX / bounds.height;
                      if (x < edgeX || x > 1 - edgeX || y < edgeY || y > 1 - edgeY) {
                        setLoupe(null);
                        return;
                      }
                      setLoupe({
                        cursorX: event.clientX - columnBounds.left,
                        cursorY: event.clientY - columnBounds.top,
                        x,
                        y,
                        // Layout size, not the transformed box: the loupe should
                        // magnify the sheet by the same amount whether or not
                        // the click zoom is on, rather than compounding with it
                        // until it is showing blank paper between bubbles.
                        width: image.offsetWidth,
                        height: image.offsetHeight,
                      });
                    }}
                    onMouseLeave={() => setLoupe(null)}
                    title={zoomPoint ? "Click to fit the whole page" : "Click to zoom in here"}
                  >
                    <img
                      ref={sheetImageRef}
                      className="scan-review-image"
                      style={zoomPoint ? sheetZoomStyle(zoomPoint) : undefined}
                      src={getSheetImageUrl(selectedBatchId ?? "", selectedSheet.id)}
                      alt="Scanned response sheet"
                      draggable={false}
                    />

                  </div>
                    {loupe ? (
                      <div
                        className="scan-review-loupe"
                        style={{
                          left: loupe.cursorX,
                          top: loupe.cursorY,
                          backgroundImage: `url(${getSheetImageUrl(
                            selectedBatchId ?? "",
                            selectedSheet.id,
                          )})`,
                          ...(() => {
                            const sheetWidthIn = snapshot
                              ? snapshot.layout.page_width_pt / 72
                              : null;
                            // Render the whole sheet at the scale that puts
                            // LOUPE_SPAN_IN of it across the window.
                            const fullWidth = sheetWidthIn
                              ? (LOUPE_SIZE_PX / LOUPE_SPAN_IN) * sheetWidthIn
                              : loupe.width * LOUPE_ZOOM;
                            const fullHeight = fullWidth * (loupe.height / loupe.width);
                            return {
                              backgroundSize: `${fullWidth}px ${fullHeight}px`,
                              backgroundPosition: `${
                                LOUPE_SIZE_PX / 2 - loupe.x * fullWidth
                              }px ${LOUPE_SIZE_PX / 2 - loupe.y * fullHeight}px`,
                            };
                          })(),
                        }}
                      />
                    ) : null}

                  <p className="scan-review-image-hint">
                    {zoomPoint
                      ? "Zoomed 3x - click the sheet to fit the page again."
                      : "Hover to magnify, click to zoom in."}
                  </p>
                </div>

                <div className="scan-review-review-column">
                  <div className="scan-review-nav">
                    <button
                      type="button"
                      onClick={() => stepSheet(-1)}
                      disabled={sheetPosition <= 0}
                    >
                      Previous
                    </button>
                    <span>
                      {sheetPosition >= 0 ? sheetPosition + 1 : "-"} of {visibleSheets.length}
                      {filter === "needs_review" ? " needing review" : " sheets"}
                    </span>
                    <button
                      type="button"
                      onClick={() => stepSheet(1)}
                      disabled={sheetPosition < 0 || sheetPosition >= visibleSheets.length - 1}
                    >
                      Next
                    </button>
                  </div>

                  {sheetProblems(selectedSheet, selectedBatch?.snapshot_id ?? null).length > 0 ? (
                    <div className="standards-panel scan-review-problems">
                      <h3>This sheet cannot be scored</h3>
                      <ul>
                        {sheetProblems(
                          selectedSheet,
                          selectedBatch?.snapshot_id ?? null,
                        ).map((problem) => (
                          <li key={problem}>{problem}</li>
                        ))}
                      </ul>
                      <p>
                        Naming the student does not fix these -- the page itself could not be
                        read. Try one of these instead:
                      </p>
                      <ol className="scan-review-fixes">
                        <li>
                          <strong>Say which test this is.</strong> If the QR is damaged but the
                          page is otherwise clean, matching it by hand lets the corner markers
                          line it up and the answers read normally.
                          <div className="gradebook-manual-open">
                            <select
                              value=""
                              disabled={busy || printings.length === 0}
                              onChange={(event) => {
                                if (event.target.value) void handleReassign(event.target.value);
                              }}
                            >
                              <option value="">
                                {printings.length === 0
                                  ? "No printings in this gradebook"
                                  : "Match to a printing..."}
                              </option>
                              {printings.map((printing) => (
                                <option key={printing.id} value={printing.id}>
                                  {printing.title} - Version {printing.version} (
                                  {new Date(printing.printed_at).toLocaleDateString()})
                                </option>
                              ))}
                            </select>
                          </div>
                        </li>
                        <li>
                          <strong>Rescan it.</strong> Flat, fully in frame, right way up. This is
                          the only fix when the corner markers cannot be found at all.
                        </li>
                      </ol>
                    </div>
                  ) : null}

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
                                  {/* Only when there is a real reading to accept. A numeric
                                      row whose digits came back "?" has nothing to confirm --
                                      offering it would record an unusable value as settled. */}
                                  {row.kind !== "manual_capture" &&
                                  needsReview &&
                                  (row.kind === "numeric_response"
                                    ? row.detected_value != null
                                    : row.detected_choice_indices.length > 0) ? (
                                    <button
                                      type="button"
                                      className="scan-review-confirm"
                                      disabled={busy}
                                      onClick={() => void handleConfirmDetected(row)}
                                      title="Accept what was read and clear the flag"
                                    >
                                      Confirm {shortAnswer(row)}
                                    </button>
                                  ) : null}

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
                                        maxLength={6}
                                        placeholder="A, or AC for two marks"
                                        value={rowDrafts[row.question_id] ?? ""}
                                        onChange={(event) =>
                                          setRowDrafts((current) => ({
                                            ...current,
                                            [row.question_id]: event.target.value,
                                          }))
                                        }
                                        onKeyDown={(event) => {
                                          if (event.key === "Enter" && rowDrafts[row.question_id]) {
                                            void handleApplyChoices(
                                              row,
                                              rowDrafts[row.question_id] ?? "",
                                            );
                                          }
                                        }}
                                      />
                                      <button
                                        type="button"
                                        disabled={busy || !rowDrafts[row.question_id]}
                                        onClick={() =>
                                          void handleApplyChoices(
                                            row,
                                            rowDrafts[row.question_id] ?? "",
                                          )
                                        }
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

                  <div className="scan-review-nav">
                    <button
                      type="button"
                      onClick={() => stepSheet(-1)}
                      disabled={sheetPosition <= 0}
                    >
                      Previous
                    </button>
                    <span>
                      {sheetPosition >= 0 ? sheetPosition + 1 : "-"} of {visibleSheets.length}
                      {filter === "needs_review" ? " needing review" : " sheets"}
                    </span>
                    <button
                      type="button"
                      onClick={() => stepSheet(1)}
                      disabled={sheetPosition < 0 || sheetPosition >= visibleSheets.length - 1}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
