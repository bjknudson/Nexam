import { useEffect, useMemo, useState } from "react";

import { fetchScoresCsv, getMasterySettings, listStudents, setDefaultMasterySettings } from "./api";
import { isDesktopShell, saveBytesDialog } from "./desktop";
import MasteryModePicker, { CALCULATION_LABEL, REPORTING_LABEL } from "./MasteryModePicker";
import type {
  GradebookMasteryConfigModel,
  MasteryCalculation,
  MasteryReporting,
  RetakeResolution,
  ScoreExportMethod,
} from "./types";

const EXPORT_METHOD_LABEL: Record<ScoreExportMethod, string> = {
  total: "Total score per test",
  by_standard: "Score broken out by standard",
  mastery: "Mastery level per standard",
};

const EXPORT_METHOD_HELP: Record<ScoreExportMethod, string> = {
  total: "One column pair -- points and percent -- per test, plus an overall percent.",
  by_standard: "One percent column per standard: points earned over points possible.",
  mastery:
    "One column per standard, as a mastery level rather than a percentage -- how far up the ladder the evidence reaches.",
};

const RESOLUTION_LABEL: Record<RetakeResolution, string> = {
  most_recent: "Most recent attempt",
  highest: "Highest attempt",
  average: "Average of attempts",
};

const RESOLUTION_HELP: Record<RetakeResolution, string> = {
  most_recent: "A retake replaces the first try.",
  highest: "The student's best sitting counts.",
  average: "The attempts' percentages are averaged.",
};

/** Exporting is the one gradebook task that is inherently *cross*-test, which
 *  is why it stays a page of its own while per-test reporting moved into each
 *  test's own drill-down. */
export default function ScoreExportWorkspace() {
  const [method, setMethod] = useState<ScoreExportMethod>("total");
  const [resolution, setResolution] = useState<RetakeResolution>("most_recent");
  const [section, setSection] = useState("");
  const [sections, setSections] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [mastery, setMastery] = useState<GradebookMasteryConfigModel | null>(null);

  // Offer only sections the roster actually uses, so the filter can never
  // produce an empty file by naming one that doesn't exist.
  useEffect(() => {
    listStudents()
      .then((response) =>
        setSections(
          Array.from(
            new Set(
              response.items
                .map((student) => (student.section ?? "").trim())
                .filter((value) => value.length > 0),
            ),
          ).sort(),
        ),
      )
      .catch(() => setSections([]));
  }, []);

  useEffect(() => {
    getMasterySettings()
      .then(setMastery)
      .catch(() => setMastery(null));
  }, []);

  async function handleMasteryChange(next: {
    calculation?: MasteryCalculation;
    reporting?: MasteryReporting;
  }) {
    setBusy(true);
    try {
      setMastery(await setDefaultMasterySettings(next));
      setStatusMessage("Mastery default saved.");
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

  const fileLabel = useMemo(() => (section ? `${section} only` : "Whole roster"), [section]);

  /** Same route as the response-sheet PDFs take: `<a download>` is inert inside
   *  the macOS webview, so the bytes go through the shell's save dialog there
   *  and through an object URL in a browser tab. */
  async function handleExportCsv() {
    setBusy(true);
    setErrorMessage("");
    try {
      const { csv, filename } = await fetchScoresCsv({
        method,
        resolution,
        section: section || null,
      });

      const bytes = new TextEncoder().encode(csv);
      if (isDesktopShell()) {
        const savedTo = await saveBytesDialog(bytes, { suggestedFileName: filename });
        setStatusMessage(savedTo ? `Saved to ${savedTo}` : "Save cancelled.");
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
        setStatusMessage("Downloaded.");
      }
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
          <h2>Export</h2>
          <p>
            Every test in this gradebook, as one CSV -- one row per student, one column per test or
            per standard.
          </p>
        </div>
        {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
      </header>

      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

      <section className="standards-panel score-export-panel">
        <div className="score-export-controls">
          <label>
            What to export
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value as ScoreExportMethod)}
            >
              {(Object.keys(EXPORT_METHOD_LABEL) as ScoreExportMethod[]).map((option) => (
                <option key={option} value={option}>
                  {EXPORT_METHOD_LABEL[option]}
                </option>
              ))}
            </select>
          </label>

          <label title={RESOLUTION_HELP[resolution]}>
            When a student retook a test
            <select
              value={resolution}
              onChange={(event) => setResolution(event.target.value as RetakeResolution)}
            >
              {(Object.keys(RESOLUTION_LABEL) as RetakeResolution[]).map((option) => (
                <option key={option} value={option}>
                  {RESOLUTION_LABEL[option]}
                </option>
              ))}
            </select>
          </label>

          <label>
            Section
            <select
              value={section}
              onChange={(event) => setSection(event.target.value)}
              disabled={sections.length === 0}
            >
              <option value="">All sections</option>
              {sections.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="score-export-help">{EXPORT_METHOD_HELP[method]}</p>
        {method === "mastery" && mastery ? (
          <p className="score-export-help">
            Exported under <strong>{CALCULATION_LABEL[mastery.default.calculation]}</strong>,{" "}
            {REPORTING_LABEL[mastery.default.reporting].toLowerCase()} -- except for tests set
            apart below, which keep their own. The filename records the calculation, so two
            exports of the same students under different modes stay tellable apart.
          </p>
        ) : null}
        <p className="score-export-help">
          {RESOLUTION_HELP[resolution]} Students with no scored sheets are still exported, with
          empty cells. Standard codes come from the open bank when there is one; otherwise columns
          are labelled with standard ids.
        </p>

        <div className="standards-import-actions">
          <button type="button" disabled={busy} onClick={() => void handleExportCsv()}>
            Export CSV ({fileLabel})
          </button>
        </div>
      </section>

      <section className="standards-panel">
        <h3>How mastery is calculated</h3>
        <p>
          Mastery is reported as a <strong>level</strong>, not a percentage: 2.5 means Level 2
          cleared and halfway through Level 3. Levels are numbered like question difficulty -- a
          question's difficulty is the level it gives evidence about. This is the gradebook-wide
          default; a test that needs a different reading can be set apart in its own Report tab.
        </p>
        {mastery ? (
          <>
            <MasteryModePicker
              settings={mastery.default}
              busy={busy}
              onChange={(next) => void handleMasteryChange(next)}
            />
            {Object.keys(mastery.by_lineage).length > 0 ? (
              <p className="score-export-help">
                {Object.keys(mastery.by_lineage).length} test
                {Object.keys(mastery.by_lineage).length === 1 ? " is" : "s are"} set apart from this
                default and will not follow changes made here.
              </p>
            ) : null}
          </>
        ) : (
          <p>Loading...</p>
        )}
      </section>
    </div>
  );
}
