import { useEffect, useState } from "react";

import { createAdministeredTest, getSheetPdfUrl, listStudents, listTestDrafts } from "./api";
import {
  isDesktopShell,
  openGradebookWindow,
  printPdfUrl,
  saveBytesDialog,
} from "./desktop";
import type {
  AdministeredTestSnapshotModel,
  SheetPageSize,
  StudentModel,
  TestDraftDetailModel,
} from "./types";

const PANE_SYNC_CHANNEL = "nexzam-pane-sync";

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
  const [pageSize, setPageSize] = useState<SheetPageSize>("letter");
  const [sectionFilter, setSectionFilter] = useState("");
  const [groupingFilter, setGroupingFilter] = useState("");
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

  // Generating for one class at a time is the common case, so the roster is
  // narrowed before it is shown rather than leaving the teacher to hunt.
  const sections = [...new Set(students.map((s) => s.section).filter(Boolean))] as string[];
  const groupings = [...new Set(students.map((s) => s.grouping).filter(Boolean))] as string[];
  const visibleStudents = students.filter(
    (student) =>
      (!sectionFilter || student.section === sectionFilter) &&
      (!groupingFilter || student.grouping === groupingFilter),
  );

  function toggleStudent(studentId: string) {
    setSelectedStudentIds((current) =>
      current.includes(studentId) ? current.filter((id) => id !== studentId) : [...current, studentId],
    );
  }

  async function recheckGradebook() {
    try {
      const studentResponse = await listStudents();
      setStudents(studentResponse.items);
      setNoGradebookOpen(false);
      setErrorMessage("");
    } catch {
      setNoGradebookOpen(true);
    }
  }

  async function handleGenerate() {
    if (!selectedTest) return;
    setGenerating(true);
    setErrorMessage("");
    try {
      const created = await createAdministeredTest({
        testId: selectedTest.test.id,
        mode,
        pageSize,
        blankCount: mode === "blank" ? blankCount : null,
        studentIds: mode === "pre_id" ? selectedStudentIds : null,
      });
      setSnapshot(created);
      setNoGradebookOpen(false);
      // The gradebook lives in its own window, so tell it a test just landed --
      // otherwise the hand-off looks like it did nothing over there.
      try {
        const channel = new BroadcastChannel(PANE_SYNC_CHANNEL);
        channel.postMessage({ type: "gradebook-data-changed" });
        channel.close();
      } catch {
        // BroadcastChannel is a convenience here, never a requirement.
      }
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
        <div className="gradebook-error response-sheet-no-gradebook">
          <p>
            No gradebook is open. Response sheets are handed off into a gradebook, so open or
            create one first.
          </p>
          <div className="response-sheet-no-gradebook-actions">
            <button
              type="button"
              onClick={() => {
                openGradebookWindow().catch((error) =>
                  setErrorMessage((error as Error).message),
                );
              }}
            >
              Open Gradebook...
            </button>
            <button type="button" onClick={() => void recheckGradebook()}>
              I opened one - check again
            </button>
          </div>
        </div>
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

            <label
              title={
                "Half sheet fits two to a page without shrinking anything -- the " +
                "bubbles stay the size the scanner reads best. Good for a test " +
                "that is mostly multiple choice."
              }
            >
              Sheet size
              <select
                value={pageSize}
                onChange={(event) => setPageSize(event.target.value as SheetPageSize)}
              >
                <option value="letter">Letter (8.5 x 11)</option>
                <option value="half_letter">Half sheet (5.5 x 8.5) - two per page</option>
                <option value="legal">Legal (8.5 x 14)</option>
                <option value="a4">A4</option>
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

              {sections.length > 0 || groupings.length > 0 ? (
                <div className="response-sheet-roster-filters">
                  {sections.length > 0 ? (
                    <label>
                      Section
                      <select
                        value={sectionFilter}
                        onChange={(event) => setSectionFilter(event.target.value)}
                      >
                        <option value="">All sections</option>
                        {sections.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {groupings.length > 0 ? (
                    <label>
                      Group
                      <select
                        value={groupingFilter}
                        onChange={(event) => setGroupingFilter(event.target.value)}
                      >
                        <option value="">All groups</option>
                        {groupings.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}

              {visibleStudents.length > 0 ? (
                <div className="response-sheet-select-all">
                  <span>
                    {visibleStudents.filter((s) => selectedStudentIds.includes(s.id)).length} of{" "}
                    {visibleStudents.length} selected
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const visibleIds = visibleStudents.map((student) => student.id);
                      const allShown = visibleIds.every((id) => selectedStudentIds.includes(id));
                      // Select-all applies to what is on screen, and leaves any
                      // selection from another section alone.
                      setSelectedStudentIds((current) =>
                        allShown
                          ? current.filter((id) => !visibleIds.includes(id))
                          : [...new Set([...current, ...visibleIds])],
                      );
                    }}
                  >
                    {visibleStudents.every((s) => selectedStudentIds.includes(s.id))
                      ? "Clear these"
                      : "Select all shown"}
                  </button>
                </div>
              ) : null}
              {visibleStudents.map((student) => (
                <label key={student.id} className="standards-list-row">
                  <input
                    type="checkbox"
                    checked={selectedStudentIds.includes(student.id)}
                    onChange={() => toggleStudent(student.id)}
                  />
                  {student.first_name} {student.last_name}
                  {student.section || student.grouping ? (
                    <span className="response-sheet-student-tag">
                      {[student.section, student.grouping].filter(Boolean).join(" - ")}
                    </span>
                  ) : null}
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
                <button
                  type="button"
                  onClick={() =>
                    void printPdfUrl(
                      getSheetPdfUrl(snapshot.layout.id),
                      `${snapshot.title} - Version ${snapshot.version}`,
                    )
                  }
                >
                  Print...
                </button>
                <button type="button" onClick={() => void handleSavePdf()}>
                  Save PDF...
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
