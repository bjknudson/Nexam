import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  createStandardsManually,
  importStandards,
  inspectStandardImport,
  listSourceStandardLists,
  listStandards,
  updateStandard,
} from "./api";
import type {
  SourceStandardListModel,
  StandardImportInspectionModel,
  StandardRecordModel,
} from "./types";

const PANE_SYNC_CHANNEL = "nexzam-pane-sync";
const NEW_SOURCE_OPTION = "__new__";

type StandardsWorkspaceMode = "workspace" | "picker";
type StandardSortMode = "source" | "code" | "strand" | "id";

interface QuestionStandardsSnapshot {
  questionId: string | null;
  attachedStandardIds: string[];
}

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface StandardsWorkspaceProps {
  showCloseHint?: boolean;
}

interface StandardEditDraft {
  id: string;
  source_list_id: string;
  code: string;
  statement: string;
  subject: string;
  strand: string;
  grade_band: string;
  tagsText: string;
}

/**
 * A standard being typed in by hand, including the source it belongs to.
 *
 * Every standard has a source, so each row either points at a source already in
 * the library or carries the details of a new one.
 */
interface ManualStandardRow {
  key: string;
  sourceListId: string;
  sourceTitle: string;
  sourceIssuer: string;
  sourceSubject: string;
  sourceVersion: string;
  sourceDescription: string;
  id: string;
  code: string;
  statement: string;
  subject: string;
  strand: string;
  grade_band: string;
  tagsText: string;
}

let manualRowSerial = 0;

function buildManualStandardRow(sourceListId = ""): ManualStandardRow {
  manualRowSerial += 1;
  return {
    key: `manual-row-${manualRowSerial}`,
    sourceListId,
    sourceTitle: "",
    sourceIssuer: "",
    sourceSubject: "",
    sourceVersion: "",
    sourceDescription: "",
    id: "",
    code: "",
    statement: "",
    subject: "",
    strand: "",
    grade_band: "",
    tagsText: "",
  };
}

function isManualRowEmpty(row: ManualStandardRow): boolean {
  return !(
    row.id.trim() ||
    row.code.trim() ||
    row.statement.trim() ||
    row.subject.trim() ||
    row.strand.trim() ||
    row.grade_band.trim() ||
    row.tagsText.trim()
  );
}

/**
 * One standard as a table row. Columns line up with the manual-entry form so a
 * standard reads the same whether you are typing it or browsing it.
 */
function StandardTableRow({
  standard,
  sourceLabel,
  children,
}: {
  standard: StandardRecordModel;
  sourceLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="standards-table-row">
      <span className="standards-cell-id" title={standard.id}>
        {standard.id}
      </span>
      <span className="standards-cell-code">{standard.code}</span>
      <span className="standards-cell-statement">{standard.statement}</span>
      <span className="standards-cell-source" title={sourceLabel}>
        {sourceLabel}
      </span>
      <span className="standards-cell-strand">{standard.strand ?? "-"}</span>
      <span className="standards-cell-subject">{standard.subject ?? "-"}</span>
      <span className="standards-cell-grade">{standard.grade_band ?? "-"}</span>
      <span className="standards-cell-tags">
        {standard.tags.length > 0 ? (
          standard.tags.map((tag) => (
            <span key={tag} className="asset-badge">
              {tag}
            </span>
          ))
        ) : (
          <span className="standards-cell-muted">-</span>
        )}
      </span>
      <span className="standards-cell-actions">{children}</span>
    </div>
  );
}

function StandardTableHead() {
  return (
    <div className="standards-table-row standards-table-head">
      <span>Standard ID</span>
      <span>Short Name</span>
      <span>Standard Text</span>
      <span>Source</span>
      <span>Strand</span>
      <span>Subject</span>
      <span>Grade Band</span>
      <span>Topic Tags</span>
      <span />
    </div>
  );
}

function buildStandardEditDraft(standard: StandardRecordModel): StandardEditDraft {
  return {
    id: standard.id,
    source_list_id: standard.source_list_id,
    code: standard.code,
    statement: standard.statement,
    subject: standard.subject ?? "",
    strand: standard.strand ?? "",
    grade_band: standard.grade_band ?? "",
    tagsText: standard.tags.join(", "),
  };
}

function parseTags(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

function replaceId(items: string[], oldId: string, newId: string): string[] {
  return Array.from(new Set(items.map((item) => (item === oldId ? newId : item))));
}

export default function StandardsWorkspace({
  showCloseHint = false,
}: StandardsWorkspaceProps) {
  const mode =
    (new URLSearchParams(window.location.search).get("mode") as StandardsWorkspaceMode | null) ??
    "workspace";
  const pickerMode = mode === "picker";
  const [sourceLists, setSourceLists] = useState<SourceStandardListModel[]>([]);
  const [standards, setStandards] = useState<StandardRecordModel[]>([]);
  const [selectedSourceListId, setSelectedSourceListId] = useState("");
  const [selectedStrand, setSelectedStrand] = useState("");
  const [sortMode, setSortMode] = useState<StandardSortMode>("source");
  const [search, setSearch] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importInspection, setImportInspection] =
    useState<StandardImportInspectionModel | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [importSourceListId, setImportSourceListId] = useState("");
  const [importTitle, setImportTitle] = useState("");
  const [importIssuer, setImportIssuer] = useState("");
  const [importSubject, setImportSubject] = useState("");
  const [importVersion, setImportVersion] = useState("");
  const [importDescription, setImportDescription] = useState("");
  const [manualRows, setManualRows] = useState<ManualStandardRow[]>([buildManualStandardRow()]);
  const [editingStandardId, setEditingStandardId] = useState<string | null>(null);
  const [standardEditDraft, setStandardEditDraft] = useState<StandardEditDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [showManualPanel, setShowManualPanel] = useState(false);
  const [questionStandardsState, setQuestionStandardsState] = useState<QuestionStandardsSnapshot>({
    questionId: null,
    attachedStandardIds: [],
  });

  const channelRef = useRef<BroadcastChannel | null>(null);

  async function refreshData() {
    setLoading(true);
    try {
      const [sourceListResponse, standardsResponse] = await Promise.all([
        listSourceStandardLists(),
        listStandards(),
      ]);
      setSourceLists(sourceListResponse.items);
      setStandards(standardsResponse.items);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshData();
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    if (!channelRef.current) {
      channelRef.current = new BroadcastChannel(PANE_SYNC_CHANNEL);
    }

    const channel = channelRef.current;
    channel.onmessage = (
      event: MessageEvent<
        | { type?: string }
        | { type: "question-standards-state"; state: QuestionStandardsSnapshot }
      >,
    ) => {
      if (event.data?.type === "standards-data-changed") {
        void refreshData();
        return;
      }

      if (event.data?.type === "question-standards-state" && "state" in event.data) {
        setQuestionStandardsState(event.data.state);
      }
    };

    return () => {
      channel.onmessage = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!pickerMode) return;
    channelRef.current?.postMessage({ type: "request-question-standards-state" });
  }, [pickerMode]);

  useEffect(() => {
    if (!importTitle.trim()) return;
    if (importSourceListId.trim()) return;
    setImportSourceListId(normalizeId(importTitle));
  }, [importTitle, importSourceListId]);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 3200);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  const selectedQuestionStandardIds = new Set(questionStandardsState.attachedStandardIds);
  const standardsById = useMemo(
    () => Object.fromEntries(standards.map((standard) => [standard.id, standard])),
    [standards],
  );
  const sourceTitleById = useMemo(
    () => Object.fromEntries(sourceLists.map((sourceList) => [sourceList.id, sourceList.title])),
    [sourceLists],
  );

  function sourceLabel(standard: StandardRecordModel): string {
    return sourceTitleById[standard.source_list_id] ?? standard.source_list_id;
  }

  const availableStrands = useMemo(() => {
    const found = new Set<string>();
    for (const standard of standards) {
      const strand = (standard.strand ?? "").trim();
      if (strand) found.add(strand);
    }
    return Array.from(found).sort((left, right) => left.localeCompare(right));
  }, [standards]);

  /** The library, narrowed by the current filters and ordered by the sort mode. */
  const visibleStandards = useMemo(() => {
    const labelOf = (standard: StandardRecordModel) =>
      sourceTitleById[standard.source_list_id] ?? standard.source_list_id;
    const needle = search.trim().toLowerCase();
    const filtered = standards.filter((standard) => {
      if (selectedSourceListId && standard.source_list_id !== selectedSourceListId) return false;
      if (selectedStrand && (standard.strand ?? "").trim() !== selectedStrand) return false;
      if (!needle) return true;
      const haystack = [
        standard.id,
        standard.code,
        standard.statement,
        standard.subject ?? "",
        standard.strand ?? "",
        standard.grade_band ?? "",
        standard.tags.join(" "),
        labelOf(standard),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });

    const byText = (left: string, right: string) => left.localeCompare(right);
    return [...filtered].sort((left, right) => {
      if (sortMode === "code") return byText(left.code, right.code) || byText(left.id, right.id);
      if (sortMode === "id") return byText(left.id, right.id);
      if (sortMode === "strand") {
        // Standards without a strand sort last rather than first.
        return byText(left.strand ?? "~", right.strand ?? "~") || byText(left.code, right.code);
      }
      return (
        byText(labelOf(left), labelOf(right)) ||
        byText(left.strand ?? "", right.strand ?? "") ||
        byText(left.code, right.code)
      );
    });
  }, [search, selectedSourceListId, selectedStrand, sortMode, sourceTitleById, standards]);

  function resetImportForm() {
    setImportFile(null);
    setImportInspection(null);
    setImportSourceListId("");
    setImportTitle("");
    setImportIssuer("");
    setImportSubject("");
    setImportVersion("");
    setImportDescription("");
  }

  /**
   * Read the chosen file's own source information before asking for any.
   *
   * A file that names a source for every standard needs nothing more from the
   * teacher; only the gaps get a form.
   */
  async function handleChooseImportFile(file: File | null) {
    setImportFile(file);
    setImportInspection(null);
    setErrorMessage("");
    if (!file) return;

    setInspecting(true);
    try {
      const inspection = await inspectStandardImport(file);
      setImportInspection(inspection);

      const detectedFallback = inspection.detected_sources.find(
        (source) => !source.matches_existing_source,
      );
      if (inspection.needs_source_input && detectedFallback) {
        // The file gestured at a source but left something out; prefill what it
        // did say so the teacher only fills the gaps.
        setImportSourceListId(detectedFallback.id ?? "");
        setImportTitle(detectedFallback.title ?? "");
        setImportIssuer(detectedFallback.issuer ?? "");
        setImportSubject(detectedFallback.subject ?? "");
        setImportVersion(detectedFallback.version ?? "");
        setImportDescription(detectedFallback.description ?? "");
      }
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setInspecting(false);
    }
  }

  async function handleImportStandards() {
    if (!importFile) {
      setErrorMessage("Choose a JSON or CSV file to import.");
      return;
    }

    setBusy(true);
    try {
      const response = await importStandards({
        file: importFile,
        source_list_id: importSourceListId || undefined,
        title: importTitle || undefined,
        issuer: importIssuer || undefined,
        subject: importSubject || undefined,
        version: importVersion || undefined,
        description: importDescription || undefined,
      });
      const sourceNames = response.source_lists.map((item) => item.title).join(", ");
      setStatusMessage(
        `Imported ${response.imported_count} standards into ${sourceNames || response.source_list.title}.`,
      );
      setSelectedSourceListId(
        response.source_lists.length === 1 ? response.source_list.id : "",
      );
      resetImportForm();
      setShowImportPanel(false);
      channelRef.current?.postMessage({ type: "standards-data-changed" });
      await refreshData();
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function updateManualRow<K extends keyof ManualStandardRow>(
    key: string,
    field: K,
    value: ManualStandardRow[K],
  ) {
    setManualRows((rows) =>
      rows.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    );
  }

  function handleAddManualRow() {
    setManualRows((rows) => {
      // Most standards typed in one sitting share a source, so carry the last
      // row's choice forward. A half-typed new source is not carried, since the
      // new row would inherit the dropdown without any of the details behind it.
      const previous = rows[rows.length - 1]?.sourceListId ?? "";
      return [...rows, buildManualStandardRow(previous === NEW_SOURCE_OPTION ? "" : previous)];
    });
  }

  function handleRemoveManualRow(key: string) {
    setManualRows((rows) => {
      const remaining = rows.filter((row) => row.key !== key);
      return remaining.length > 0 ? remaining : [buildManualStandardRow()];
    });
  }

  function resetManualStandards() {
    setManualRows([buildManualStandardRow()]);
  }

  function handleCancelManualStandards() {
    resetManualStandards();
    setShowManualPanel(false);
    setErrorMessage("");
  }

  function handleOpenManualPanel() {
    setShowImportPanel(false);
    setShowManualPanel((current) => {
      if (current) {
        resetManualStandards();
        return false;
      }
      return true;
    });
    setErrorMessage("");
  }

  async function handleSaveManualStandards() {
    const filledRows = manualRows.filter((row) => !isManualRowEmpty(row));
    if (filledRows.length === 0) {
      setErrorMessage("Fill in at least one standard row before saving.");
      return;
    }

    const incomplete = filledRows.find((row) => !row.id.trim() || !row.statement.trim());
    if (incomplete) {
      setErrorMessage("Every standard row needs a standard id and standard text.");
      return;
    }

    const missingSource = filledRows.find((row) => !row.sourceListId);
    if (missingSource) {
      setErrorMessage("Every standard needs a source. Pick one or add a new source.");
      return;
    }

    const incompleteSource = filledRows.find(
      (row) =>
        row.sourceListId === NEW_SOURCE_OPTION &&
        !(row.sourceTitle.trim() && row.sourceIssuer.trim()),
    );
    if (incompleteSource) {
      setErrorMessage("A new source needs a title and an issuer.");
      return;
    }

    setBusy(true);
    try {
      const response = await createStandardsManually({
        standards: filledRows.map((row) => {
          const creatingSource = row.sourceListId === NEW_SOURCE_OPTION;
          return {
            id: row.id.trim(),
            code: row.code.trim() || undefined,
            statement: row.statement.trim(),
            subject: row.subject.trim() || undefined,
            strand: row.strand.trim() || undefined,
            grade_band: row.grade_band.trim() || undefined,
            tags: parseTags(row.tagsText),
            source_list_id: creatingSource
              ? normalizeId(row.sourceTitle)
              : row.sourceListId,
            source_title: creatingSource ? row.sourceTitle.trim() : undefined,
            source_issuer: creatingSource ? row.sourceIssuer.trim() : undefined,
            source_subject: creatingSource ? row.sourceSubject.trim() || undefined : undefined,
            source_version: creatingSource ? row.sourceVersion.trim() || undefined : undefined,
            source_description: creatingSource
              ? row.sourceDescription.trim() || undefined
              : undefined,
          };
        }),
      });

      const sourceNames = response.source_lists.map((item) => item.title).join(", ");
      setStatusMessage(
        `Added ${response.imported_count} standards to ${sourceNames || response.source_list.title}.`,
      );
      setErrorMessage("");
      resetManualStandards();
      setShowManualPanel(false);
      channelRef.current?.postMessage({ type: "standards-data-changed" });
      await refreshData();
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleQuestionStandardToggle(standardId: string) {
    if (!questionStandardsState.questionId) {
      setErrorMessage("Select a question in the main window before attaching standards.");
      return;
    }

    channelRef.current?.postMessage(
      selectedQuestionStandardIds.has(standardId)
        ? { type: "question-remove-standard", standardId }
        : { type: "question-attach-standard", standardId },
    );
  }

  function handleStartStandardEdit(standard: StandardRecordModel) {
    setEditingStandardId(standard.id);
    setStandardEditDraft(buildStandardEditDraft(standard));
    setErrorMessage("");
    setStatusMessage("");
  }

  function handleCancelStandardEdit() {
    setEditingStandardId(null);
    setStandardEditDraft(null);
  }

  function updateStandardEditDraft<K extends keyof StandardEditDraft>(
    field: K,
    value: StandardEditDraft[K],
  ) {
    setStandardEditDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  async function handleSaveStandardEdit() {
    if (!editingStandardId || !standardEditDraft) return;
    const payload: StandardRecordModel = {
      id: standardEditDraft.id.trim(),
      source_list_id: standardEditDraft.source_list_id.trim(),
      code: standardEditDraft.code.trim(),
      statement: standardEditDraft.statement.trim(),
      subject: standardEditDraft.subject.trim() || null,
      strand: standardEditDraft.strand.trim() || null,
      grade_band: standardEditDraft.grade_band.trim() || null,
      tags: parseTags(standardEditDraft.tagsText),
    };
    if (!payload.id || !payload.source_list_id || !payload.code || !payload.statement) {
      setErrorMessage("Standard id, source, short name, and text are required.");
      return;
    }

    setBusy(true);
    try {
      const saved = await updateStandard(editingStandardId, payload);
      if (saved.id !== editingStandardId) {
        setQuestionStandardsState((current) => ({
          ...current,
          attachedStandardIds: replaceId(current.attachedStandardIds, editingStandardId, saved.id),
        }));
        channelRef.current?.postMessage({
          type: "standard-id-changed",
          oldStandardId: editingStandardId,
          newStandardId: saved.id,
        });
      }
      setEditingStandardId(saved.id);
      setStandardEditDraft(buildStandardEditDraft(saved));
      setStatusMessage(`Saved ${saved.code}.`);
      setErrorMessage("");
      channelRef.current?.postMessage({ type: "standards-data-changed" });
      await refreshData();
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const importNeedsSource = importInspection?.needs_source_input ?? true;

  return (
    <div className={`standards-workspace ${pickerMode ? "picker" : ""}`}>
      <header className="standards-header">
        <div>
          <h1>{pickerMode ? "Question Standards" : "Standards Library"}</h1>
          <p>
            {pickerMode
              ? "Attach standards to the currently selected question without crowding the main editor."
              : "Every standard in this bank, grouped by the source it came from. Courses draw their standards from here."}
          </p>
          {!pickerMode ? (
            <div className="standards-header-summary">
              <span className="bank-assets-count">{standards.length} standards</span>
              <span className="bank-assets-count">
                {sourceLists.length} {sourceLists.length === 1 ? "source" : "sources"}
              </span>
            </div>
          ) : null}
        </div>
        <div className="standards-header-actions">
          <button type="button" onClick={() => void refreshData()} disabled={loading || busy}>
            Refresh
          </button>
          {!pickerMode ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setShowManualPanel(false);
                  setShowImportPanel((current) => {
                    if (current) resetImportForm();
                    return !current;
                  });
                }}
              >
                {showImportPanel ? "Close Import" : "Import Standards"}
              </button>
              <button type="button" onClick={handleOpenManualPanel}>
                {showManualPanel ? "Close Manual Entry" : "Add Manually"}
              </button>
            </>
          ) : null}
          {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
          {errorMessage ? <span className="status-pill error">{errorMessage}</span> : null}
        </div>
      </header>

      {standardEditDraft ? (
        <section className="standards-panel standards-edit-panel">
          <div className="standards-panel-header">
            <div>
              <h2>Edit Standard</h2>
              <p>Changes to a standard id are applied to saved questions and courses.</p>
            </div>
            <div className="standards-course-actions">
              <button type="button" onClick={handleCancelStandardEdit} disabled={busy}>
                Close
              </button>
              <button type="button" onClick={() => void handleSaveStandardEdit()} disabled={busy}>
                {busy ? "Saving..." : "Save Standard"}
              </button>
            </div>
          </div>
          <div className="standards-edit-grid">
            <label>
              Standard ID
              <input
                value={standardEditDraft.id}
                onChange={(event) => updateStandardEditDraft("id", event.target.value)}
                placeholder="CALC-DIFF-02"
              />
            </label>
            <label>
              Short Name
              <input
                value={standardEditDraft.code}
                onChange={(event) => updateStandardEditDraft("code", event.target.value)}
                placeholder="CALC-DIFF-02"
              />
            </label>
            <label>
              Source
              <select
                value={standardEditDraft.source_list_id}
                onChange={(event) => updateStandardEditDraft("source_list_id", event.target.value)}
              >
                {sourceLists.map((sourceList) => (
                  <option key={sourceList.id} value={sourceList.id}>
                    {sourceList.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Strand
              <input
                value={standardEditDraft.strand}
                onChange={(event) => updateStandardEditDraft("strand", event.target.value)}
                placeholder="Reading: Literature"
              />
            </label>
            <label>
              Subject
              <input
                value={standardEditDraft.subject}
                onChange={(event) => updateStandardEditDraft("subject", event.target.value)}
                placeholder="Algebra"
              />
            </label>
            <label>
              Grade Band
              <input
                value={standardEditDraft.grade_band}
                onChange={(event) => updateStandardEditDraft("grade_band", event.target.value)}
                placeholder="9-12"
              />
            </label>
            <label className="metadata-span-full">
              Topic Tags
              <input
                value={standardEditDraft.tagsText}
                onChange={(event) => updateStandardEditDraft("tagsText", event.target.value)}
                placeholder="functions, derivatives, needs-review"
              />
            </label>
            <label className="metadata-span-full">
              Standard Text
              <textarea
                className="standards-description-input"
                value={standardEditDraft.statement}
                onChange={(event) => updateStandardEditDraft("statement", event.target.value)}
                placeholder="Full standard text"
              />
            </label>
          </div>
        </section>
      ) : null}

      {!pickerMode && showImportPanel ? (
        <section className="standards-import-panel">
          <div className="standards-import-copy">
            <h2>Import Standards</h2>
            <p>
              CSV headers: <code>id</code> or <code>standard_id</code>, <code>code</code>,{" "}
              <code>statement</code>, optional <code>strand</code>, <code>subject</code>,{" "}
              <code>grade_band</code>, <code>tags</code>.
            </p>
            <p>
              To keep standards with their own sources, add a <code>source</code> (or{" "}
              <code>source_title</code>) column, optionally with <code>source_id</code> and{" "}
              <code>issuer</code>. JSON may be an array, an{" "}
              <code>{"{ items: [...] }"}</code> object, or an object with{" "}
              <code>source_list</code> and <code>standards</code>.
            </p>
            {showCloseHint ? (
              <p>Close this window when finished. The main editor can keep working separately.</p>
            ) : null}
          </div>

          <div className="standards-import-grid">
            <label className="metadata-span-full">
              Import File
              <input
                type="file"
                accept=".json,.csv,application/json,text/csv"
                onChange={(event) =>
                  void handleChooseImportFile(event.target.files?.[0] ?? null)
                }
              />
            </label>
          </div>

          {inspecting ? <p className="metadata-help-text">Reading the file...</p> : null}

          {importInspection ? (
            <div className="standards-import-detection">
              <p>
                <strong>{importInspection.total_rows}</strong> standards found.{" "}
                {importInspection.rows_with_source > 0
                  ? `${importInspection.rows_with_source} name their own source.`
                  : "None name their own source."}
              </p>
              {importInspection.detected_sources.length > 0 ? (
                <ul className="standards-detected-sources">
                  {importInspection.detected_sources.map((source, index) => (
                    <li key={source.id ?? source.title ?? index}>
                      <strong>{source.title ?? source.id ?? "Unnamed source"}</strong>
                      <span>
                        {source.standard_count}{" "}
                        {source.standard_count === 1 ? "standard" : "standards"}
                      </span>
                      {source.matches_existing_source ? (
                        <span className="asset-badge">already in library</span>
                      ) : null}
                      {!source.complete && !source.matches_existing_source ? (
                        <span className="asset-badge">needs details</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {importInspection && importNeedsSource ? (
            <>
              <p className="metadata-help-text">
                {importInspection.rows_with_source > 0
                  ? "Some standards in this file do not name a source. Describe the source that covers them."
                  : "This file does not name a source. Describe the source that applies to every standard in it."}
              </p>
              <div className="standards-import-grid">
                <label>
                  Source ID
                  <input
                    value={importSourceListId}
                    onChange={(event) => setImportSourceListId(normalizeId(event.target.value))}
                    placeholder="physics-core-2026"
                  />
                </label>
                <label>
                  Title
                  <input
                    value={importTitle}
                    onChange={(event) => setImportTitle(event.target.value)}
                    placeholder="Physics Core Standards"
                  />
                </label>
                <label>
                  Issuer
                  <input
                    value={importIssuer}
                    onChange={(event) => setImportIssuer(event.target.value)}
                    placeholder="State Curriculum Office"
                  />
                </label>
                <label>
                  Subject
                  <input
                    value={importSubject}
                    onChange={(event) => setImportSubject(event.target.value)}
                    placeholder="Physics"
                  />
                </label>
                <label>
                  Version
                  <input
                    value={importVersion}
                    onChange={(event) => setImportVersion(event.target.value)}
                    placeholder="2026.1"
                  />
                </label>
                <label className="metadata-span-full">
                  Description
                  <input
                    value={importDescription}
                    onChange={(event) => setImportDescription(event.target.value)}
                    placeholder="Complete imported standards reference set"
                  />
                </label>
              </div>
            </>
          ) : null}

          <div className="standards-import-actions">
            <button
              type="button"
              onClick={() => void handleImportStandards()}
              disabled={busy || inspecting || !importFile}
            >
              {busy ? "Importing..." : "Import Standards"}
            </button>
            {importFile ? <span>{importFile.name}</span> : null}
          </div>
        </section>
      ) : null}

      {!pickerMode && showManualPanel ? (
        <section className="standards-import-panel standards-manual-panel">
          <div className="standards-panel-header">
            <div>
              <h2>Add Standards Manually</h2>
              <p>
                Type one standard per row and pick the source it came from. Leave Short Name blank
                to reuse the standard id, and separate topic tags with commas.
              </p>
            </div>
            <div className="standards-course-actions">
              <button type="button" onClick={handleCancelManualStandards} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveManualStandards()}
                disabled={busy}
              >
                {busy ? "Saving..." : "Save Standards"}
              </button>
            </div>
          </div>

          <div className="standards-manual-scroll">
            <div className="standards-manual-rows">
              <div className="standards-manual-row standards-manual-head">
                <span>Source</span>
                <span>Standard ID</span>
                <span>Short Name</span>
                <span>Standard Text</span>
                <span>Strand</span>
                <span>Subject</span>
                <span>Grade Band</span>
                <span>Topic Tags</span>
                <span />
              </div>
              {manualRows.map((row, index) => (
                <div className="standards-manual-entry" key={row.key}>
                  <div className="standards-manual-row">
                    <select
                      value={row.sourceListId}
                      onChange={(event) =>
                        updateManualRow(row.key, "sourceListId", event.target.value)
                      }
                      aria-label={`Source for row ${index + 1}`}
                    >
                      <option value="">Select a source</option>
                      {sourceLists.map((sourceList) => (
                        <option key={sourceList.id} value={sourceList.id}>
                          {sourceList.title}
                        </option>
                      ))}
                      <option value={NEW_SOURCE_OPTION}>Add new source...</option>
                    </select>
                    <input
                      value={row.id}
                      onChange={(event) => updateManualRow(row.key, "id", event.target.value)}
                      placeholder="PHY-KIN-01"
                      aria-label={`Standard id for row ${index + 1}`}
                    />
                    <input
                      value={row.code}
                      onChange={(event) => updateManualRow(row.key, "code", event.target.value)}
                      placeholder="PHY-KIN-01"
                      aria-label={`Short name for row ${index + 1}`}
                    />
                    <textarea
                      value={row.statement}
                      onChange={(event) =>
                        updateManualRow(row.key, "statement", event.target.value)
                      }
                      placeholder="Full standard text"
                      rows={2}
                      aria-label={`Standard text for row ${index + 1}`}
                    />
                    <input
                      value={row.strand}
                      onChange={(event) => updateManualRow(row.key, "strand", event.target.value)}
                      placeholder="Mechanics"
                      aria-label={`Strand for row ${index + 1}`}
                    />
                    <input
                      value={row.subject}
                      onChange={(event) => updateManualRow(row.key, "subject", event.target.value)}
                      placeholder="Physics"
                      aria-label={`Subject for row ${index + 1}`}
                    />
                    <input
                      value={row.grade_band}
                      onChange={(event) =>
                        updateManualRow(row.key, "grade_band", event.target.value)
                      }
                      placeholder="9-12"
                      aria-label={`Grade band for row ${index + 1}`}
                    />
                    <input
                      value={row.tagsText}
                      onChange={(event) =>
                        updateManualRow(row.key, "tagsText", event.target.value)
                      }
                      placeholder="mechanics, kinematics"
                      aria-label={`Topic tags for row ${index + 1}`}
                    />
                    <button
                      type="button"
                      className="standards-manual-remove"
                      onClick={() => handleRemoveManualRow(row.key)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>

                  {row.sourceListId === NEW_SOURCE_OPTION ? (
                    <div className="standards-manual-source-expansion">
                      <div className="standards-import-grid">
                        <label>
                          Source Title
                          <input
                            value={row.sourceTitle}
                            onChange={(event) =>
                              updateManualRow(row.key, "sourceTitle", event.target.value)
                            }
                            placeholder="Physics Core Standards"
                          />
                        </label>
                        <label>
                          Issuer
                          <input
                            value={row.sourceIssuer}
                            onChange={(event) =>
                              updateManualRow(row.key, "sourceIssuer", event.target.value)
                            }
                            placeholder="State Curriculum Office"
                          />
                        </label>
                        <label>
                          Source Subject
                          <input
                            value={row.sourceSubject}
                            onChange={(event) =>
                              updateManualRow(row.key, "sourceSubject", event.target.value)
                            }
                            placeholder="Physics"
                          />
                        </label>
                        <label>
                          Version
                          <input
                            value={row.sourceVersion}
                            onChange={(event) =>
                              updateManualRow(row.key, "sourceVersion", event.target.value)
                            }
                            placeholder="2026.1"
                          />
                        </label>
                        <label className="metadata-span-full">
                          Source Description
                          <input
                            value={row.sourceDescription}
                            onChange={(event) =>
                              updateManualRow(row.key, "sourceDescription", event.target.value)
                            }
                            placeholder="Standards typed in by hand"
                          />
                        </label>
                      </div>
                      <p className="metadata-help-text">
                        Source ID{" "}
                        <strong>{normalizeId(row.sourceTitle) || "set by title"}</strong>. Later
                        rows can pick this source once it is saved.
                      </p>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="standards-import-actions">
            <button type="button" onClick={handleAddManualRow} disabled={busy}>
              Add Row
            </button>
            <span>
              {manualRows.length} {manualRows.length === 1 ? "row" : "rows"}
            </span>
          </div>
        </section>
      ) : null}

      <div className={`standards-layout ${pickerMode ? "picker" : "library"}`}>
        <section className="standards-panel standards-results-panel">
          <div className="standards-panel-header">
            <div>
              <h2>{pickerMode ? "Standards Picker" : "Library"}</h2>
              <p>
                {pickerMode
                  ? questionStandardsState.questionId
                    ? `Attaching standards for ${questionStandardsState.questionId}.`
                    : "Select a question in the main window to attach standards."
                  : "Search, filter by source or strand, and edit any standard in place."}
              </p>
            </div>
            <span className="bank-assets-count">{visibleStandards.length}</span>
          </div>

          <div className="standards-filter-row library">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search standards, strands, and sources"
            />
            <select
              value={selectedSourceListId}
              onChange={(event) => setSelectedSourceListId(event.target.value)}
              aria-label="Filter by source"
            >
              <option value="">All sources</option>
              {sourceLists.map((sourceList) => (
                <option key={sourceList.id} value={sourceList.id}>
                  {sourceList.title}
                </option>
              ))}
            </select>
            <select
              value={selectedStrand}
              onChange={(event) => setSelectedStrand(event.target.value)}
              aria-label="Filter by strand"
            >
              <option value="">All strands</option>
              {availableStrands.map((strand) => (
                <option key={strand} value={strand}>
                  {strand}
                </option>
              ))}
            </select>
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as StandardSortMode)}
              aria-label="Sort standards"
            >
              <option value="source">Sort by source</option>
              <option value="strand">Sort by strand</option>
              <option value="code">Sort by short name</option>
              <option value="id">Sort by standard id</option>
            </select>
          </div>

          <div className="standards-record-list standards-table compact">
            <StandardTableHead />
            {visibleStandards.map((standard) => (
              <StandardTableRow
                key={standard.id}
                standard={standard}
                sourceLabel={sourceLabel(standard)}
              >
                <button
                  type="button"
                  onClick={() => handleStartStandardEdit(standard)}
                  disabled={busy}
                >
                  Edit
                </button>
                {pickerMode ? (
                  <button
                    type="button"
                    onClick={() => handleQuestionStandardToggle(standard.id)}
                    disabled={!questionStandardsState.questionId}
                  >
                    {selectedQuestionStandardIds.has(standard.id) ? "Remove" : "Attach"}
                  </button>
                ) : null}
              </StandardTableRow>
            ))}
            {visibleStandards.length === 0 ? (
              <div className="standards-library-empty">
                <strong>
                  {standards.length === 0 ? "No standards yet" : "Nothing matches these filters"}
                </strong>
                <p>
                  {standards.length === 0
                    ? "Use Import Standards for a CSV or JSON file, or Add Manually to type them in. Every standard is filed under the source it came from."
                    : "Clear the search or pick a different source or strand."}
                </p>
              </div>
            ) : null}
          </div>
        </section>

        {pickerMode ? (
          <aside className="standards-sidebar-column">
            <section className="standards-panel">
              <div className="standards-panel-header">
                <h2>Attached To Question</h2>
                <span className="bank-assets-count">
                  {questionStandardsState.attachedStandardIds.length}
                </span>
              </div>
              {questionStandardsState.questionId ? (
                <div className="standards-source-list">
                  {questionStandardsState.attachedStandardIds.map((standardId) => {
                    const standard = standardsById[standardId];
                    return (
                      <div key={standardId} className="standards-curated-row">
                        <div>
                          <strong>{standard?.code ?? standardId}</strong>
                          <span>{standard?.statement ?? "Standard not found."}</span>
                        </div>
                        <div className="standards-card-actions">
                          {standard ? (
                            <button type="button" onClick={() => handleStartStandardEdit(standard)}>
                              Edit
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => handleQuestionStandardToggle(standardId)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="asset-empty">No question selected in the main window.</p>
              )}
            </section>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
