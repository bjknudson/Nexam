import { useEffect, useMemo, useState } from "react";

import {
  getCombinedLineageReport,
  getGradeReport,
  getMasterySettings,
  recordPerformanceRun,
  setLineageMasterySettings,
} from "./api";
import MasteryModePicker from "./MasteryModePicker";
import type {
  AdministeredTestSnapshotSummaryModel,
  CombinedGradeReportModel,
  GradebookMasteryConfigModel,
  GradeReportModel,
  GradingBatchModel,
  MasteryCalculation,
  MasteryReporting,
} from "./types";

interface GradeReportWorkspaceProps {
  /** The test being drilled into. Batches arrive already filtered to it by the
   *  caller, so this panel never has to think about any other test. */
  lineageId: string;
  testTitle: string;
  batches: GradingBatchModel[];
  printings: AdministeredTestSnapshotSummaryModel[];
}

function bucketLowerBound(bucket: string): number {
  return Number(bucket.split("-")[0]) || 0;
}

/** A single-series histogram: magnitude across ordered buckets, one hue, no
 * legend needed (single series doesn't need one), direct value labels,
 * native title attribute as a cheap hover layer. */
function ScoreHistogram({ histogram }: { histogram: Record<string, number> }) {
  const buckets = Object.entries(histogram).sort(([a], [b]) => bucketLowerBound(a) - bucketLowerBound(b));
  const maxCount = Math.max(1, ...buckets.map(([, count]) => count));

  if (buckets.length === 0) return <p>No scored sheets yet.</p>;

  return (
    <div className="score-histogram" role="img" aria-label="Score distribution histogram">
      {buckets.map(([bucket, count]) => (
        <div key={bucket} className="score-histogram-row" title={`${bucket}%: ${count} student${count === 1 ? "" : "s"}`}>
          <span className="score-histogram-label">{bucket}%</span>
          <div className="score-histogram-track">
            <div
              className="score-histogram-bar"
              style={{ width: `${Math.max(4, (count / maxCount) * 100)}%` }}
            />
          </div>
          <span className="score-histogram-value">{count}</span>
        </div>
      ))}
    </div>
  );
}

/** One test's results. Scoped to a single lineage by the Administered Tests
 *  drill-down that owns it, so there is no test picker here -- you got here by
 *  picking a test.
 *
 *  Computed straight from a batch and its snapshot's frozen answer key; no bank
 *  needs to be open, except to record a performance run back into one. */
export default function GradeReportWorkspace({
  lineageId,
  testTitle,
  batches,
  printings,
}: GradeReportWorkspaceProps) {
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [report, setReport] = useState<GradeReportModel | null>(null);
  const [cohortLabel, setCohortLabel] = useState("");
  const [lineageReport, setLineageReport] = useState<CombinedGradeReportModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [mastery, setMastery] = useState<GradebookMasteryConfigModel | null>(null);

  const versionBySnapshotId = useMemo(
    () => Object.fromEntries(printings.map((printing) => [printing.id, printing.version])),
    [printings],
  );

  function batchLabel(batch: GradingBatchModel): string {
    const version = versionBySnapshotId[batch.snapshot_id];
    const name =
      batch.source_description || `Scanned ${new Date(batch.created_at).toLocaleDateString()}`;
    return version ? `${name} - version ${version}` : name;
  }

  // Land on the newest batch, which is almost always the one just scanned.
  useEffect(() => {
    setSelectedBatchId((current) =>
      current && batches.some((batch) => batch.id === current) ? current : batches[0]?.id ?? null,
    );
  }, [batches]);

  useEffect(() => {
    if (!selectedBatchId) {
      setReport(null);
      return;
    }
    let cancelled = false;
    getGradeReport(selectedBatchId)
      .then((loaded) => {
        if (!cancelled) setReport(loaded);
      })
      .catch((error) => {
        if (!cancelled) setErrorMessage((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBatchId]);

  // Unlike the single-batch report this one needs no setting up: the drill-down
  // already knows which test it is. Keyed on lineage rather than title, so a
  // retake linked in under a different title is counted here too.
  useEffect(() => {
    let cancelled = false;
    getCombinedLineageReport({ lineageId })
      .then((loaded) => {
        if (!cancelled) setLineageReport(loaded);
      })
      .catch(() => {
        if (!cancelled) setLineageReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lineageId, batches]);

  useEffect(() => {
    getMasterySettings()
      .then(setMastery)
      .catch(() => setMastery(null));
  }, []);

  async function saveMastery(payload: {
    calculation?: MasteryCalculation | null;
    reporting?: MasteryReporting | null;
  }) {
    setBusy(true);
    try {
      setMastery(await setLineageMasterySettings(lineageId, payload));
      setStatusMessage("Mastery mode saved for this test.");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 3200);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  async function handleRecordPerformanceRun() {
    if (!selectedBatchId) return;
    setBusy(true);
    try {
      await recordPerformanceRun(selectedBatchId, cohortLabel.trim() || null);
      setStatusMessage("Recorded into the bank's test performance history.");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (batches.length === 0) {
    return (
      <div className="grade-report-workspace">
        <p>
          Nothing has been scanned for {testTitle} yet. Once sheets are scanned in, this is where
          the score distribution, the by-item breakdown, and each student's score appear.
        </p>
      </div>
    );
  }

  return (
    <div className="grade-report-workspace">
      {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

      {batches.length > 1 ? (
        <label className="inline-select">
          Scan batch
          <select
            value={selectedBatchId ?? ""}
            onChange={(event) => setSelectedBatchId(event.target.value || null)}
          >
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batchLabel(batch)} ({batch.sheets.length} sheet
                {batch.sheets.length === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {report ? (
        <>
          {report.contains_unscored_manual_items ? (
            <p className="gradebook-error">
              Some short/free-response rows haven't been scored yet -- totals below don't include them.
            </p>
          ) : null}

          <div className="standards-header-summary">
            <span className="status-pill saved">{report.scored_sheet_count} scored</span>
            {report.excluded_sheet_count > 0 ? (
              <span className="status-pill error">{report.excluded_sheet_count} excluded</span>
            ) : null}
            <span className="status-pill">{report.total_possible_points} points possible</span>
            <span className="status-pill">{report.average_percent_correct.toFixed(1)}% average</span>
          </div>

          {(report.excluded_sheets ?? []).length > 0 ? (
            <section className="standards-panel report-excluded">
              <h3>
                {(report.excluded_sheets ?? []).length} sheet
                {(report.excluded_sheets ?? []).length === 1 ? "" : "s"} not scored
              </h3>
              <p>
                These pages are not counted in anything below. Each one says what stopped it.
              </p>
              {(report.excluded_sheets ?? []).map((excluded) => (
                <div className="report-excluded-sheet" key={excluded.sheet_id}>
                  <strong>{excluded.student_display_name || "Unidentified sheet"}</strong>
                  <ul>
                    {excluded.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ) : null}

          <section className="standards-panel">
            <h3>Score distribution</h3>
            <ScoreHistogram histogram={report.score_histogram} />
          </section>

          <section className="standards-panel">
            <h3>By standard</h3>
            <table className="scan-review-table">
              <thead>
                <tr>
                  <th>Standard</th>
                  <th>Attempts</th>
                  <th>Full credit</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {report.by_standard.map((entry) => (
                  <tr key={entry.standard_id}>
                    <td>{entry.code ?? entry.standard_id}</td>
                    <td>{entry.attempts}</td>
                    <td>{entry.full_credit_count}</td>
                    <td>{entry.percent_full_credit.toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="standards-panel">
            <h3>By item</h3>
            <table className="scan-review-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Kind</th>
                  <th>Attempts</th>
                  <th>Full credit</th>
                  <th>%</th>
                  <th>Flagged</th>
                  <th>Choice distribution</th>
                </tr>
              </thead>
              <tbody>
                {report.by_item.map((item) => (
                  <tr key={item.question_id}>
                    <td>{item.sheet_item_number}</td>
                    <td>{item.row_kind}</td>
                    <td>{item.attempts}</td>
                    <td>{item.full_credit_count}</td>
                    <td>{item.percent_full_credit.toFixed(0)}%</td>
                    <td>{item.flagged_count}</td>
                    <td>
                      {item.choice_distribution
                        .map((entry) => `${String.fromCharCode(65 + entry.choice_index)}:${entry.count}`)
                        .join(" ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="standards-panel">
            <h3>Student scores</h3>
            <table className="scan-review-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Points</th>
                  <th>%</th>
                  <th>Flagged</th>
                </tr>
              </thead>
              <tbody>
                {report.student_scores.map((score) => (
                  <tr key={score.sheet_id}>
                    <td>{score.student_display_name ?? "(unresolved)"}</td>
                    <td>
                      {score.points_earned} / {score.points_possible}
                    </td>
                    <td>{score.percent_correct.toFixed(0)}%</td>
                    <td>{score.flagged_answer_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}

      {lineageReport && lineageReport.batch_ids.length > 1 ? (
        <section className="standards-panel">
          <h3>Every version combined</h3>
          <p>
            By-standard results summed across all {lineageReport.batch_ids.length} scan batches of
            this test, including any retakes linked to it -- {lineageReport.scored_sheet_count}{" "}
            scored sheets in total.
          </p>
          <table className="scan-review-table">
            <thead>
              <tr>
                <th>Standard</th>
                <th>Attempts</th>
                <th>Full credit</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {lineageReport.by_standard.map((entry) => (
                <tr key={entry.standard_id}>
                  <td>{entry.code ?? entry.standard_id}</td>
                  <td>{entry.attempts}</td>
                  <td>{entry.full_credit_count}</td>
                  <td>{entry.percent_full_credit.toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {mastery ? (
        <section className="standards-panel">
          <h3>How mastery is calculated for this test</h3>
          <p>
            Mastery is a <strong>level</strong>, not a percentage -- how far up the ladder this
            test's evidence reaches. Which calculation suits it depends on what it asks: a full
            ladder of levels, a handful of hard questions, or a multipart task whose parts each
            have their own difficulty.
          </p>
          <MasteryModePicker
            settings={mastery.by_lineage[lineageId] ?? mastery.default}
            inheritedFrom={mastery.default}
            isOverridden={lineageId in mastery.by_lineage}
            busy={busy}
            onChange={(next) => void saveMastery(next)}
            onClearOverride={() => void saveMastery({})}
          />
        </section>
      ) : null}

      <section className="standards-panel">
        <h3>Record into the bank</h3>
        <p>
          Only aggregate per-question statistics cross back into the bank -- never student
          identities -- and only when you ask for it. Requires the matching bank to still be open.
        </p>
        <div className="gradebook-manual-open">
          <input
            type="text"
            placeholder="Cohort label (optional)"
            value={cohortLabel}
            onChange={(event) => setCohortLabel(event.target.value)}
          />
          <button
            type="button"
            disabled={busy || !selectedBatchId}
            onClick={() => void handleRecordPerformanceRun()}
          >
            Record as Performance Run
          </button>
        </div>
      </section>
    </div>
  );
}
