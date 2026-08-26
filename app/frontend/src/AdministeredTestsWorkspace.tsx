import { useEffect, useState } from "react";

import { createScanBatch, getSheetPdfUrl, listAdministeredTests } from "./api";
import type { AdministeredTestSnapshotSummaryModel } from "./types";

export default function AdministeredTestsWorkspace() {
  const [snapshots, setSnapshots] = useState<AdministeredTestSnapshotSummaryModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [busySnapshotId, setBusySnapshotId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const response = await listAdministeredTests();
      setSnapshots(response.items);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  async function handleStartScanBatch(snapshotId: string) {
    setBusySnapshotId(snapshotId);
    try {
      const batch = await createScanBatch({ snapshotId });
      setStatusMessage(`Scan batch created (${batch.id}). Switch to Scan & Review to upload scans.`);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusySnapshotId(null);
    }
  }

  return (
    <div className="administered-tests-workspace">
      <header className="standards-panel-header">
        <div>
          <h2>Administered Tests</h2>
          <p>
            Each row is a frozen snapshot of exactly what was printed and handed to students --
            editing the bank's test afterward never changes one. See docs/grading-plan.md.
          </p>
        </div>
        {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
      </header>

      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}
      {loading ? <p>Loading...</p> : null}
      {!loading && snapshots.length === 0 ? (
        <p>
          No tests have been printed into this gradebook yet. Use "Create Response Sheets..." from
          a test's Test Builder in a bank to hand one off here.
        </p>
      ) : null}

      <div className="standards-record-list">
        {snapshots.map((snapshot) => (
          <article key={snapshot.id} className="standards-record-card administered-test-card">
            <div>
              <strong>
                {snapshot.title} - Version {snapshot.version}
              </strong>
              <p>
                Printed {new Date(snapshot.printed_at).toLocaleString()}
                {snapshot.source_bank_title ? ` from "${snapshot.source_bank_title}"` : ""}
              </p>
              <p>
                {snapshot.total_points} pts - {snapshot.page_count} page
                {snapshot.page_count === 1 ? "" : "s"} - {snapshot.mode === "pre_id" ? "Pre-identified" : "Blank"}
              </p>
            </div>
            <div className="standards-import-actions">
              <a
                className="button-like"
                href={getSheetPdfUrl(snapshot.layout_id)}
                target="_blank"
                rel="noreferrer"
              >
                Download PDF
              </a>
              <button
                type="button"
                onClick={() => void handleStartScanBatch(snapshot.id)}
                disabled={busySnapshotId === snapshot.id}
              >
                New Scan Batch
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
