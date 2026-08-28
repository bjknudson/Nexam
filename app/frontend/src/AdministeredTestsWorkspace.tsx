import { useEffect, useState } from "react";

import { getSheetPdfUrl, listAdministeredTests } from "./api";
import { isDesktopShell, printPdfUrl, saveBytesDialog } from "./desktop";
import ResponseSheetPrintPane from "./ResponseSheetPrintPane";
import type { AdministeredTestSnapshotSummaryModel } from "./types";

const PANE_SYNC_CHANNEL = "nexzam-pane-sync";

/** Printings of one test, newest first.
 *
 *  Every hand-off makes its own snapshot, so a test reprinted three times filled
 *  the list with three near-identical rows. Stacking them by title keeps the
 *  list about tests, with the reprints tucked underneath the most recent one. */
function stackByTitle(
  snapshots: AdministeredTestSnapshotSummaryModel[],
): { title: string; printings: AdministeredTestSnapshotSummaryModel[] }[] {
  const stacks = new Map<string, AdministeredTestSnapshotSummaryModel[]>();
  for (const snapshot of snapshots) {
    const key = snapshot.title.trim().toLowerCase();
    const existing = stacks.get(key);
    if (existing) existing.push(snapshot);
    else stacks.set(key, [snapshot]);
  }
  return [...stacks.values()]
    .map((printings) => {
      const sorted = [...printings].sort(
        (left, right) => Date.parse(right.printed_at) - Date.parse(left.printed_at),
      );
      return { title: sorted[0].title, printings: sorted };
    })
    .sort(
      (left, right) =>
        Date.parse(right.printings[0].printed_at) - Date.parse(left.printings[0].printed_at),
    );
}

export default function AdministeredTestsWorkspace() {
  const [snapshots, setSnapshots] = useState<AdministeredTestSnapshotSummaryModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [busySnapshotId, setBusySnapshotId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [openStacks, setOpenStacks] = useState<Record<string, boolean>>({});
  const [handOffOpen, setHandOffOpen] = useState(false);
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

  // A test handed off from a bank window is written by the shared backend, so
  // this list has to be told to reread it.
  useEffect(() => {
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(PANE_SYNC_CHANNEL);
    } catch {
      return;
    }
    channel.onmessage = (event) => {
      if (event.data?.type === "gradebook-data-changed") void refresh();
    };
    return () => channel.close();
  }, []);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  /** `<a target="_blank" download>` is inert inside the macOS webview -- it
   *  neither opens a window nor downloads -- so the bytes come back through the
   *  shell's save dialog instead. In a browser the same fetch drives an object
   *  URL, which does work there. */
  async function handleSavePdf(snapshot: AdministeredTestSnapshotSummaryModel) {
    setBusySnapshotId(snapshot.id);
    setErrorMessage("");
    try {
      const response = await fetch(getSheetPdfUrl(snapshot.layout_id));
      if (!response.ok) throw new Error("Could not build the response-sheet PDF.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const suggestedFileName = `${snapshot.title}-${snapshot.version}-response-sheets.pdf`;

      if (isDesktopShell()) {
        const savedTo = await saveBytesDialog(bytes, { suggestedFileName });
        setStatusMessage(savedTo ? `Saved to ${savedTo}` : "Save cancelled.");
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = suggestedFileName;
        link.click();
        URL.revokeObjectURL(url);
        setStatusMessage("Downloaded.");
      }
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
        <div className="standards-header-actions">
          {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
          <button type="button" onClick={() => setHandOffOpen(true)}>
            Create Response Sheets...
          </button>
        </div>
      </header>

      {handOffOpen ? (
        <div className="administered-test-handoff">
          <ResponseSheetPrintPane
            testId={null}
            onClose={() => {
              setHandOffOpen(false);
              void refresh();
            }}
          />
        </div>
      ) : null}

      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}
      {loading ? <p>Loading...</p> : null}
      {!loading && snapshots.length === 0 ? (
        <p>
          No tests have been printed into this gradebook yet. Use "Create Response
          Sheets..." above, or the same button in a bank's Test Builder, to hand one off. A
          bank has to be open for its tests to be listed.
        </p>
      ) : null}

      <div className="standards-record-list">
        {stackByTitle(snapshots).map((stack) => {
          const [latest, ...older] = stack.printings;
          const stackKey = stack.title.trim().toLowerCase();
          const expanded = openStacks[stackKey] ?? false;
          return (
            <div className="administered-test-stack" key={stackKey}>
              <article className="standards-record-card administered-test-card">
                <div>
                  <strong>{latest.title}</strong>
                  <p>
                    Version {latest.version} - printed{" "}
                    {new Date(latest.printed_at).toLocaleString()}
                    {latest.source_bank_title ? ` from "${latest.source_bank_title}"` : ""}
                  </p>
                  <p>
                    {latest.total_points} pts - {latest.page_count} page
                    {latest.page_count === 1 ? "" : "s"} -{" "}
                    {latest.mode === "pre_id" ? "Pre-identified" : "Blank"}
                  </p>
                  {older.length > 0 ? (
                    <button
                      type="button"
                      className="administered-test-stack-toggle"
                      onClick={() =>
                        setOpenStacks((current) => ({ ...current, [stackKey]: !expanded }))
                      }
                    >
                      {expanded
                        ? "Hide earlier printings"
                        : `${older.length} earlier printing${older.length === 1 ? "" : "s"}`}
                    </button>
                  ) : null}
                </div>
                <div className="standards-import-actions">
                  <button
                    type="button"
                    onClick={() =>
                      void printPdfUrl(
                        getSheetPdfUrl(latest.layout_id),
                        `${latest.title} - Version ${latest.version}`,
                      )
                    }
                  >
                    Print...
                  </button>
                  <button
                    type="button"
                    disabled={busySnapshotId === latest.id}
                    onClick={() => void handleSavePdf(latest)}
                  >
                    Save PDF...
                  </button>
                </div>
              </article>

              {expanded
                ? older.map((printing) => (
                    <article
                      key={printing.id}
                      className="standards-record-card administered-test-card administered-test-earlier"
                    >
                      <div>
                        <strong>
                          Version {printing.version}
                        </strong>
                        <p>Printed {new Date(printing.printed_at).toLocaleString()}</p>
                        <p>
                          {printing.total_points} pts - {printing.page_count} page
                          {printing.page_count === 1 ? "" : "s"} -{" "}
                          {printing.mode === "pre_id" ? "Pre-identified" : "Blank"}
                        </p>
                      </div>
                      <div className="standards-import-actions">
                        <button
                          type="button"
                          disabled={busySnapshotId === printing.id}
                          onClick={() => void handleSavePdf(printing)}
                        >
                          Save PDF...
                        </button>
                      </div>
                    </article>
                  ))
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
