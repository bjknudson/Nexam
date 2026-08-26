import { useEffect, useState } from "react";

import { createAdministeredTest, getSheetPdfUrl, listStudents, listTestDrafts } from "./api";
import { isDesktopShell, saveBytesDialog } from "./desktop";
import type { AdministeredTestSnapshotModel, StudentModel, TestDraftDetailModel } from "./types";

interface ResponseSheetPrintPaneProps {
  testId: string | null;
  onClose: () => void;
}

/** The hand-off: prints response sheets for a bank test into whichever
 *  gradebook is currently open (in any window, on the same shared backend).
 *  Requires a gradebook to already be open -- see docs/grading.md. */
export default function ResponseSheetPrintPane({ testId, onClose }: ResponseSheetPrintPaneProps) {
  const desktopMode = isDesktopShell();
  const [tests, setTests] = useState<TestDraftDetailModel[]>([]);
  const [students, setStudents] = useState<StudentModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [noGradebookOpen, setNoGradebookOpen] = useState(false);

  const [mode, setMode] = useState<"blank" | "pre_id">("blank");
  const [blankCount, setBlankCount] = useState(1);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [snapshot, setSnapshot] = useState<AdministeredTestSnapshotModel | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const testResponse = await listTestDrafts();
        setTests(testResponse.items);
      } catch (error) {
        setErrorMessage((error as Error).message);
      }
      try {
        const studentResponse = await listStudents();
        setStudents(studentResponse.items);
      } catch {
        // No gradebook open yet -- surfaced when the teacher tries to generate.
        setNoGradebookOpen(true);
      }
      setLoading(false);
    })();
  }, []);

  const selectedTest = tests.find((item) => item.test.id === testId) ?? tests[0] ?? null;

  function toggleStudent(studentId: string) {
    setSelectedStudentIds((current) =>
      current.includes(studentId) ? current.filter((id) => id !== studentId) : [...current, studentId],
    );
  }

  async function handleGenerate() {
    if (!selectedTest) return;
    setGenerating(true);
    setErrorMessage("");
    try {
      const created = await createAdministeredTest({
        testId: selectedTest.test.id,
        mode,
        blankCount: mode === "blank" ? blankCount : null,
        studentIds: mode === "pre_id" ? selectedStudentIds : null,
      });
      setSnapshot(created);
      setNoGradebookOpen(false);
    } catch (error) {
      const message = (error as Error).message;
      setErrorMessage(message);
      if (/no gradebook/i.test(message)) setNoGradebookOpen(true);
    } finally {
      setGenerating(false);
    }
  }

  async function handleSavePdf() {
    if (!snapshot) return;
    try {
      const response = await fetch(getSheetPdfUrl(snapshot.layout.id));
      if (!response.ok) throw new Error("Could not download the generated PDF.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      await saveBytesDialog(bytes, {
        suggestedFileName: `${snapshot.title}-${snapshot.version}-response-sheet.pdf`,
      });
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  return (
    <div className="pane-window-shell response-sheet-print-pane">
      <header className="standards-panel-header">
        <div>
          <h2>Create Response Sheets</h2>
          <p>Hands this test off to whichever gradebook is currently open. See docs/grading.md.</p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {loading ? <p>Loading...</p> : null}
      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}
      {noGradebookOpen ? (
        <p className="gradebook-error">
          No gradebook is currently open. Open or create one from the main window's "Open
          Gradebook" button, then try again.
        </p>
      ) : null}

      {!loading && selectedTest ? (
        <section className="standards-panel">
          <p>
            <strong>{selectedTest.test.title}</strong> - Version {selectedTest.test.version}
          </p>

          <div className="standards-import-grid">
            <label>
              Mode
              <select value={mode} onChange={(event) => setMode(event.target.value as "blank" | "pre_id")}>
                <option value="blank">Blank (name written in by hand)</option>
                <option value="pre_id">Pre-identified from roster</option>
              </select>
            </label>

            {mode === "blank" ? (
              <label>
                Number of copies
                <input
                  type="number"
                  min={1}
                  value={blankCount}
                  onChange={(event) => setBlankCount(Math.max(1, Number(event.target.value) || 1))}
                />
              </label>
            ) : null}
          </div>

          {mode === "pre_id" ? (
            <div className="standards-record-list compact">
              {students.length === 0 ? <p>No students in the open gradebook's roster yet.</p> : null}
              {students.map((student) => (
                <label key={student.id} className="standards-list-row">
                  <input
                    type="checkbox"
                    checked={selectedStudentIds.includes(student.id)}
                    onChange={() => toggleStudent(student.id)}
                  />
                  {student.first_name} {student.last_name}
                </label>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={
              generating || (mode === "pre_id" && selectedStudentIds.length === 0)
            }
          >
            {generating ? "Generating..." : "Generate"}
          </button>

          {snapshot ? (
            <div className="response-sheet-print-result">
              <p>
                Generated {snapshot.layout.pages.length} page
                {snapshot.layout.pages.length === 1 ? "" : "s"} into the open gradebook.
              </p>
              <div className="standards-import-actions">
                <a
                  className="button-like"
                  href={getSheetPdfUrl(snapshot.layout.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download PDF
                </a>
                {desktopMode ? (
                  <button type="button" onClick={() => void handleSavePdf()}>
                    Save PDF...
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
