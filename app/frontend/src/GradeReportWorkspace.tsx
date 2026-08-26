import { useEffect, useState } from "react";

import { getCombinedLineageReport, getGradeReport, listScanBatches, recordPerformanceRun } from "./api";
import type { CombinedGradeReportModel, GradeReportModel, GradingBatchModel } from "./types";

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

export default function GradeReportWorkspace() {
  const [batches, setBatches] = useState<GradingBatchModel[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [report, setReport] = useState<GradeReportModel | null>(null);
  const [cohortLabel, setCohortLabel] = useState("");
  const [lineageTitle, setLineageTitle] = useState("");
  const [lineageReport, setLineageReport] = useState<CombinedGradeReportModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    setLoading(true);
    listScanBatches()
      .then((response) => {
        setBatches(response.items);
        if (response.items[0]) setSelectedBatchId(response.items[0].id);
      })
      .catch((error) => setErrorMessage((error as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedBatchId) {
      setReport(null);
      return;
    }
    getGradeReport(selectedBatchId)
      .then(setReport)
      .catch((error) => setErrorMessage((error as Error).message));
  }, [selectedBatchId]);

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
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadLineage() {
    if (!lineageTitle.trim()) return;
    setBusy(true);
    try {
      setLineageReport(await getCombinedLineageReport(lineageTitle.trim()));
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grade-report-workspace">
      <header className="standards-panel-header">
        <div>
          <h2>Reports</h2>
          <p>Computed straight from a batch and its snapshot's answer key -- no bank needs to be open.</p>
        </div>
        {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
      </header>

      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

      <label>
        Batch
        <select
          value={selectedBatchId ?? ""}
          onChange={(event) => setSelectedBatchId(event.target.value || null)}
        >
          <option value="" disabled>
            {loading ? "Loading..." : "Select a batch"}
          </option>
          {batches.map((batch) => (
            <option key={batch.id} value={batch.id}>
              {batch.source_description || batch.id}
            </option>
          ))}
        </select>
      </label>

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

          <section className="standards-panel">
            <h3>Record into the bank</h3>
            <p>
              Only aggregate per-question statistics cross back into the bank -- never student
              identities -- and only when you ask for it. Requires the matching bank to still be
              open.
            </p>
            <div className="gradebook-manual-open">
              <input
                type="text"
                placeholder="Cohort label (optional)"
                value={cohortLabel}
                onChange={(event) => setCohortLabel(event.target.value)}
              />
              <button type="button" disabled={busy} onClick={() => void handleRecordPerformanceRun()}>
                Record as Performance Run
              </button>
            </div>
          </section>
        </>
      ) : null}

      <section className="standards-panel">
        <h3>Combined report across versions</h3>
        <p>Sums by-standard stats across every version of a test sharing this title.</p>
        <div className="gradebook-manual-open">
          <input
            type="text"
            placeholder="Test title"
            value={lineageTitle}
            onChange={(event) => setLineageTitle(event.target.value)}
          />
          <button type="button" disabled={busy} onClick={() => void handleLoadLineage()}>
            Load
          </button>
        </div>
        {lineageReport ? (
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
        ) : null}
      </section>
    </div>
  );
}
