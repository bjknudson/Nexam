import { useEffect, useState } from "react";

import { closeGradebook, createGradebook, openGradebook, saveGradebook, updateGradebookDetails } from "./api";
import {
  isDesktopShell,
  openGradebookDialog,
  resolveDefaultBankDirectory,
  saveGradebookDialog,
} from "./desktop";
import type { GradebookSummaryModel } from "./types";
import RosterWorkspace from "./RosterWorkspace";
import AdministeredTestsWorkspace from "./AdministeredTestsWorkspace";
import ScanReviewWorkspace from "./ScanReviewWorkspace";
import GradeReportWorkspace from "./GradeReportWorkspace";

type GradebookPage = "roster" | "tests" | "scan" | "reports";

const GRADEBOOK_PAGES: GradebookPage[] = ["roster", "tests", "scan", "reports"];
const GRADEBOOK_PAGE_LABEL: Record<GradebookPage, string> = {
  roster: "Roster",
  tests: "Administered Tests",
  scan: "Scan & Review",
  reports: "Reports",
};

/** The gradebook is a wholly separate document from a bank -- its own file
 *  (.nxgb), its own window, its own state. It never reads bank state and a
 *  bank never reads gradebook state. See docs/grading.md. */
export default function GradebookApp() {
  const desktopMode = isDesktopShell();
  const [gradebook, setGradebook] = useState<GradebookSummaryModel | null>(null);
  const [page, setPage] = useState<GradebookPage>("roster");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  const [manualPath, setManualPath] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newDestinationPath, setNewDestinationPath] = useState("");

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 3200);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  async function handleOpenViaDialog() {
    setErrorMessage("");
    try {
      const initialDirectory = await resolveDefaultBankDirectory();
      const path = await openGradebookDialog(initialDirectory);
      if (!path) return;
      setLoading(true);
      setGradebook(await openGradebook(path));
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOpenManualPath() {
    if (!manualPath.trim()) return;
    setErrorMessage("");
    setLoading(true);
    try {
      setGradebook(await openGradebook(manualPath.trim()));
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handlePickCreateDestination() {
    setErrorMessage("");
    try {
      const initialDirectory = await resolveDefaultBankDirectory();
      const suggestedFileName = newTitle.trim()
        ? `${newTitle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}.nxgb`
        : "gradebook.nxgb";
      const path = await saveGradebookDialog(null, { suggestedFileName, initialDirectory });
      if (path) setNewDestinationPath(path);
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  async function handleCreateGradebook() {
    if (!newTitle.trim() || !newDestinationPath.trim()) return;
    setErrorMessage("");
    setLoading(true);
    try {
      const created = await createGradebook({
        title: newTitle.trim(),
        description: newDescription.trim() || null,
        destinationPath: newDestinationPath.trim(),
      });
      setGradebook(created);
      setNewTitle("");
      setNewDescription("");
      setNewDestinationPath("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setErrorMessage("");
    try {
      await saveGradebook();
      setStatusMessage("Saved.");
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  async function handleClose() {
    setErrorMessage("");
    try {
      await closeGradebook();
      setGradebook(null);
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  async function handleRenameTitle(title: string, description: string | null) {
    try {
      const updated = await updateGradebookDetails({ title, description });
      setGradebook(updated);
      setStatusMessage("Saved.");
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  if (!gradebook) {
    return (
      <div className="gradebook-app gradebook-launch">
        <header className="standards-header">
          <div>
            <h1>Nexzam Gradebook</h1>
            <p>
              A gradebook is a separate file from a bank -- it holds roster names, scans, and
              scores, which never live inside a shareable bank. See docs/grading.md.
            </p>
          </div>
        </header>

        {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

        <section className="standards-panel gradebook-launch-panel">
          <h2>Open an existing gradebook</h2>
          {desktopMode ? (
            <button type="button" onClick={() => void handleOpenViaDialog()} disabled={loading}>
              Open Gradebook...
            </button>
          ) : (
            <div className="gradebook-manual-open">
              <input
                type="text"
                placeholder="/path/to/gradebook.nxgb"
                value={manualPath}
                onChange={(event) => setManualPath(event.target.value)}
              />
              <button type="button" onClick={() => void handleOpenManualPath()} disabled={loading}>
                Open
              </button>
            </div>
          )}
        </section>

        <section className="standards-panel gradebook-launch-panel">
          <h2>Create a new gradebook</h2>
          <p>One gradebook per class section/term works best -- see docs/grading-plan.md.</p>
          <label>
            Title
            <input
              type="text"
              placeholder="Period 2 - Fall 2026"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
            />
          </label>
          <label>
            Description (optional)
            <input
              type="text"
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
            />
          </label>
          <label>
            Destination path
            <div className="gradebook-manual-open">
              <input
                type="text"
                placeholder="/path/to/gradebook.nxgb"
                value={newDestinationPath}
                onChange={(event) => setNewDestinationPath(event.target.value)}
              />
              {desktopMode ? (
                <button type="button" onClick={() => void handlePickCreateDestination()}>
                  Choose...
                </button>
              ) : null}
            </div>
          </label>
          <button
            type="button"
            onClick={() => void handleCreateGradebook()}
            disabled={loading || !newTitle.trim() || !newDestinationPath.trim()}
          >
            Create Gradebook
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="gradebook-app">
      <header className="topbar gradebook-topbar">
        <div>
          <p className="gradebook-title">{gradebook.manifest.title}</p>
          {statusMessage ? <span className="status-pill saved">{statusMessage}</span> : null}
        </div>
        <div className="topbar-controls">
          <button
            type="button"
            onClick={() => {
              const nextTitle = window.prompt("Gradebook title", gradebook.manifest.title);
              if (nextTitle && nextTitle.trim()) {
                void handleRenameTitle(nextTitle.trim(), gradebook.manifest.description ?? null);
              }
            }}
          >
            Rename
          </button>
          <button type="button" onClick={() => void handleSave()}>
            Save
          </button>
          <button type="button" onClick={() => void handleClose()}>
            Close
          </button>
        </div>
      </header>

      {errorMessage ? <p className="gradebook-error">{errorMessage}</p> : null}

      <nav className="gradebook-tabs" role="tablist">
        {GRADEBOOK_PAGES.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={page === item}
            className={page === item ? "active" : ""}
            onClick={() => setPage(item)}
          >
            {GRADEBOOK_PAGE_LABEL[item]}
          </button>
        ))}
      </nav>

      <div className="gradebook-page-body">
        {page === "roster" ? <RosterWorkspace /> : null}
        {page === "tests" ? <AdministeredTestsWorkspace /> : null}
        {page === "scan" ? <ScanReviewWorkspace /> : null}
        {page === "reports" ? <GradeReportWorkspace /> : null}
      </div>
    </div>
  );
}
