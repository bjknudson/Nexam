import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  createStudent,
  deleteStudent,
  getStudentPerformance,
  listStudents,
  saveGradebook,
  updateStudent,
} from "./api";
import type {
  MasteryCalculation,
  MasteryResultModel,
  RetakeResolution,
  StudentLineagePerformanceModel,
  StudentModel,
  StudentPerformanceModel,
} from "./types";

interface RosterWorkspaceProps {
  /** Called after a mutation that isn't already followed by its own save
   *  (currently: removing a student), so the gradebook shell can mark itself
   *  dirty. */
  onChanged?: () => void;
  /** Called right after this workspace's own saveGradebook() calls succeed,
   *  so the gradebook shell can clear a dirty flag from some other page. */
  onSaved?: () => void;
}

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

function fullName(student: StudentModel): string {
  return `${student.first_name} ${student.last_name}`;
}

function percent(value: number): string {
  return `${value.toFixed(0)}%`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

/** A percentage as a bar, so a column of standards can be scanned at a glance
 *  instead of read number by number. The number stays next to it -- the bar is
 *  the shape, not the value. */
function PercentBar({ value, label }: { value: number; label?: string }) {
  return (
    <div className="performance-bar" title={label ?? `${value.toFixed(1)}%`}>
      <div className="performance-bar-track">
        <div className="performance-bar-fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="performance-bar-value">{percent(value)}</span>
    </div>
  );
}

function TestsTakenTable({ lineages }: { lineages: StudentLineagePerformanceModel[] }) {
  if (lineages.length === 0) {
    return <p>No scored sheets for this student yet.</p>;
  }

  return (
    <table className="scan-review-table">
      <thead>
        <tr>
          <th>Test</th>
          <th>Taken</th>
          <th>Points</th>
          <th>Score</th>
        </tr>
      </thead>
      <tbody>
        {lineages.map((lineage) => {
          const counted = new Set(lineage.resolved.source_attempt_numbers);
          const isRetake = lineage.attempts.length > 1;
          return (
            <Fragment key={lineage.lineage_id}>
              <tr className="performance-lineage-row">
                <td>
                  <strong>{lineage.test_title}</strong>
                  {isRetake ? (
                    <span className="status-pill">{lineage.attempts.length} attempts</span>
                  ) : null}
                </td>
                <td>{formatDate(lineage.attempts[lineage.attempts.length - 1].printed_at)}</td>
                <td>
                  {lineage.resolved.points_earned.toFixed(1)} /{" "}
                  {lineage.resolved.points_possible.toFixed(1)}
                </td>
                <td>
                  <PercentBar value={lineage.resolved.percent_correct} />
                </td>
              </tr>
              {/* Only worth listing the individual sittings when there is more
                  than one -- otherwise the row above already is the attempt. */}
              {isRetake
                ? lineage.attempts.map((attempt) => (
                    <tr
                      key={attempt.sheet_id}
                      className={`performance-attempt-row ${
                        counted.has(attempt.attempt_number) ? "counted" : "superseded"
                      }`}
                    >
                      <td>
                        Attempt {attempt.attempt_number} &middot; version {attempt.version}
                        {counted.has(attempt.attempt_number) ? null : (
                          <span className="performance-superseded-note">not counted</span>
                        )}
                      </td>
                      <td>{formatDate(attempt.printed_at)}</td>
                      <td>
                        {attempt.points_earned.toFixed(1)} / {attempt.points_possible.toFixed(1)}
                      </td>
                      <td>{percent(attempt.percent_correct)}</td>
                    </tr>
                  ))
                : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

const CALCULATION_LABEL: Record<MasteryCalculation, string> = {
  level_ladder: "Level Ladder",
  difficulty_weighted: "Difficulty Weighted",
  rubric_levels: "Rubric Levels",
};

/** A mastery level, which is a different quantity from a percentage: "2.5 of 4"
 *  means level 2 cleared and halfway through level 3. The bar is scaled to the
 *  levels the evidence actually reaches, so it never implies a ceiling the test
 *  never asked about. */
function MasteryLevel({ mastery }: { mastery: MasteryResultModel }) {
  const ceiling = mastery.scale_max || 1;
  const caveats = [
    mastery.inconsistent_evidence
      ? "A level above the first unmastered one was mastered anyway, so the level labels may need revisiting."
      : null,
    mastery.has_level_gaps
      ? "This test skips a level, so the ladder is standing on incomplete evidence -- Difficulty Weighted may suit it better."
      : null,
    mastery.components_unavailable
      ? "Rubric Levels was asked for, but nothing on this test carried component levels, so whole questions were laddered instead."
      : null,
  ].filter(Boolean);

  return (
    <div
      className="performance-bar"
      title={
        caveats.length > 0
          ? caveats.join(" ")
          : `${CALCULATION_LABEL[mastery.calculation]}, exact ${mastery.level_exact.toFixed(2)}`
      }
    >
      <div className="performance-bar-track">
        <div
          className="performance-bar-fill mastery"
          style={{ width: `${Math.min(100, Math.max(0, (mastery.level / ceiling) * 100))}%` }}
        />
      </div>
      <span className="performance-bar-value">
        {mastery.level.toFixed(mastery.reporting === "half_steps" ? 1 : 2)}
        <span className="mastery-scale"> / {ceiling}</span>
        {caveats.length > 0 ? <span className="mastery-caveat"> !</span> : null}
      </span>
    </div>
  );
}

function StandardsTable({ performance }: { performance: StudentPerformanceModel }) {
  if (performance.by_standard.length === 0) return null;

  return (
    <table className="scan-review-table">
      <thead>
        <tr>
          <th>Standard</th>
          <th>Items</th>
          <th title="Points earned over points possible on this standard.">Score</th>
          <th title="How far up the mastery ladder the evidence reaches. A level, not a percentage: a question's difficulty is the level it gives evidence about.">
            Mastery
          </th>
        </tr>
      </thead>
      <tbody>
        {performance.by_standard.map((entry) => (
          <tr key={entry.standard_id}>
            <td>{entry.standard_id}</td>
            <td>
              {entry.items_full_credit} / {entry.items_attempted}
            </td>
            <td>
              <PercentBar value={entry.percent_earned} />
            </td>
            <td>
              <MasteryLevel mastery={entry.mastery} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The roster is where a teacher goes to ask "how is this student doing", so it
 *  leads with the student's record across every test in the gradebook and keeps
 *  the contact fields behind an expander. Nothing here is stored: the scores are
 *  recomputed from the scanned sheets on every load, so a scan-review
 *  correction shows up the next time this page is opened. */
export default function RosterWorkspace({ onChanged, onSaved }: RosterWorkspaceProps = {}) {
  const [students, setStudents] = useState<StudentModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  const [performanceById, setPerformanceById] = useState<Record<string, StudentPerformanceModel>>({});
  const [unlinkedSheetCount, setUnlinkedSheetCount] = useState(0);
  const [performanceLoading, setPerformanceLoading] = useState(false);
  const [resolution, setResolution] = useState<RetakeResolution>("most_recent");
  const [sectionFilter, setSectionFilter] = useState("");

  const [creating, setCreating] = useState(false);
  // An existing student's fields are read-only until Edit is clicked -- most
  // roster visits are to look someone up, not to change their name.
  const [editing, setEditing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [externalId, setExternalId] = useState("");
  const [section, setSection] = useState("");
  const [grouping, setGrouping] = useState("");

  async function refreshStudents(): Promise<StudentModel[]> {
    setLoading(true);
    try {
      const response = await listStudents();
      setStudents(response.items);
      setErrorMessage("");
      return response.items;
    } catch (error) {
      setErrorMessage((error as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }

  const refreshPerformance = useCallback(async () => {
    setPerformanceLoading(true);
    try {
      const response = await getStudentPerformance(resolution);
      setPerformanceById(
        Object.fromEntries(response.items.map((item) => [item.student.id, item])),
      );
      setUnlinkedSheetCount(response.unlinked_sheet_count);
    } catch (error) {
      // A roster with no scans yet is the normal early state, not an error
      // worth pushing in front of someone adding their first students.
      setPerformanceById({});
      setUnlinkedSheetCount(0);
      if ((error as Error).message) setErrorMessage((error as Error).message);
    } finally {
      setPerformanceLoading(false);
    }
  }, [resolution]);

  useEffect(() => {
    void refreshStudents().then((items) => {
      if (items.length > 0) setSelectedId(items[0].id);
    });
  }, []);

  useEffect(() => {
    void refreshPerformance();
  }, [refreshPerformance]);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 3200);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  const sections = useMemo(
    () => Array.from(new Set(students.map((student) => student.section).filter(Boolean))).sort(),
    [students],
  );

  const visibleStudents = useMemo(
    () =>
      sectionFilter
        ? students.filter((student) => student.section === sectionFilter)
        : students,
    [students, sectionFilter],
  );

  const selected = students.find((student) => student.id === selectedId) ?? null;
  const selectedPerformance = selected ? performanceById[selected.id] : undefined;

  useEffect(() => {
    if (creating) return;
    setFirstName(selected?.first_name ?? "");
    setLastName(selected?.last_name ?? "");
    setExternalId(selected?.external_id ?? "");
    setSection(selected?.section ?? "");
    setGrouping(selected?.grouping ?? "");
  }, [selected, creating]);

  function startCreate() {
    setCreating(true);
    setEditing(false);
    setDetailsOpen(true);
    setSelectedId(null);
    setFirstName("");
    setLastName("");
    setExternalId("");
    setSection("");
    setGrouping("");
  }

  function startEdit() {
    if (!selected) return;
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setCreating(false);
    setFirstName(selected?.first_name ?? "");
    setLastName(selected?.last_name ?? "");
    setExternalId(selected?.external_id ?? "");
    setSection(selected?.section ?? "");
    setGrouping(selected?.grouping ?? "");
  }

  async function runMutation(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!firstName.trim() || !lastName.trim()) return;
    await runMutation(async () => {
      if (creating) {
        const created = await createStudent({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          externalId: externalId.trim() || null,
          section: section.trim() || null,
          grouping: grouping.trim() || null,
        });
        await refreshStudents();
        setCreating(false);
        setSelectedId(created.id);
        // Roster edits are the one thing a teacher types in by hand and would
        // hate to retype, so they go straight into the .nxgb rather than
        // waiting for an explicit Save.
        await saveGradebook();
        onSaved?.();
        setStatusMessage("Student added and saved.");
      } else if (selected) {
        await updateStudent(selected.id, {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          externalId: externalId.trim() || null,
          section: section.trim() || null,
          grouping: grouping.trim() || null,
        });
        await refreshStudents();
        await saveGradebook();
        onSaved?.();
        setEditing(false);
        setStatusMessage("Saved.");
      }
      await refreshPerformance();
    });
  }

  async function handleDelete() {
    if (!selected) return;
    const scored = performanceById[selected.id];
    const warning = scored && scored.attempt_count > 0
      ? `${fullName(selected)} has ${scored.attempt_count} scored sheet${
          scored.attempt_count === 1 ? "" : "s"
        }. Removing them from the roster leaves those sheets attached to nobody. Remove anyway?`
      : `Remove ${fullName(selected)} from the roster?`;
    if (!window.confirm(warning)) return;

    await runMutation(async () => {
      await deleteStudent(selected.id);
      const remaining = await refreshStudents();
      setSelectedId(remaining[0]?.id ?? null);
      setEditing(false);
      setStatusMessage("Removed.");
      await refreshPerformance();
      // Unlike create/update, delete doesn't save on its own.
      onChanged?.();
    });
  }

  return (
    <div className="roster-workspace">
      <header className="standards-panel-header">
        <div>
          <h2>Students</h2>
          <p>
            Every test a student has taken in this gradebook, scored from the sheets themselves.
            Students live only here, never in a shared bank.
          </p>
        </div>
        <div className="standards-header-actions">
          {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
          <label className="inline-select" title={RESOLUTION_HELP[resolution]}>
            Retakes count as
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
          <button type="button" onClick={startCreate} disabled={busy}>
            + Add Student
          </button>
        </div>
      </header>

      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

      {unlinkedSheetCount > 0 ? (
        <p className="gradebook-notice">
          {unlinkedSheetCount} scored sheet{unlinkedSheetCount === 1 ? " is" : "s are"} not matched
          to anyone on this roster, so {unlinkedSheetCount === 1 ? "it counts" : "they count"}{" "}
          toward nobody's totals. Match {unlinkedSheetCount === 1 ? "it" : "them"} to a student in
          Scan &amp; Review.
        </p>
      ) : null}

      <div className="courses-layout">
        <aside className="standards-panel courses-list-panel">
          {sections.length > 0 ? (
            <label className="inline-select roster-section-filter">
              Section
              <select
                value={sectionFilter}
                onChange={(event) => setSectionFilter(event.target.value)}
              >
                <option value="">All sections</option>
                {sections.map((item) => (
                  <option key={item} value={item ?? ""}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {loading ? <p>Loading...</p> : null}
          {!loading && visibleStudents.length === 0 ? <p>No students yet.</p> : null}
          <div className="standards-record-list compact">
            {visibleStudents.map((student) => {
              const performance = performanceById[student.id];
              return (
                <button
                  key={student.id}
                  type="button"
                  className={`standards-list-row roster-list-row ${
                    selectedId === student.id && !creating ? "selected" : ""
                  }`}
                  onClick={() => {
                    setCreating(false);
                    setEditing(false);
                    setSelectedId(student.id);
                  }}
                >
                  <strong>{fullName(student)}</strong>
                  <span className="roster-list-score">
                    {performance && performance.tests_taken > 0
                      ? `${performance.tests_taken} test${
                          performance.tests_taken === 1 ? "" : "s"
                        } - ${percent(performance.percent_correct)}`
                      : "No scores yet"}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="standards-panel courses-detail-panel">
          {creating || editing ? (
            <div className="courses-detail-form">
              <label>
                First name
                <input
                  type="text"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                />
              </label>
              <label>
                Last name
                <input
                  type="text"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                />
              </label>
              <label title="Class or period. Response sheets and exports can be limited to one section at a time.">
                Section / Period
                <input
                  type="text"
                  placeholder="e.g. Period 2"
                  value={section}
                  onChange={(event) => setSection(event.target.value)}
                />
              </label>
              <label title="Any grouping you want to filter by -- intervention group, accommodation, or which modified version a student should get.">
                Group / Needs
                <input
                  type="text"
                  placeholder="e.g. EL, extended time"
                  value={grouping}
                  onChange={(event) => setGrouping(event.target.value)}
                />
              </label>
              <label>
                External ID (optional)
                <input
                  type="text"
                  value={externalId}
                  onChange={(event) => setExternalId(event.target.value)}
                />
              </label>
              <div className="standards-import-actions">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={busy || !firstName.trim() || !lastName.trim()}
                >
                  {creating ? "Add Student" : "Save"}
                </button>
                <button type="button" onClick={cancelEdit} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          ) : selected ? (
            <div className="roster-performance">
              <header className="roster-performance-header">
                <div>
                  <h3>{fullName(selected)}</h3>
                  <p>
                    {[selected.section, selected.grouping].filter(Boolean).join(" - ") ||
                      "No section set"}
                  </p>
                </div>
                <div className="standards-header-summary">
                  {selectedPerformance && selectedPerformance.tests_taken > 0 ? (
                    <>
                      <span className="status-pill saved">
                        {percent(selectedPerformance.percent_correct)} overall
                      </span>
                      <span className="status-pill">
                        {selectedPerformance.tests_taken} test
                        {selectedPerformance.tests_taken === 1 ? "" : "s"}
                      </span>
                      <span className="status-pill">
                        {selectedPerformance.points_earned.toFixed(1)} /{" "}
                        {selectedPerformance.points_possible.toFixed(1)} points
                      </span>
                    </>
                  ) : (
                    <span className="status-pill">
                      {performanceLoading ? "Loading scores..." : "No scored sheets yet"}
                    </span>
                  )}
                </div>
              </header>

              {selectedPerformance && selectedPerformance.unscored_manual_attempt_count > 0 ? (
                <p className="gradebook-notice">
                  {selectedPerformance.unscored_manual_attempt_count} of this student's sheets still
                  have written responses waiting to be scored, so the totals below are lower than
                  the finished score will be.
                </p>
              ) : null}

              <section className="roster-performance-section">
                <h4>Tests taken</h4>
                {selectedPerformance ? (
                  <TestsTakenTable lineages={selectedPerformance.lineages} />
                ) : (
                  <p>{performanceLoading ? "Loading..." : "No scored sheets for this student yet."}</p>
                )}
              </section>

              {selectedPerformance && selectedPerformance.by_standard.length > 0 ? (
                <section className="roster-performance-section">
                  <h4>By standard</h4>
                  <p>
                    Across every test above, with retakes counted as{" "}
                    {RESOLUTION_LABEL[resolution].toLowerCase()}. Score is how much of the work was
                    right; mastery is how far up the mastery ladder the evidence reaches, so two
                    students on the same score can sit at different levels. Hover a mastery bar for
                    the exact figure and any caveats.
                  </p>
                  <StandardsTable performance={selectedPerformance} />
                </section>
              ) : null}

              <details
                className="roster-details-expander"
                open={detailsOpen}
                onToggle={(event) => setDetailsOpen((event.target as HTMLDetailsElement).open)}
              >
                <summary>Student details</summary>
                <div className="roster-detail-readonly">
                  <div className="roster-detail-row">
                    <span className="roster-detail-label">Section / Period</span>
                    <span>{selected.section || "-"}</span>
                  </div>
                  <div className="roster-detail-row">
                    <span className="roster-detail-label">Group / Needs</span>
                    <span>{selected.grouping || "-"}</span>
                  </div>
                  <div className="roster-detail-row">
                    <span className="roster-detail-label">External ID</span>
                    <span>{selected.external_id || "-"}</span>
                  </div>
                  <div className="standards-import-actions">
                    <button type="button" onClick={startEdit} disabled={busy}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={() => void handleDelete()}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </details>
            </div>
          ) : (
            <p>Select a student, or add one.</p>
          )}
        </section>
      </div>
    </div>
  );
}
