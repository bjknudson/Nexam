import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getSheetPdfUrl,
  listAdministeredTests,
  listScanBatches,
  relinkSnapshotLineage,
} from "./api";
import { isDesktopShell, openPaneWindow, printPdfUrl, saveBytesDialog } from "./desktop";
import ResponseSheetPrintPane from "./ResponseSheetPrintPane";
import ScanReviewWorkspace from "./ScanReviewWorkspace";
import GradeReportWorkspace from "./GradeReportWorkspace";
import type { AdministeredTestSnapshotSummaryModel, GradingBatchModel } from "./types";

const PANE_SYNC_CHANNEL = "nexzam-pane-sync";

type DrillTab = "printings" | "scans" | "report";

const DRILL_TAB_LABEL: Record<DrillTab, string> = {
  printings: "Printings",
  scans: "Scan & Review",
  report: "Report",
};

interface AdministeredTestsWorkspaceProps {
  /** Scan review and hand-off both write into the open .nxgb without saving it,
   *  so the shell needs telling it has unsaved work. */
  onChanged?: () => void;
}

/** One test, with everything the page needs to say about it in one object.
 *
 *  Printings and scans are fetched separately but only ever read together --
 *  "how is this test doing" is a question about both -- so they are joined once,
 *  here, rather than at each of the half-dozen places that ask. */
interface TestStack {
  lineageId: string;
  title: string;
  /** Newest printing first. */
  printings: AdministeredTestSnapshotSummaryModel[];
  batches: GradingBatchModel[];
  sheetCount: number;
  needsReviewCount: number;
}

/** What this test is waiting on, if anything.
 *
 *  `awaiting_scans` and `needs_review` are the two states where the teacher is
 *  the blocker: paper was printed and nothing has come back, or sheets came back
 *  and some could not be read without a human. Everything else is done. */
type TestAttention = "needs_review" | "awaiting_scans" | null;

function attentionOf(stack: TestStack): TestAttention {
  if (stack.needsReviewCount > 0) return "needs_review";
  if (stack.sheetCount === 0) return "awaiting_scans";
  return null;
}

/** Printings of one test, newest first, joined to their scans.
 *
 *  Every hand-off makes its own snapshot, so a test reprinted three times filled
 *  the list with three near-identical rows. Stacking them keeps the list about
 *  tests, with the reprints tucked underneath the most recent one.
 *
 *  Grouped by lineage rather than by title: that is the same link the gradebook
 *  counts attempts by, so a retake linked in under a different title appears
 *  here in the stack it actually belongs to. */
function stackByLineage(
  snapshots: AdministeredTestSnapshotSummaryModel[],
  batches: GradingBatchModel[],
): TestStack[] {
  const grouped = new Map<string, AdministeredTestSnapshotSummaryModel[]>();
  for (const snapshot of snapshots) {
    const existing = grouped.get(snapshot.lineage_id);
    if (existing) existing.push(snapshot);
    else grouped.set(snapshot.lineage_id, [snapshot]);
  }

  return [...grouped.entries()]
    .map(([lineageId, printings]) => {
      const sorted = [...printings].sort(
        (left, right) => Date.parse(right.printed_at) - Date.parse(left.printed_at),
      );
      const ids = new Set(sorted.map((printing) => printing.id));
      const mine = batches.filter((batch) => ids.has(batch.snapshot_id));
      const sheets = mine.flatMap((batch) => batch.sheets);
      return {
        lineageId,
        // The earliest printing names the test -- the same rule the backend
        // uses -- so linking a retake in doesn't rename the stack.
        title: sorted[sorted.length - 1].title,
        printings: sorted,
        batches: mine,
        sheetCount: sheets.length,
        needsReviewCount: sheets.filter((sheet) => sheet.needs_review).length,
      };
    })
    .sort(
      (left, right) =>
        Date.parse(right.printings[0].printed_at) - Date.parse(left.printings[0].printed_at),
    );
}

/** The whole page: a list of tests, and a drill-down into one of them.
 *
 *  Scanning and reporting used to be top-level tabs, which meant the answer to
 *  "how did Unit 1 go" was spread over three pages, each with its own picker for
 *  choosing the test again. They are per-test views, so they live inside the
 *  test -- you pick the test once, on the way in. */
export default function AdministeredTestsWorkspace({
  onChanged,
}: AdministeredTestsWorkspaceProps = {}) {
  const [snapshots, setSnapshots] = useState<AdministeredTestSnapshotSummaryModel[]>([]);
  const [batches, setBatches] = useState<GradingBatchModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [busySnapshotId, setBusySnapshotId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  const [selectedLineageId, setSelectedLineageId] = useState<string | null>(null);
  const [drillTab, setDrillTab] = useState<DrillTab>("printings");
  const [openStacks, setOpenStacks] = useState<Record<string, boolean>>({});
  // null when closed; otherwise the bank test to preselect (null inside it means
  // "let the teacher pick").
  const [handOff, setHandOff] = useState<{ testId: string | null } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [snapshotResponse, batchResponse] = await Promise.all([
        listAdministeredTests(),
        listScanBatches(),
      ]);
      setSnapshots(snapshotResponse.items);
      setBatches(batchResponse.items);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
  }, [refresh]);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  const stacks = useMemo(() => stackByLineage(snapshots, batches), [snapshots, batches]);
  const selected = stacks.find((stack) => stack.lineageId === selectedLineageId) ?? null;

  // A relink can merge the open test into another one, taking its lineage id
  // with it. Follow the printing rather than dropping the teacher back to the
  // list with no explanation.
  useEffect(() => {
    if (!selectedLineageId || selected || snapshots.length === 0) return;
    setSelectedLineageId(null);
  }, [selectedLineageId, selected, snapshots.length]);

  /** Scan review edits and hand-offs both need the badges recomputed, on top of
   *  the shell's dirty flag. */
  const handleDataChanged = useCallback(() => {
    onChanged?.();
    void refresh();
  }, [onChanged, refresh]);

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

  /** The test paper renders as client-side paginated HTML and prints via
   *  "print this window" (see TestPrintPreview/printCurrentWindow), so it
   *  needs a dedicated window rather than sharing this one -- printing here
   *  would print the whole Administered Tests page around it. */
  async function handlePrintTest(snapshot: AdministeredTestSnapshotSummaryModel) {
    try {
      await openPaneWindow("test-preview", "Printable Test Preview", {
        snapshotId: snapshot.id,
        width: 1180,
        height: 920,
      });
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  /** Move every printing in a stack under another test's lineage, so a retake
   *  counts as a second attempt at that test instead of a separate test nobody
   *  ever passed. The whole stack moves: its printings are already the same
   *  test as each other. */
  async function handleLinkStack(stack: TestStack, targetLineageId: string) {
    if (targetLineageId === stack.lineageId) return;
    const target = snapshots.find((snapshot) => snapshot.lineage_id === targetLineageId);
    if (!target) return;

    setBusySnapshotId(stack.printings[0].id);
    try {
      for (const printing of stack.printings) {
        await relinkSnapshotLineage(printing.id, { lineageOfSnapshotId: target.id });
      }
      if (selectedLineageId === stack.lineageId) setSelectedLineageId(targetLineageId);
      await refresh();
      setStatusMessage(`Counted as attempts at "${target.title}".`);
      onChanged?.();
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusySnapshotId(null);
    }
  }

  /** Clear one printing's link, putting it back under its own title. */
  async function handleSeparatePrinting(printing: AdministeredTestSnapshotSummaryModel) {
    setBusySnapshotId(printing.id);
    try {
      await relinkSnapshotLineage(printing.id, {});
      await refresh();
      setStatusMessage(`"${printing.title}" is its own test again.`);
      onChanged?.();
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusySnapshotId(null);
    }
  }

  function openTest(stack: TestStack, tab: DrillTab) {
    setSelectedLineageId(stack.lineageId);
    setDrillTab(tab);
  }

  /** Response-sheet generation for one specific test. The pane covers every
   *  version of a lineage in a single run, so this is the whole job from here --
   *  no finishing one version and navigating off to start the next. */
  function openHandOff(stack: TestStack | null) {
    setHandOff({ testId: stack?.printings[0].source_test_id ?? null });
  }

  function renderPrintingCard(
    stack: TestStack,
    printing: AdministeredTestSnapshotSummaryModel,
    isLatest: boolean,
  ) {
    return (
      <article
        key={printing.id}
        className={`standards-record-card administered-test-card ${
          isLatest ? "" : "administered-test-earlier"
        }`}
      >
        <div>
          <strong>
            {printing.title === stack.title
              ? `Version ${printing.version}`
              : `${printing.title} - Version ${printing.version}`}
          </strong>
          <p>
            Printed {new Date(printing.printed_at).toLocaleString()}
            {printing.source_bank_title ? ` from "${printing.source_bank_title}"` : ""}
          </p>
          <p>
            {printing.total_points} pts - {printing.page_count} page
            {printing.page_count === 1 ? "" : "s"} -{" "}
            {printing.mode === "pre_id" ? "Pre-identified" : "Blank"}
          </p>
        </div>
        <div className="standards-import-actions">
          <button
            type="button"
            onClick={() =>
              void printPdfUrl(
                getSheetPdfUrl(printing.layout_id),
                `${printing.title} - Version ${printing.version}`,
              )
            }
          >
            Print...
          </button>
          <button
            type="button"
            disabled={busySnapshotId === printing.id}
            onClick={() => void handleSavePdf(printing)}
          >
            Save PDF...
          </button>
          <button
            type="button"
            title="Print or save the test paper itself, as it was printed -- not the response sheet"
            onClick={() => void handlePrintTest(printing)}
          >
            Print Test...
          </button>
          {printing.title !== stack.title ? (
            <button
              type="button"
              disabled={busySnapshotId === printing.id}
              title="Stop counting this printing as an attempt at this test -- it goes back to being its own test."
              onClick={() => void handleSeparatePrinting(printing)}
            >
              Separate
            </button>
          ) : null}
        </div>
      </article>
    );
  }

  if (handOff) {
    return (
      <div className="administered-tests-workspace">
        <div className="administered-test-handoff">
          <ResponseSheetPrintPane
            testId={handOff.testId}
            onClose={() => {
              setHandOff(null);
              handleDataChanged();
            }}
          />
        </div>
      </div>
    );
  }

  if (selected) {
    const attention = attentionOf(selected);
    return (
      <div className="administered-tests-workspace">
        <header className="standards-panel-header test-drill-header">
          <div>
            <button
              type="button"
              className="administered-test-stack-toggle"
              onClick={() => setSelectedLineageId(null)}
            >
              &larr; All tests
            </button>
            <h2>{selected.title}</h2>
            <div className="standards-header-summary">
              <span className="status-pill">
                {selected.printings.length} printing
                {selected.printings.length === 1 ? "" : "s"}
              </span>
              <span className="status-pill">
                {selected.sheetCount} sheet{selected.sheetCount === 1 ? "" : "s"} scanned
              </span>
              {attention === "needs_review" ? (
                <span className="status-pill error">
                  {selected.needsReviewCount} need review
                </span>
              ) : null}
              {attention === "awaiting_scans" ? (
                <span className="status-pill dirty">Waiting for scans</span>
              ) : null}
            </div>
          </div>
          <div className="standards-header-actions">
            {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
            <button type="button" onClick={() => openHandOff(selected)}>
              Create Response Sheets...
            </button>
          </div>
        </header>

        {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

        <nav className="gradebook-tabs test-drill-tabs" role="tablist">
          {(Object.keys(DRILL_TAB_LABEL) as DrillTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={drillTab === tab}
              className={drillTab === tab ? "active" : ""}
              onClick={() => setDrillTab(tab)}
            >
              {DRILL_TAB_LABEL[tab]}
              {tab === "scans" && selected.needsReviewCount > 0 ? (
                <span className="tab-badge">{selected.needsReviewCount}</span>
              ) : null}
            </button>
          ))}
        </nav>

        {drillTab === "printings" ? (
          <>
            {stacks.length > 1 ? (
              <label
                className="inline-select administered-test-lineage"
                title="A retake titled differently starts out as its own test. Point it at the original here and the gradebook counts it as a second attempt instead."
              >
                Counts as
                <select
                  value={selected.lineageId}
                  disabled={busySnapshotId !== null}
                  onChange={(event) => void handleLinkStack(selected, event.target.value)}
                >
                  {stacks.map((option) => (
                    <option key={option.lineageId} value={option.lineageId}>
                      {option.lineageId === selected.lineageId
                        ? `${option.title} (its own test)`
                        : `A retake of ${option.title}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="standards-record-list">
              {selected.printings.map((printing, index) =>
                renderPrintingCard(selected, printing, index === 0),
              )}
            </div>
          </>
        ) : null}

        {drillTab === "scans" ? (
          <ScanReviewWorkspace
            onChanged={handleDataChanged}
            snapshotIds={selected.printings.map((printing) => printing.id)}
            testTitle={selected.title}
          />
        ) : null}

        {drillTab === "report" ? (
          <GradeReportWorkspace
            lineageId={selected.lineageId}
            testTitle={selected.title}
            batches={selected.batches}
            printings={selected.printings}
          />
        ) : null}
      </div>
    );
  }

  const needsAttention = stacks.filter((stack) => attentionOf(stack) !== null);
  const settled = stacks.filter((stack) => attentionOf(stack) === null);

  function renderStackRow(stack: TestStack) {
    const attention = attentionOf(stack);
    const latest = stack.printings[0];
    const expanded = openStacks[stack.lineageId] ?? false;

    return (
      <div className="administered-test-stack" key={stack.lineageId}>
        <article
          className={`standards-record-card administered-test-card ${
            attention ? "needs-attention" : ""
          }`}
        >
          <div>
            <strong>{stack.title}</strong>
            <p>
              {stack.printings.length} printing{stack.printings.length === 1 ? "" : "s"} -{" "}
              {stack.printings.length === 1
                ? `version ${latest.version}`
                : `versions ${[...new Set(stack.printings.map((p) => p.version))].sort().join(", ")}`}{" "}
              - last printed {new Date(latest.printed_at).toLocaleDateString()}
            </p>
            <p className="administered-test-status">
              {attention === "needs_review"
                ? `${stack.needsReviewCount} of ${stack.sheetCount} scanned sheet${
                    stack.sheetCount === 1 ? "" : "s"
                  } still need review.`
                : attention === "awaiting_scans"
                  ? "Sheets printed. Nothing scanned back in yet."
                  : `${stack.sheetCount} sheet${stack.sheetCount === 1 ? "" : "s"} scanned and reviewed.`}
            </p>
            {stack.printings.length > 1 ? (
              <button
                type="button"
                className="administered-test-stack-toggle"
                onClick={() =>
                  setOpenStacks((current) => ({ ...current, [stack.lineageId]: !expanded }))
                }
              >
                {expanded ? "Hide printings" : "Show printings"}
              </button>
            ) : null}
          </div>
          <div className="standards-import-actions">
            {/* The action this test is actually waiting on comes first and reads
                as the primary button -- that is the whole point of surfacing it. */}
            {attention === "needs_review" ? (
              <button type="button" onClick={() => openTest(stack, "scans")}>
                Review {stack.needsReviewCount} sheet{stack.needsReviewCount === 1 ? "" : "s"}
              </button>
            ) : attention === "awaiting_scans" ? (
              <button type="button" onClick={() => openTest(stack, "scans")}>
                Enter Scans...
              </button>
            ) : (
              <button type="button" onClick={() => openTest(stack, "report")}>
                View Report
              </button>
            )}
            <button type="button" onClick={() => openTest(stack, "printings")}>
              Open
            </button>
            <button
              type="button"
              title="Print more response sheets for this test -- every version in one run."
              onClick={() => openHandOff(stack)}
            >
              Create Response Sheets...
            </button>
          </div>
        </article>

        {expanded
          ? stack.printings.map((printing, index) =>
              renderPrintingCard(stack, printing, index === 0),
            )
          : null}
      </div>
    );
  }

  return (
    <div className="administered-tests-workspace">
      <header className="standards-panel-header">
        <div>
          <h2>Tests</h2>
          <p>
            Each test is a frozen record of exactly what was printed and handed to students --
            editing the bank's test afterward never changes one. Open a test to scan its sheets,
            review them, and read its results.
          </p>
        </div>
        <div className="standards-header-actions">
          {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
          <button type="button" onClick={() => openHandOff(null)}>
            Create Response Sheets...
          </button>
        </div>
      </header>

      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}
      {loading && stacks.length === 0 ? <p>Loading...</p> : null}
      {!loading && stacks.length === 0 ? (
        <p>
          No tests have been printed into this gradebook yet. Use "Create Response Sheets..."
          above, or the same button in a bank's Test Builder, to hand one off. A bank has to be
          open for its tests to be listed.
        </p>
      ) : null}

      {needsAttention.length > 0 ? (
        <section className="test-attention-group">
          <h3>
            Needs you ({needsAttention.length} test{needsAttention.length === 1 ? "" : "s"})
          </h3>
          <div className="standards-record-list">{needsAttention.map(renderStackRow)}</div>
        </section>
      ) : null}

      {settled.length > 0 ? (
        <section className="test-attention-group">
          {needsAttention.length > 0 ? <h3>Done</h3> : null}
          <div className="standards-record-list">{settled.map(renderStackRow)}</div>
        </section>
      ) : null}
    </div>
  );
}
