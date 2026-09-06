import { useEffect, useMemo, useState } from "react";

import {
  createAdministeredTest,
  createResponseSheetBatch,
  getResponseSheetBatchPdfUrl,
  getSheetPdfUrl,
  listStudents,
  listTestDrafts,
} from "./api";
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

const PANE_SYNC_CHANNEL = "nexam-pane-sync";

type AssignableField = "section" | "grouping" | "external_id";

interface ResponseSheetPrintPaneProps {
  testId: string | null;
  onClose: () => void;
}

function lineageKeyFor(title: string): string {
  return title.trim().toLowerCase();
}

function broadcastGradebookChanged() {
  // The gradebook lives in its own window, so tell it a test just landed --
  // otherwise the hand-off looks like it did nothing over there.
  try {
    const channel = new BroadcastChannel(PANE_SYNC_CHANNEL);
    channel.postMessage({ type: "gradebook-data-changed" });
    channel.close();
  } catch {
    // BroadcastChannel is a convenience here, never a requirement.
  }
}

/** The hand-off: prints response sheets for a bank test into whichever
 *  gradebook is currently open (in any window, on the same shared backend).
 *  Requires a gradebook to already be open -- see docs/grading.md.
 *
 *  Only finished tests are eligible: version bubbles come from the finished
 *  siblings sharing this test's title, so an abandoned same-titled draft can
 *  never leak in as a phantom version. */
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

  const [selectedLineageKey, setSelectedLineageKey] = useState<string | null>(null);
  const [blankCounts, setBlankCounts] = useState<Record<string, number>>({});
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [assignField, setAssignField] = useState<AssignableField>("section");
  const [assignFieldValue, setAssignFieldValue] = useState("");
  const [assignFieldVersion, setAssignFieldVersion] = useState("");
  const [batchSnapshots, setBatchSnapshots] = useState<AdministeredTestSnapshotModel[]>([]);

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

  // Only finished tests are ever offered: an unfinished same-titled draft is
  // often a leftover copy, not a real sibling version.
  const lineageOptions = useMemo(() => {
    const groups = new Map<string, TestDraftDetailModel[]>();
    for (const item of tests) {
      if (!item.test.finished) continue;
      const key = lineageKeyFor(item.test.title);
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => ({
      key,
      title: group[0].test.title,
      versions: [...group].sort((a, b) => a.test.version.localeCompare(b.test.version)),
    }));
  }, [tests]);

  useEffect(() => {
    if (selectedLineageKey && lineageOptions.some((option) => option.key === selectedLineageKey)) {
      return;
    }
    const requestedTest = tests.find((item) => item.test.id === testId);
    const preferredKey = requestedTest?.test.finished
      ? lineageKeyFor(requestedTest.test.title)
      : null;
    const preferredOption = preferredKey
      ? lineageOptions.find((option) => option.key === preferredKey) ?? null
      : null;
    const fallback = preferredOption ?? lineageOptions[0] ?? null;
    setSelectedLineageKey(fallback?.key ?? null);
  }, [lineageOptions, testId, tests, selectedLineageKey]);

  const selectedLineage = lineageOptions.find((option) => option.key === selectedLineageKey) ?? null;
  const versions = selectedLineage?.versions ?? [];
  const isMultiVersion = versions.length > 1;

  useEffect(() => {
    setAssignments({});
    setBlankCounts({});
  }, [selectedLineageKey]);

  useEffect(() => {
    if (versions.length > 0 && !versions.some((item) => item.test.version === assignFieldVersion)) {
      setAssignFieldVersion(versions[0].test.version);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions]);

  // The single version this lineage has, or the version any batch call is
  // anchored to when hitting the response-sheets/batch endpoint.
  const primaryTest = versions[0] ?? null;
  const singleVersionTest = !isMultiVersion ? versions[0] ?? null : null;

  // Generating for one class at a time is the common case, so the roster is
  // narrowed before it is shown rather than leaving the teacher to hunt.
  const sections = [...new Set(students.map((s) => s.section).filter(Boolean))] as string[];
  const groupings = [...new Set(students.map((s) => s.grouping).filter(Boolean))] as string[];
  const visibleStudents = students.filter(
    (student) =>
      (!sectionFilter || student.section === sectionFilter) &&
      (!groupingFilter || student.grouping === groupingFilter),
  );
  const assignFieldValues = [
    ...new Set(visibleStudents.map((student) => student[assignField]).filter(Boolean)),
  ] as string[];
  const unassignedCount = visibleStudents.filter((student) => !assignments[student.id]).length;
  const assignedVisibleCount = visibleStudents.length - unassignedCount;
  const totalBlankCount = Object.values(blankCounts).reduce((sum, count) => sum + (count || 0), 0);

  function toggleStudent(studentId: string) {
    setSelectedStudentIds((current) =>
      current.includes(studentId) ? current.filter((id) => id !== studentId) : [...current, studentId],
    );
  }

  function setAssignment(studentId: string, version: string) {
    setAssignments((current) => {
      const next = { ...current };
      if (next[studentId] === version) {
        delete next[studentId];
      } else {
        next[studentId] = version;
      }
      return next;
    });
  }

  function applyAssignByField() {
    if (!assignFieldValue || !assignFieldVersion) return;
    setAssignments((current) => {
      const next = { ...current };
      for (const student of visibleStudents) {
        if (student[assignField] === assignFieldValue) {
          next[student.id] = assignFieldVersion;
        }
      }
      return next;
    });
  }

  function randomizeRemaining() {
    const unassigned = visibleStudents.filter((student) => !assignments[student.id]);
    if (unassigned.length === 0 || versions.length === 0) return;
    const shuffled = [...unassigned].sort(() => Math.random() - 0.5);
    setAssignments((current) => {
      const next = { ...current };
      shuffled.forEach((student, index) => {
        next[student.id] = versions[index % versions.length].test.version;
      });
      return next;
    });
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
    const target = singleVersionTest;
    if (!target) return;
    setGenerating(true);
    setErrorMessage("");
    try {
      const created = await createAdministeredTest({
        testId: target.test.id,
        mode,
        pageSize,
        blankCount: mode === "blank" ? blankCount : null,
        studentIds: mode === "pre_id" ? selectedStudentIds : null,
      });
      setSnapshot(created);
      setNoGradebookOpen(false);
      broadcastGradebookChanged();
    } catch (error) {
      const message = (error as Error).message;
      setErrorMessage(message);
      if (/no gradebook/i.test(message)) setNoGradebookOpen(true);
    } finally {
      setGenerating(false);
    }
  }

  async function handleGenerateBatch() {
    if (!primaryTest) return;
    setGenerating(true);
    setErrorMessage("");
    try {
      const assignmentPayload =
        mode === "blank"
          ? versions
              .map((item) => ({ version: item.test.version, blank_count: blankCounts[item.test.version] }))
              .filter((entry) => (entry.blank_count ?? 0) > 0)
          : (() => {
              const studentIdsByVersion = new Map<string, string[]>();
              for (const student of visibleStudents) {
                const version = assignments[student.id];
                if (!version) continue;
                const list = studentIdsByVersion.get(version) ?? [];
                list.push(student.id);
                studentIdsByVersion.set(version, list);
              }
              return [...studentIdsByVersion.entries()].map(([version, student_ids]) => ({
                version,
                student_ids,
              }));
            })();

      const result = await createResponseSheetBatch({
        testId: primaryTest.test.id,
        mode,
        pageSize,
        assignments: assignmentPayload,
      });
      setBatchSnapshots(result.items);
      setNoGradebookOpen(false);
      broadcastGradebookChanged();
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

  async function handleSaveBatchPdf() {
    const batchId = batchSnapshots[0]?.generation_batch_id;
    if (!batchId) return;
    try {
      const response = await fetch(getResponseSheetBatchPdfUrl(batchId));
      if (!response.ok) throw new Error("Could not download the generated PDF.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      await saveBytesDialog(bytes, {
        suggestedFileName: `${batchSnapshots[0]?.title ?? "response-sheets"}-batch.pdf`,
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

      {!loading && lineageOptions.length === 0 ? (
        <p className="response-sheet-no-gradebook">
          No finished tests are available yet. Finish a test in the Bank before creating response
          sheets for it.
        </p>
      ) : null}

      {!loading && selectedLineage ? (
        <section className="standards-panel">
          <label>
            Test
            <select
              value={selectedLineage.key}
              onChange={(event) => setSelectedLineageKey(event.target.value)}
            >
              {lineageOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.title} ({option.versions.map((item) => item.test.version).join("/")})
                </option>
              ))}
            </select>
          </label>
          <p>
            <strong>{selectedLineage.title}</strong>
            {isMultiVersion
              ? ` - versions ${versions.map((item) => item.test.version).join(", ")}`
              : ` - Version ${versions[0]?.test.version ?? ""}`}
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

            {mode === "blank" && !isMultiVersion ? (
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

          {mode === "blank" && isMultiVersion ? (
            <div className="response-sheet-version-assignment">
              <p>Copies per version -- fill-in-name sheets can be pre-versioned too.</p>
              <table className="response-sheet-assignment-grid">
                <thead>
                  <tr>
                    {versions.map((item) => (
                      <th key={item.test.version}>Version {item.test.version}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {versions.map((item) => (
                      <td key={item.test.version}>
                        <input
                          type="number"
                          min={0}
                          value={blankCounts[item.test.version] ?? 0}
                          onChange={(event) =>
                            setBlankCounts((current) => ({
                              ...current,
                              [item.test.version]: Math.max(0, Number(event.target.value) || 0),
                            }))
                          }
                        />
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}

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

              {isMultiVersion ? (
                <div className="response-sheet-version-assignment">
                  <div className="response-sheet-assign-by-field">
                    <span>Assign by</span>
                    <select
                      value={assignField}
                      onChange={(event) => {
                        setAssignField(event.target.value as AssignableField);
                        setAssignFieldValue("");
                      }}
                    >
                      <option value="section">Section</option>
                      <option value="grouping">Group</option>
                      <option value="external_id">Student ID</option>
                    </select>
                    <select
                      value={assignFieldValue}
                      onChange={(event) => setAssignFieldValue(event.target.value)}
                    >
                      <option value="">Choose a value</option>
                      {assignFieldValues.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                    <span>to version</span>
                    <select
                      value={assignFieldVersion}
                      onChange={(event) => setAssignFieldVersion(event.target.value)}
                    >
                      {versions.map((item) => (
                        <option key={item.test.version} value={item.test.version}>
                          {item.test.version}
                        </option>
                      ))}
                    </select>
                    <button type="button" onClick={applyAssignByField} disabled={!assignFieldValue}>
                      Assign matching students
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={randomizeRemaining}
                    disabled={unassignedCount === 0}
                  >
                    Randomize remaining ({unassignedCount})
                  </button>
                </div>
              ) : null}

              {visibleStudents.length > 0 && !isMultiVersion ? (
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

              {isMultiVersion ? (
                <table className="response-sheet-assignment-grid">
                  <thead>
                    <tr>
                      <th>Student</th>
                      {versions.map((item) => (
                        <th key={item.test.version}>{item.test.version}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleStudents.map((student) => (
                      <tr key={student.id}>
                        <td>
                          {student.first_name} {student.last_name}
                          {student.section || student.grouping ? (
                            <span className="response-sheet-student-tag">
                              {[student.section, student.grouping].filter(Boolean).join(" - ")}
                            </span>
                          ) : null}
                        </td>
                        {versions.map((item) => (
                          <td key={item.test.version}>
                            <input
                              type="checkbox"
                              checked={assignments[student.id] === item.test.version}
                              onChange={() => setAssignment(student.id, item.test.version)}
                              aria-label={`Assign ${student.first_name} ${student.last_name} to version ${item.test.version}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                visibleStudents.map((student) => (
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
                ))
              )}

              {isMultiVersion && unassignedCount > 0 ? (
                <p className="response-sheet-partial-roster-warning">
                  {assignedVisibleCount === 0
                    ? "No students have a version assigned yet."
                    : `${unassignedCount} of ${visibleStudents.length} students don't have a version assigned and won't get a sheet in this batch. That's fine if you're only printing for some students right now.`}
                </p>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void (isMultiVersion ? handleGenerateBatch() : handleGenerate())}
            disabled={
              generating ||
              (mode === "pre_id" && isMultiVersion && assignedVisibleCount === 0) ||
              (mode === "blank" && isMultiVersion && totalBlankCount === 0) ||
              (mode === "pre_id" && !isMultiVersion && selectedStudentIds.length === 0)
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

          {batchSnapshots.length > 0 ? (
            <div className="response-sheet-print-result">
              <p>
                Generated {batchSnapshots.reduce((sum, item) => sum + item.layout.pages.length, 0)}{" "}
                pages across versions {batchSnapshots.map((item) => item.version).join(", ")} into
                the open gradebook.
              </p>
              <div className="standards-import-actions">
                {batchSnapshots[0]?.generation_batch_id ? (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        void printPdfUrl(
                          getResponseSheetBatchPdfUrl(batchSnapshots[0].generation_batch_id as string),
                          `${batchSnapshots[0].title} - all versions`,
                        )
                      }
                    >
                      Print All...
                    </button>
                    <button type="button" onClick={() => void handleSaveBatchPdf()}>
                      Save PDF...
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
