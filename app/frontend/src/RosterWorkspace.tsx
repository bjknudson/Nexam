import { useEffect, useState } from "react";

import { createStudent, deleteStudent, listStudents, saveGradebook, updateStudent } from "./api";
import type { StudentModel } from "./types";

export default function RosterWorkspace() {
  const [students, setStudents] = useState<StudentModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  const [creating, setCreating] = useState(false);
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

  useEffect(() => {
    void refreshStudents().then((items) => {
      if (items.length > 0) setSelectedId(items[0].id);
    });
  }, []);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 3200);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  const selected = students.find((student) => student.id === selectedId) ?? null;

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
    setSelectedId(null);
    setFirstName("");
    setLastName("");
    setExternalId("");
    setSection("");
    setGrouping("");
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
        setStatusMessage("Saved.");
      }
    });
  }

  async function handleDelete() {
    if (!selected) return;
    if (!window.confirm(`Remove ${selected.first_name} ${selected.last_name} from the roster?`)) return;
    await runMutation(async () => {
      await deleteStudent(selected.id);
      const remaining = await refreshStudents();
      setSelectedId(remaining[0]?.id ?? null);
      setStatusMessage("Removed.");
    });
  }

  return (
    <div className="roster-workspace">
      <header className="standards-panel-header">
        <div>
          <h2>Roster</h2>
          <p>Students live only in this gradebook, never in a shared bank.</p>
        </div>
        <div className="standards-header-actions">
          {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
          <button type="button" onClick={startCreate} disabled={busy}>
            + Add Student
          </button>
        </div>
      </header>

      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

      <div className="courses-layout">
        <aside className="standards-panel courses-list-panel">
          {loading ? <p>Loading...</p> : null}
          {!loading && students.length === 0 ? <p>No students yet.</p> : null}
          <div className="standards-record-list compact">
            {students.map((student) => (
              <button
                key={student.id}
                type="button"
                className={`standards-list-row ${selectedId === student.id && !creating ? "selected" : ""}`}
                onClick={() => {
                  setCreating(false);
                  setSelectedId(student.id);
                }}
              >
                <strong>
                  {student.first_name} {student.last_name}
                </strong>
                {student.section || student.grouping ? (
                  <span>{[student.section, student.grouping].filter(Boolean).join(" - ")}</span>
                ) : student.external_id ? (
                  <span>{student.external_id}</span>
                ) : null}
              </button>
            ))}
          </div>
        </aside>

        <section className="standards-panel courses-detail-panel">
          {creating || selected ? (
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
              <label title="Class or period. Response sheets can be generated for one section at a time.">
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
                {!creating && selected ? (
                  <button type="button" className="danger-button" onClick={() => void handleDelete()} disabled={busy}>
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <p>Select a student, or add one.</p>
          )}
        </section>
      </div>
    </div>
  );
}
